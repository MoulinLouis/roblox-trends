import { EXTERNAL_REQUEST_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const nextRequestAtByHost = new Map<string, number>();
const blockedUntilByHost = new Map<string, number>();
const requestMetrics = {
  attempts: 0,
  retries: 0,
  rateLimitedResponses: 0,
};

export interface HttpRequestMetrics {
  attempts: number;
  retries: number;
  rateLimitedResponses: number;
}

interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  minimumIntervalMs?: number;
  headers?: HeadersInit;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, url: string) {
    super(`${status} ${statusText} for ${new URL(url).hostname}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname;
  const timeoutMs = options.timeoutMs ?? EXTERNAL_REQUEST_CONFIG.defaultTimeoutMs;
  const retries = options.retries ?? EXTERNAL_REQUEST_CONFIG.defaultRetries;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const minimumIntervalMs = options.minimumIntervalMs ?? minimumIntervalForHost(host);
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await waitForRequestWindow(host, minimumIntervalMs);
    requestMetrics.attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "RobloxTrendRadar/1.0", ...options.headers },
      });
      applyRateLimitHeaders(host, response.headers);
      if (!response.ok) {
        const error = new HttpError(response.status, response.statusText, url);
        if (response.status === 429) requestMetrics.rateLimitedResponses += 1;
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
        if (attempt < retries) {
          requestMetrics.retries += 1;
          const retryDelayMs = retryDelay(response, attempt);
          blockHost(host, retryDelayMs);
          logger.warn("External service throttled or unavailable; retrying", {
            host,
            status: response.status,
            attempt: attempt + 1,
            retryDelayMs,
          });
        }
        continue;
      }
      const value = (await response.json()) as T;
      responseCache.set(url, { expiresAt: Date.now() + cacheTtlMs, value });
      return value;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      if (attempt < retries) {
        requestMetrics.retries += 1;
        const retryDelayMs = cappedDelay(
          EXTERNAL_REQUEST_CONFIG.serverErrorBaseDelayMs * 2 ** attempt + retryJitter(),
        );
        blockHost(host, retryDelayMs);
        logger.warn("External request failed; retrying", {
          host,
          attempt: attempt + 1,
          retryDelayMs,
          error: errorMessage(error),
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("External request failed");
}

export function parseRateLimitDelayMs(headers: Pick<Headers, "get">, now = Date.now()): number {
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const retryAfterDate = retryAfter && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfter) : Number.NaN;
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Math.max(
    Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : 0,
    Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate - now) : 0,
    Number.isFinite(resetSeconds) ? Math.max(0, resetSeconds * 1000) : 0,
  );
}

function minimumIntervalForHost(host: string): number {
  const intervals: Record<string, number> = EXTERNAL_REQUEST_CONFIG.minimumIntervalByHost;
  return intervals[host] ?? 0;
}

async function waitForRequestWindow(host: string, minimumIntervalMs: number): Promise<void> {
  while (true) {
    const now = Date.now();
    const nextRequestAt = Math.max(nextRequestAtByHost.get(host) ?? 0, blockedUntilByHost.get(host) ?? 0);
    if (nextRequestAt > now) {
      await delay(nextRequestAt - now);
      continue;
    }
    nextRequestAtByHost.set(host, now + minimumIntervalMs);
    return;
  }
}

function applyRateLimitHeaders(host: string, headers: Pick<Headers, "get">): void {
  const remainingHeader = headers.get("x-ratelimit-remaining");
  if (remainingHeader === null) return;
  const remaining = Number(remainingHeader);
  if (!Number.isFinite(remaining) || remaining > 0) return;
  const resetDelayMs = parseRateLimitDelayMs(headers);
  if (resetDelayMs > 0) blockHost(host, resetDelayMs);
}

function retryDelay(response: Pick<Response, "headers" | "status">, attempt: number): number {
  const headerDelayMs = parseRateLimitDelayMs(response.headers);
  const fallbackDelayMs = response.status === 429
    ? EXTERNAL_REQUEST_CONFIG.rateLimitBaseDelayMs * 2 ** attempt
    : EXTERNAL_REQUEST_CONFIG.serverErrorBaseDelayMs * 2 ** attempt;
  return cappedDelay(Math.max(headerDelayMs, fallbackDelayMs) + retryJitter());
}

function blockHost(host: string, milliseconds: number): void {
  blockedUntilByHost.set(host, Math.max(blockedUntilByHost.get(host) ?? 0, Date.now() + cappedDelay(milliseconds)));
}

function retryJitter(): number {
  return Math.floor(Math.random() * EXTERNAL_REQUEST_CONFIG.retryJitterMs);
}

function cappedDelay(milliseconds: number): number {
  return Math.min(milliseconds, EXTERNAL_REQUEST_CONFIG.maximumRetryDelayMs);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, cappedDelay(milliseconds)));
}

export function clearResponseCache(): void {
  responseCache.clear();
  nextRequestAtByHost.clear();
  blockedUntilByHost.clear();
  requestMetrics.attempts = 0;
  requestMetrics.retries = 0;
  requestMetrics.rateLimitedResponses = 0;
}

export function getHttpRequestMetrics(): HttpRequestMetrics {
  return { ...requestMetrics };
}
