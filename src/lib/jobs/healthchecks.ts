import { errorMessage, logger } from "@/lib/logger";
import type { JobName } from "./types";

export type PingKind = "start" | "success" | "fail";

// The heartbeat check answers "did the job run"; it also receives degraded runs.
export function jobSlug(name: JobName): string {
  return `radar-${name}`;
}

// The quality check only receives fully successful runs, so a sustained degradation outlasts its period.
export function qualitySlug(name: JobName): string {
  return `radar-${name}-quality`;
}

export function buildPingUrl(base: string, slug: string, kind: PingKind, runId: string): string {
  const suffix = kind === "success" ? "" : `/${kind}`;
  const url = new URL(`${base.replace(/\/+$/, "")}/${slug}${suffix}`);
  url.searchParams.set("create", "1");
  url.searchParams.set("rid", runId);
  return url.toString();
}

// The single reading of the setting, so the job script's check and the pings cannot disagree.
export function healthchecksPingBase(): string | undefined {
  return process.env.HEALTHCHECKS_PING_BASE?.trim() || undefined;
}

// Pings are best effort: a monitoring outage must never fail a collection.
export async function sendPing(slug: string, kind: PingKind, runId: string, body?: string): Promise<void> {
  const base = healthchecksPingBase();
  if (!base) return;
  try {
    const response = await fetch(buildPingUrl(base, slug, kind, runId), {
      method: "POST",
      body: body?.slice(0, 10_000),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) logger.warn("Healthchecks ping rejected", { slug, kind, status: response.status });
  } catch (error) {
    logger.warn("Healthchecks ping failed", { slug, kind, error: errorMessage(error) });
  }
}
