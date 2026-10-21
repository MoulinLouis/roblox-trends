import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { DATABASE_SESSION_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

let exitCode = 1;
try {
  await migrateDatabase(getDatabase("radar-migrate", { lockTimeoutMs: DATABASE_SESSION_CONFIG.migrationLockTimeoutMs }));
  logger.info("Database migrations completed");
  exitCode = 0;
} catch (error) {
  logger.error("Database migration failed", { error: errorMessage(error) });
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "db:migrate" });
process.exit(exitCode);
