import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { errorMessage, logger } from "@/lib/logger";

let exitCode = 1;
try {
  // Migrations take exclusive locks: one blocked behind a running job gives up instead of queueing every later query
  // on the table behind it.
  await migrateDatabase(getDatabase("radar-migrate", { lockTimeoutMs: 10_000 }));
  logger.info("Database migrations completed");
  exitCode = 0;
} catch (error) {
  logger.error("Database migration failed", { error: errorMessage(error) });
}

await closeDatabaseWithin(5_000, { command: "db:migrate" });
process.exit(exitCode);
