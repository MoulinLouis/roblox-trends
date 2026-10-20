import { closeDatabase, getDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { errorMessage, logger } from "@/lib/logger";

try {
  await migrateDatabase(getDatabase());
  logger.info("Database migrations completed");
} catch (error) {
  logger.error("Database migration failed", { error: errorMessage(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
