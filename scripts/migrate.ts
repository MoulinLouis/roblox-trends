import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  logger.info("Database migrations completed");
} catch (error) {
  logger.error("Database migration failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
