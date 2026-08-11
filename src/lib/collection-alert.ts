import { hasAlertEvent, recordAlertEvent } from "@/db/repository";
import type { CollectionResult } from "./collection";
import type { CollectionHealthTransition } from "./collection-health";
import { logger } from "./logger";
import type { AppSettings } from "./types";

const TITLES: Record<CollectionHealthTransition, string> = {
  critical: "COLLECTION CRITICAL",
  degraded: "COLLECTION DEGRADED",
  recovered: "COLLECTION RECOVERED",
};

export async function sendCollectionHealthAlert(
  settings: AppSettings,
  result: CollectionResult,
  transition: CollectionHealthTransition | null,
): Promise<{ sent: boolean }> {
  if (!transition) return { sent: false };

  const eventKey = `collection-health:${transition}:${result.attemptId}`;
  if (await hasAlertEvent(eventKey)) return { sent: false };

  const webhook = settings.discordWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) {
    logger.warn("Collection health alert skipped because no webhook is configured", {
      attemptId: result.attemptId,
      transition,
    });
    return { sent: false };
  }

  const details = transition === "recovered"
    ? "Hourly collection is healthy again."
    : result.health.reasons.slice(0, 5).join("\n");
  const content = [
    `**ROBLOX TREND RADAR — ${TITLES[transition]}**`,
    `Bucket: ${result.bucketAt.toISOString()}`,
    `Persisted: ${result.games} games / ${result.snapshots} snapshots`,
    details,
  ].filter(Boolean).join("\n");

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}`);

  await recordAlertEvent(eventKey, `collection-${transition}`, {
    attemptId: result.attemptId,
    bucketAt: result.bucketAt.toISOString(),
    games: result.games,
    snapshots: result.snapshots,
    reasons: result.health.reasons,
  });
  logger.info("Collection health alert sent", { attemptId: result.attemptId, transition });
  return { sent: true };
}
