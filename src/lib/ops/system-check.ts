import type { ArchiverHealth, TimescaleJobHealth } from "@/db/system-health";
import { SYSTEM_CHECK_CONFIG } from "@/lib/config";

export interface SystemHealthInput {
  now: Date;
  diskUsedShare: number;
  archiver: ArchiverHealth;
  jobs: readonly TimescaleJobHealth[];
}

export interface SystemHealthResult {
  ok: boolean;
  problems: string[];
  summary: string;
}

const percent = (share: number) => `${Math.round(share * 1_000) / 10}%`;
const minutesBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 60_000);

export function evaluateSystemHealth(input: SystemHealthInput, config = SYSTEM_CHECK_CONFIG): SystemHealthResult {
  const problems: string[] = [];
  if (input.diskUsedShare > config.maximumDiskUsedShare) {
    problems.push(`Disk ${percent(input.diskUsedShare)} used (limit ${percent(config.maximumDiskUsedShare)})`);
  }
  problems.push(...archiverProblems(input.now, input.archiver, config));
  for (const job of input.jobs) {
    const problem = jobProblem(input.now, job, config);
    if (problem) problems.push(problem);
  }
  const archived = input.archiver.lastArchivedAt ? `${minutesBetween(input.archiver.lastArchivedAt, input.now)} min ago` : "never";
  const summary = problems.length
    ? problems.join("\n")
    : `OK: disk ${percent(input.diskUsedShare)}, last WAL archived ${archived}, ${input.jobs.length} TimescaleDB policies on time`;
  return { ok: problems.length === 0, problems, summary };
}

function archiverProblems(now: Date, archiver: ArchiverHealth, config: typeof SYSTEM_CHECK_CONFIG): string[] {
  // archive_mode is off, on or always; always also archives on a primary.
  if (archiver.archiveMode === "off") return ["WAL archiving is off: point-in-time recovery is not possible"];
  if (archiver.lastFailedAt && (!archiver.lastArchivedAt || archiver.lastFailedAt > archiver.lastArchivedAt)) {
    return [`WAL archiving has failed since ${archiver.lastFailedAt.toISOString()}`];
  }
  if (!archiver.lastArchivedAt) return ["No WAL segment archived yet"];
  const age = minutesBetween(archiver.lastArchivedAt, now);
  return age > config.maximumArchiveAgeMinutes ? [`No WAL segment archived for ${age} min`] : [];
}

// A policy that never succeeded is measured from its initial start, so a fresh database is not reported as late.
function jobProblem(now: Date, job: TimescaleJobHealth, config: typeof SYSTEM_CHECK_CONFIG): string | null {
  const label = `${job.procName}${job.hypertableName ? ` on ${job.hypertableName}` : ""} (job ${job.jobId})`;
  if (!job.scheduled) return `${label} is paused`;
  const reference = job.lastSuccessfulFinish ?? job.initialStart;
  if (!reference) return null;
  const allowed = Math.max((job.scheduleIntervalSeconds / 60) * config.lateJobIntervals, config.minimumLateJobMinutes);
  const late = minutesBetween(reference, now);
  return late > allowed ? `${label} has not succeeded for ${late} min (last run ${job.lastRunStatus ?? "none"})` : null;
}
