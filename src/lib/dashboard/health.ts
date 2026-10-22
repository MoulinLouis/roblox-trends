import { statfs } from "node:fs/promises";
import type { Database } from "@/db/client";
import { type CensusCoverage, censusCoverage, type DataTotals, dataTotals, type JobSummary, jobSummaries } from "@/db/status";
import { readArchiver, readTimescaleJobs } from "@/db/system-health";
import { STATUS_CONFIG } from "@/lib/config";
import { diskUsedShare, evaluateSystemHealth, type SystemHealthResult } from "@/lib/ops/system-check";
import { type RateLimitTotals, rateLimitTotals } from "@/lib/status-report";

export interface HealthSnapshot {
  windowHours: number;
  jobs: JobSummary[];
  coverage: CensusCoverage;
  totals: DataTotals;
  rateLimits: RateLimitTotals;
  system: SystemHealthResult & { diskUsedShare: number; lastArchivedAt: Date | null; policies: number };
}

// What `radar status` and `radar system-check` print, for the Health page. Backups and the restore test report to
// Healthchecks only: the dashboard cannot read pgBackRest.
export async function readHealth(db: Database, now: Date, config = STATUS_CONFIG): Promise<HealthSnapshot> {
  const windowHours = config.summaryWindowHours;
  const [jobs, coverage, totals, policies, archiver, disk] = await Promise.all([
    jobSummaries(db, now, windowHours),
    censusCoverage(db, now, {
      minimumCcu: config.coverageMinimumCcu,
      withinMinutes: config.trackedWithinMinutes,
      listWithinHours: windowHours,
    }),
    dataTotals(db, now, windowHours),
    readTimescaleJobs(db),
    readArchiver(db),
    statfs("/"),
  ]);
  const share = diskUsedShare(disk);
  const result = evaluateSystemHealth({ now, diskUsedShare: share, archiver, jobs: policies });
  return {
    windowHours,
    jobs,
    coverage,
    totals,
    rateLimits: rateLimitTotals(jobs),
    system: { ...result, diskUsedShare: share, lastArchivedAt: archiver.lastArchivedAt, policies: policies.length },
  };
}
