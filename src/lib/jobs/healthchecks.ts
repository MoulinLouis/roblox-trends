import { errorMessage, logger } from "@/lib/logger";

export type PingKind = "start" | "success" | "fail";

export function buildPingUrl(base: string, slug: string, kind: PingKind, runId: string): string {
  const suffix = kind === "success" ? "" : `/${kind}`;
  const url = new URL(`${base.replace(/\/+$/, "")}/${slug}${suffix}`);
  url.searchParams.set("create", "1");
  url.searchParams.set("rid", runId);
  return url.toString();
}

// Pings are best effort: a monitoring outage must never fail a collection.
export async function sendPing(slug: string, kind: PingKind, runId: string, body?: string): Promise<void> {
  const base = process.env.HEALTHCHECKS_PING_BASE?.trim();
  if (!base) return;
  try {
    const response = await fetch(buildPingUrl(base, slug, kind, runId), {
      method: "POST",
      body: body?.slice(0, 10_000),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) logger.warn("Healthchecks ping rejected", { slug, kind, status: response.status });
  } catch (error) {
    logger.warn("Healthchecks ping failed", { slug, kind, error: errorMessage(error) });
  }
}
