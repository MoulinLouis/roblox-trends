import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import {
  floorToBucket,
  getRecentCollectionAttempts,
  getSettings,
  hasUsableCollectionAttempt,
} from "@/db/repository";
import { sendCollectionHealthAlert } from "@/lib/collection-alert";
import { detectCollectionHealthTransition } from "@/lib/collection-health";
import { collectRobloxData } from "@/lib/collection";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  const settings = await getSettings();
  const now = new Date();
  const trigger = process.env.COLLECTION_TRIGGER || "manual";
  const bucketAt = floorToBucket(now, settings.collection.intervalMinutes);
  if (trigger !== "manual" && await hasUsableCollectionAttempt(bucketAt)) {
    logger.info("Collection skipped because the current bucket is already usable", {
      bucketAt: bucketAt.toISOString(),
      trigger,
    });
  } else {
    const result = await collectRobloxData(settings, now, trigger);
    try {
      const attempts = await getRecentCollectionAttempts(3);
      const transition = detectCollectionHealthTransition(
        attempts.map((attempt) => attempt.status),
      );
      await sendCollectionHealthAlert(settings, result, transition);
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
      process.exitCode = 1;
    }
  }
} catch (error) {
  logger.error("Collection job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
