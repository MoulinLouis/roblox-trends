import { describe, expect, it } from "vitest";
import type { CensusCoverage, JobSummary } from "@/db/status";
import type { JobName } from "@/lib/jobs/types";
import { formatStatusReport } from "./status-report";

const now = new Date("2026-10-20T14:12:00Z");
const coverage = { slot: new Date("2026-10-20T14:10:00Z"), listed: 2_903, tracked: 2_712 };
const totals = { games: 41_233, observations24h: 1_012_345, censusRows24h: 1_123_456 };

function summary(job: JobName, overrides: Partial<JobSummary> = {}): JobSummary {
  return { job, latest: null, lastCompleted: null, runs24h: 0, degraded24h: 0, failed24h: 0, lastError: null, ...overrides };
}

function completedPoll(stats: Record<string, unknown>): JobSummary {
  return summary("poll", {
    latest: { status: "success", startedAt: new Date("2026-10-20T14:10:00Z") },
    lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T14:10:40Z"), stats },
    runs24h: 1,
  });
}

function reportLines(jobs: JobSummary[], coverageOverride: CensusCoverage = coverage): string[] {
  return formatStatusReport({ now, jobs, coverage: coverageOverride, totals }).split("\n");
}

describe("formatStatusReport", () => {
  it("renders each job with its freshness, its watched stats and its last error, then coverage and totals", () => {
    const jobs = [
      summary("census", {
        latest: { status: "running", startedAt: new Date("2026-10-20T14:10:00Z") },
        lastCompleted: {
          status: "degraded",
          finishedAt: new Date("2026-10-20T14:01:30Z"),
          stats: { listed: 4_000, rejected: 12, listQuality: "degraded", eligible: 2_900, resolved: 3, deferred: 0 },
        },
        runs24h: 3,
        degraded24h: 1,
      }),
      summary("poll", {
        latest: { status: "failed", startedAt: new Date("2026-10-20T14:05:00Z") },
        lastCompleted: {
          status: "success",
          finishedAt: new Date("2026-10-20T14:00:40Z"),
          stats: {
            active: 3_600,
            rateLimited: true,
            http: { attempts: 80, retries: 4, rateLimitedResponses: 4 },
            skipped: 600,
            shedBelowCcu: 63,
          },
        },
        runs24h: 288,
        degraded24h: 3,
        failed24h: 2,
        lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message: "poll exceeded 270000 ms" },
      }),
      summary("votes", {
        latest: { status: "failed", startedAt: new Date("2026-10-17T09:00:00Z") },
        lastError: { startedAt: new Date("2026-10-17T09:00:00Z"), message: "votes went quiet" },
      }),
      summary("charts", {
        latest: { status: "success", startedAt: new Date("2026-10-20T13:00:00Z") },
        lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T13:03:00Z"), stats: { sorts: 22 } },
        runs24h: 24,
      }),
      summary("explore"),
    ];

    expect(formatStatusReport({ now, jobs, coverage, totals })).toBe(
      [
        "Radar status at 2026-10-20 14:12 UTC",
        "",
        "job      latest run       last completed    runs 24h  degraded 24h  failed 24h",
        "census   running 2m ago   degraded 10m ago         3             1           0",
        "         listQuality=degraded listed=4000 rejected=12 resolved=3 deferred=0",
        "poll     failed 7m ago    success 11m ago        288             3           2",
        "         rateLimited=true http.rateLimitedResponses=4 skipped=600 shedBelowCcu=63",
        "         error 7m ago: poll exceeded 270000 ms",
        "votes    failed 3d ago    never                    0             0           0",
        "         error 3d ago: votes went quiet",
        "charts   success 72m ago  success 69m ago         24             0           0",
        "explore  never            never                    0             0           0",
        "",
        "Coverage: 2,712/2,903 Rolimon's places at or above 100 CCU polled in the last 15 min (93.4%); census list 2m old",
        "Data: 41,233 games; last 24 h: 1,012,345 game observations, 1,123,456 census rows",
      ].join("\n"),
    );
  });

  it("renders null and missing watched stats as a dash", () => {
    const lines = reportLines([completedPoll({ rateLimited: false, http: {}, skipped: 0, shedBelowCcu: null })]);
    expect(lines.map((line) => line.trim())).toContain("rateLimited=false http.rateLimitedResponses=- skipped=0 shedBelowCcu=-");
  });

  it("keeps the last error on one line and truncates it", () => {
    const message = `fetch failed:\n\tconnect ECONNREFUSED ${"x".repeat(300)}`;
    const lines = reportLines([summary("thumbnails", { lastError: { startedAt: new Date("2026-10-20T14:00:00Z"), message } })]);
    const preview = `fetch failed: connect ECONNREFUSED ${"x".repeat(300)}`.slice(0, 120);
    expect(lines).toContain(`            error 12m ago: ${preview}…`);
  });

  it("shows ages in hours past two hours and never in the future", () => {
    const lines = reportLines([
      summary("votes", {
        latest: { status: "success", startedAt: new Date("2026-10-20T14:13:00Z") },
        lastCompleted: { status: "success", finishedAt: new Date("2026-10-19T14:13:00Z"), stats: {} },
      }),
    ]);
    expect(lines.find((line) => line.startsWith("votes"))?.split(/\s{2,}/)).toEqual(["votes", "success 0m ago", "success 23h ago", "0", "0", "0"]);
  });

  it("reports a missing census list and an empty one", () => {
    expect(reportLines([], { slot: null, listed: 0, tracked: 0 })).toContain("Coverage: no census list yet");
    expect(reportLines([], { slot: new Date("2026-10-20T12:00:00Z"), listed: 0, tracked: 0 })).toContain(
      "Coverage: 0/0 Rolimon's places at or above 100 CCU polled in the last 15 min (n/a); census list 2h old",
    );
  });
});
