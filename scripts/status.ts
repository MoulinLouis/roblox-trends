import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { censusCoverage, dataTotals, jobSummaries } from "@/db/status";
import { DATABASE_SESSION_CONFIG, STATUS_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { formatStatusReport } from "@/lib/status-report";

// The owner's health view until the dashboard's Health page: job freshness, the stats to watch, 429s, coverage and
// totals.
let exitCode = 1;
try {
  const database = getDatabase("radar-status", {
    statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs,
    lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs,
  });
  await assertNotLegacyDatabase(database);
  await assertSupportedPostgres(database);
  const now = new Date();
  const windowHours = STATUS_CONFIG.summaryWindowHours;
  const [jobs, coverage, totals] = await Promise.all([
    jobSummaries(database, now, windowHours),
    censusCoverage(database, now, {
      minimumCcu: STATUS_CONFIG.coverageMinimumCcu,
      withinMinutes: STATUS_CONFIG.trackedWithinMinutes,
      listWithinHours: windowHours,
    }),
    dataTotals(database, now, windowHours),
  ]);
  console.log(formatStatusReport({ now, windowHours, jobs, coverage, totals }));
  exitCode = 0;
} catch (error) {
  logger.error("Status could not be read", { error: errorMessage(error) });
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "status" });
process.exit(exitCode);
