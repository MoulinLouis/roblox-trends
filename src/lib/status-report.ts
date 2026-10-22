import type { CensusCoverage, DataTotals, JobSummary } from "@/db/status";
import { formatElapsed, formatUtc } from "@/lib/format";
import type { JobName } from "@/lib/jobs/types";

export interface StatusSnapshot {
  now: Date;
  // The window the job counts and data totals were computed over.
  windowHours: number;
  jobs: readonly JobSummary[];
  coverage: CensusCoverage;
  totals: DataTotals;
}

// The stats the design asks to watch in the first week, read from each job's latest completed run. Paths follow
// job_runs.stats; the job tests check that every `values` path exists, so a renamed stat fails a test instead of
// printing a dash. `messages` are recorded only on a failure and get a line of their own when present.
export const WATCHED_STATS: Partial<Record<JobName, { values: readonly string[]; messages?: readonly string[] }>> = {
  census: {
    // A run can be degraded while its list passed: a stalled resolution or a failed promotion explains it.
    values: ["listQuality", "listed", "rejected", "resolved", "resolutionFailures", "deferred", "rateLimited"],
    // listError: the Rolimon's list could not be read (listQuality "failed").
    messages: ["listError", "promotionError"],
  },
  // stoppedBy tells games shed at the deadline from games skipped after a rate limit or repeated failed batches;
  // requested is the hot set plus the tail slice the run planned, and skipped the part of it left out; missing counts
  // the requested games Roblox did not answer (job_runs.stats.missingSample lists some);
  // medianTailDetailsMinutes shows how long the tail games wait between two refreshes; http.endpointIntervalMs shows
  // the game details spacing the run ended with, above its configured value after a 429.
  poll: {
    values: [
      "rateLimited",
      "stoppedBy",
      "http.rateLimitedResponses",
      "requested",
      "skipped",
      "missing",
      "shedBelowCcu",
      "medianTailDetailsMinutes",
      "http.endpointIntervalMs",
    ],
  },
};

// Every line fits a 120-column terminal: watched stats wrap, and a message preview takes the room its line leaves.
const maximumLineWidth = 120;
// One line per message: the head says what failed, the tail holds the root cause (errorMessage appends causes last).
const messageHeadLength = 40;
const messageSeparator = " … ";
const columnGap = "  ";
const counts = new Intl.NumberFormat("en-US");

// A compact terminal view: one row per job, its watched stats and last error under it, then rate limits, coverage and
// totals.
export function formatStatusReport({ now, windowHours, jobs, coverage, totals }: StatusSnapshot): string {
  const header = ["job", "latest run", "last completed", "runs", "degraded", "failed", "rate-limited", "429s/requests"];
  const rows = jobs.map((job) => [
    job.job,
    job.latest ? `${job.latest.status} ${formatElapsed(job.latest.startedAt, now)} ago` : "never",
    job.lastCompleted ? `${job.lastCompleted.status} ${formatElapsed(job.lastCompleted.finishedAt, now)} ago` : "never",
    counts.format(job.recent.runs),
    counts.format(job.recent.degraded),
    counts.format(job.recent.failed),
    job.recent.rateLimitedRuns === null ? "" : counts.format(job.recent.rateLimitedRuns),
    job.recent.http ? `${counts.format(job.recent.http.rateLimitedResponses)}/${counts.format(job.recent.http.attempts)}` : "",
  ]);
  const { lines, widths } = alignColumns([header, ...rows], ["left", "left", "left", "right", "right", "right", "right", "right"]);
  const indent = " ".repeat(widths[0] + columnGap.length);
  const table = [`Jobs (counts over the last ${windowHours} h)`, lines[0]];
  jobs.forEach((job, index) => {
    table.push(lines[index + 1]);
    const watched = WATCHED_STATS[job.job];
    if (watched && job.lastCompleted) {
      const stats = job.lastCompleted.stats;
      table.push(...wrap(indent, watched.values.map((path) => `${path}=${formatStat(statAt(stats, path))}`)));
      for (const path of watched.messages ?? []) {
        if (hasStat(stats, path)) table.push(messageLine(`${indent}${path}: `, formatStat(statAt(stats, path))));
      }
    }
    if (job.lastError) {
      table.push(messageLine(`${indent}error ${formatElapsed(job.lastError.startedAt, now)} ago: `, job.lastError.message));
    }
  });
  return [
    `Radar status at ${formatUtc(now)}`,
    "",
    ...table,
    "",
    rateLimitLine(jobs, windowHours),
    coverageLine(now, coverage, windowHours),
    totalsLine(totals, windowHours),
  ].join("\n");
}

// True when every key of the path exists, even when the value is null (shedBelowCcu is null when nothing was shed).
export function hasStat(stats: Record<string, unknown>, path: string): boolean {
  let value: unknown = stats;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return true;
}

// Failed runs keep no stats: the total is a lower bound of the requests on the IP.
function rateLimitLine(jobs: readonly JobSummary[], windowHours: number): string {
  const http = jobs.flatMap((job) => (job.recent.http ? [job.recent.http] : []));
  const responses = http.reduce((total, metrics) => total + metrics.rateLimitedResponses, 0);
  const attempts = http.reduce((total, metrics) => total + metrics.attempts, 0);
  const runs = jobs.reduce((total, job) => total + (job.recent.rateLimitedRuns ?? 0), 0);
  const share = attempts ? `${Math.round((responses / attempts) * 10_000) / 100}%` : "n/a";
  const requests = http.length ? `${counts.format(responses)}/${counts.format(attempts)} requests (${share})` : "no requests recorded";
  return `429s over the last ${windowHours} h: ${requests}; ${counts.format(runs)} rate-limited run${runs === 1 ? "" : "s"}`;
}

function coverageLine(now: Date, coverage: CensusCoverage, windowHours: number): string {
  if (!coverage.slot) return `Coverage: no complete census list in the last ${windowHours} h`;
  const share = coverage.listed ? `${Math.round((coverage.tracked / coverage.listed) * 1_000) / 10}%` : "n/a";
  return (
    `Coverage: ${counts.format(coverage.tracked)}/${counts.format(coverage.listed)} (${share}) Rolimon's places at or ` +
    `above ${coverage.minimumCcu} CCU polled within ${coverage.withinMinutes} min; ` +
    `complete list ${formatElapsed(coverage.slot, now)} old`
  );
}

function totalsLine(totals: DataTotals, windowHours: number): string {
  return (
    `Data: ${counts.format(totals.games)} games; last ${windowHours} h: ${counts.format(totals.pollObservations)} poll ` +
    `observations, ${counts.format(totals.censusRows)} census rows`
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

// Packs the items into as few lines as fit the width; an item longer than a line gets a line of its own.
function wrap(indent: string, items: readonly string[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (line && indent.length + line.length + 1 + item.length > maximumLineWidth) {
      lines.push(indent + line);
      line = item;
    } else {
      line = line ? `${line} ${item}` : item;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

// Messages can span lines (a cause chain, a failed query and its parameters); the view keeps one line per message.
function messageLine(prefix: string, message: string): string {
  return prefix + preview(message, maximumLineWidth - prefix.length);
}

function preview(message: string, width: number): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (line.length <= width) return line;
  const headLength = Math.min(messageHeadLength, Math.floor((width - messageSeparator.length) / 2));
  const tailLength = Math.max(0, width - headLength - messageSeparator.length);
  return `${line.slice(0, headLength).trimEnd()}${messageSeparator}${line.slice(line.length - tailLength).trimStart()}`;
}
