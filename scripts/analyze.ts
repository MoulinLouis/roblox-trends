import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getSettings } from "@/db/repository";
import { analyzeTrends } from "@/lib/analysis";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  await analyzeTrends(await getSettings());
} catch (error) {
  logger.error("Analysis job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
