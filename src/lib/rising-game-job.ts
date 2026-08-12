import { loadGameDataset, replaceRisingGameSignals } from "@/db/repository";
import { logger } from "./logger";
import { sendPendingRisingGameAlerts } from "./rising-game-alert";
import { detectRisingGameSignals } from "./rising-games";
import type { AppSettings } from "./types";

const DAY = 24 * 60 * 60 * 1_000;

export async function runRisingGameDetection(
  settings: AppSettings,
  now = new Date(),
): Promise<{ active: number; launchBreakouts: number; resurgences: number; newEvents: number }> {
  const dataset = await loadGameDataset();
  const candidates = detectRisingGameSignals(dataset.map((item) => ({
    universeId: item.game.universeId,
    name: item.game.name,
    createdAt: item.game.createdAt,
    firstSeenAt: item.game.firstSeenAt,
    snapshots: item.snapshots,
    recentMetadataText: item.metadataHistory
      .filter((version) => version.observedAt.getTime() >= now.getTime() - 7 * DAY)
      .flatMap((version) => [version.name, version.description])
      .join(" "),
  })), now);
  const events = await replaceRisingGameSignals(candidates, now);

  try {
    await sendPendingRisingGameAlerts(settings, now);
  } catch (error) {
    logger.warn("Rising game alert failed without affecting detection", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const result = {
    active: candidates.length,
    launchBreakouts: candidates.filter((signal) => signal.signalType === "launch_breakout").length,
    resurgences: candidates.filter((signal) => signal.signalType === "resurgence").length,
    newEvents: events.length,
  };
  logger.info("Rising game detection completed", result);
  return result;
}
