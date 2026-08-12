import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getSettings } from "@/db/repository";
import { runCollectionJob } from "@/lib/collection-job";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  const settings = await getSettings();
  const trigger = process.env.COLLECTION_TRIGGER || "manual";
  const { result } = await runCollectionJob({ settings, trigger });
  if (result?.health.status === "critical") process.exitCode = 1;
} catch (error) {
  logger.error("Collection job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
