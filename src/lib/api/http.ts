import { errorMessage, logger } from "@/lib/logger";

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();

interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  headers?: HeadersInit;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "RobloxTrendRadar/1.0", ...options.headers },
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        const rateLimitReset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
        const error = new Error(`${response.status} ${response.statusText} for ${new URL(url).hostname}`);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
        if (attempt < retries) {
          const fallbackDelay = response.status === 429 ? 5_000 * 2 ** attempt : 500 * 2 ** attempt;
          await delay(Math.max(retryAfter * 1000, rateLimitReset * 1000, fallbackDelay));
        }
        continue;
      }
      const value = (await response.json()) as T;
      responseCache.set(url, { expiresAt: Date.now() + cacheTtlMs, value });
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger.warn("External request failed; retrying", {
          host: new URL(url).hostname,
          attempt: attempt + 1,
          error: errorMessage(error),
        });
        await delay(500 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("External request failed");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 60_000)));
}

export function clearResponseCache(): void {
  responseCache.clear();
}
