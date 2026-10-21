import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { censusCoverage, dataTotals, jobSummaries } from "@/db/status";
import { STATUS_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { formatStatusReport } from "@/lib/status-report";

// The owner's health view until the dashboard's Health page: job freshness, the stats to watch, coverage and totals.
let exitCode = 1;
try {
  // Read-only and interactive: it gives up quickly rather than waiting behind a migration or a lock.
  const database = getDatabase("radar-status", { statementTimeoutMs: 30_000, lockTimeoutMs: 5_000 });
  await assertNotLegacyDatabase(database);
  await assertSupportedPostgres(database);
  const now = new Date();
  const [jobs, coverage, totals] = await Promise.all([
    jobSummaries(database, now),
    censusCoverage(database, now, STATUS_CONFIG.coverageMinimumCcu, STATUS_CONFIG.trackedWithinMinutes),
    dataTotals(database, now),
  ]);
  console.log(formatStatusReport({ now, jobs, coverage, totals }));
  exitCode = 0;
} catch (error) {
  logger.error("Status could not be read", { error: errorMessage(error) });
}

await closeDatabaseWithin(5_000, { command: "status" });
process.exit(exitCode);
