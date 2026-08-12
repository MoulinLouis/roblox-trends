import {
  floorToBucket,
  getRecentCollectionAttempts,
  hasUsableCollectionAttempt,
} from "@/db/repository";
import { sendCollectionHealthAlert } from "./collection-alert";
import { detectCollectionHealthTransition } from "./collection-health";
import { collectRobloxData, type CollectionResult } from "./collection";
import { logger } from "./logger";
import type { AppSettings } from "./types";

export async function runCollectionJob(input: {
  settings: AppSettings;
  now?: Date;
  trigger?: string;
  skipUsableBucket?: boolean;
}): Promise<{ skipped: boolean; result: CollectionResult | null }> {
  const now = input.now ?? new Date();
  const trigger = input.trigger ?? "manual";
  const skipUsableBucket = input.skipUsableBucket ?? trigger !== "manual";
  const bucketAt = floorToBucket(now, input.settings.collection.intervalMinutes);
  if (skipUsableBucket && await hasUsableCollectionAttempt(bucketAt)) {
    logger.info("Collection skipped because the current bucket is already usable", {
      bucketAt: bucketAt.toISOString(),
      trigger,
    });
    return { skipped: true, result: null };
  }

  const result = await collectRobloxData(input.settings, now, trigger);
  try {
    const attempts = await getRecentCollectionAttempts(3);
    const transition = detectCollectionHealthTransition(attempts.map((attempt) => attempt.status));
    await sendCollectionHealthAlert(input.settings, result, transition);
  } catch (error) {
    logger.warn("Collection health alert failed without affecting collection", {
      attemptId: result.attemptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (result.health.status === "degraded") {
    logger.warn("Collection completed with optional source degradation", {
      attemptId: result.attemptId,
      reasons: result.health.reasons,
    });
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Collection degraded::${result.health.reasons.join(" | ")}`);
    }
  }
  if (result.health.status === "critical") {
    logger.error("Collection completed below the critical health threshold", {
      attemptId: result.attemptId,
      reasons: result.health.reasons,
    });
  }
  return { skipped: false, result };
}
