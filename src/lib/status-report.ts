import type { CensusCoverage, DataTotals, JobSummary } from "@/db/status";
import { STATUS_CONFIG } from "@/lib/config";
import type { JobName } from "@/lib/jobs/types";

export interface StatusSnapshot {
  now: Date;
  jobs: readonly JobSummary[];
  coverage: CensusCoverage;
  totals: DataTotals;
}

// The measurements the design asks to watch in the first week, read from each job's latest completed run. Paths
// follow job_runs.stats, so a line can be checked against the table directly.
const WATCHED_STATS: Partial<Record<JobName, readonly string[]>> = {
  census: ["listQuality", "listed", "rejected", "resolved", "deferred"],
  poll: ["rateLimited", "http.rateLimitedResponses", "skipped", "shedBelowCcu"],
};

const maximumErrorLength = 120;
const columnGap = "  ";
const counts = new Intl.NumberFormat("en-US");

// A compact terminal view: one row per job, its watched stats and last error under it, then coverage and totals.
export function formatStatusReport({ now, jobs, coverage, totals }: StatusSnapshot): string {
  const header = ["job", "latest run", "last completed", "runs 24h", "degraded 24h", "failed 24h"];
  const rows = jobs.map((job) => [
    job.job,
    job.latest ? `${job.latest.status} ${elapsed(now, job.latest.startedAt)} ago` : "never",
    job.lastCompleted ? `${job.lastCompleted.status} ${elapsed(now, job.lastCompleted.finishedAt)} ago` : "never",
    counts.format(job.runs24h),
    counts.format(job.degraded24h),
    counts.format(job.failed24h),
  ]);
  const { lines, widths } = alignColumns([header, ...rows], ["left", "left", "left", "right", "right", "right"]);
  const indent = " ".repeat(widths[0] + columnGap.length);
  const table = [lines[0]];
  jobs.forEach((job, index) => {
    table.push(lines[index + 1]);
    const watched = WATCHED_STATS[job.job];
    if (watched && job.lastCompleted) {
      const stats = job.lastCompleted.stats;
      table.push(indent + watched.map((path) => `${path}=${formatStat(statAt(stats, path))}`).join(" "));
    }
    if (job.lastError) {
      table.push(`${indent}error ${elapsed(now, job.lastError.startedAt)} ago: ${errorPreview(job.lastError.message)}`);
    }
  });
  return [`Radar status at ${formatTime(now)}`, "", ...table, "", coverageLine(now, coverage), totalsLine(totals)].join("\n");
}

function coverageLine(now: Date, coverage: CensusCoverage): string {
  if (!coverage.slot) return "Coverage: no census list yet";
  const { coverageMinimumCcu, trackedWithinMinutes } = STATUS_CONFIG;
  const share = coverage.listed ? `${Math.round((coverage.tracked / coverage.listed) * 1_000) / 10}%` : "n/a";
  return (
    `Coverage: ${counts.format(coverage.tracked)}/${counts.format(coverage.listed)} Rolimon's places at or above ` +
    `${coverageMinimumCcu} CCU polled in the last ${trackedWithinMinutes} min (${share}); ` +
    `census list ${elapsed(now, coverage.slot)} old`
  );
}

function totalsLine(totals: DataTotals): string {
  return (
    `Data: ${counts.format(totals.games)} games; last 24 h: ${counts.format(totals.observations24h)} game observations, ` +
    `${counts.format(totals.censusRows24h)} census rows`
  );
}

function alignColumns(rows: string[][], align: readonly ("left" | "right")[]): { lines: string[]; widths: number[] } {
  const widths = align.map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const lines = rows.map((row) =>
    row
      .map((cell, column) => (align[column] === "right" ? cell.padStart(widths[column]) : cell.padEnd(widths[column])))
      .join(columnGap)
      .trimEnd(),
  );
  return { lines, widths };
}

function statAt(stats: Record<string, unknown>, path: string): unknown {
  let value: unknown = stats;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function formatStat(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// Job errors can span lines (a cause chain, a validation report); the view keeps one line per error.
function errorPreview(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= maximumErrorLength ? line : `${line.slice(0, maximumErrorLength)}…`;
}

// A clock skew between the job host and this one must not print a negative age.
function elapsed(now: Date, at: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
