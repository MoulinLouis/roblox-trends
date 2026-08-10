import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getSettings } from "@/db/repository";
import { collectRobloxData } from "@/lib/collection";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  await collectRobloxData(await getSettings());
} catch (error) {
  logger.error("Collection job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
