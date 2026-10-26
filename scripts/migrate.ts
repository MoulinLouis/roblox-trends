import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { refreshContentFingerprints } from "@/db/fingerprints";
import { migrateDatabase } from "@/db/migrate";
import { DATABASE_SESSION_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

let exitCode = 1;
let step = "Database migration";
try {
  const db = getDatabase("radar-migrate", { lockTimeoutMs: DATABASE_SESSION_CONFIG.migrationLockTimeoutMs });
  await migrateDatabase(db);
  logger.info("Database migrations completed");
  step = "Content fingerprint refresh";
  const refreshed = await refreshContentFingerprints(db);
  if (refreshed.games || refreshed.versions) logger.info("Content fingerprints recomputed", { ...refreshed });
  exitCode = 0;
} catch (error) {
  logger.error(`${step} failed`, { error: errorMessage(error) });
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "db:migrate" });
process.exit(exitCode);
