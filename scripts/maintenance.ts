import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getSettings, runMaintenance } from "@/db/repository";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  const settings = await getSettings();
  const result = await runMaintenance(settings.thresholds.hourlyRetentionDays);
  logger.info("Maintenance completed", result);
} catch (error) {
  logger.error("Maintenance job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
