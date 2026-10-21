import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { CensusCoverage, JobSummary } from "@/db/status";
import type { JobName } from "@/lib/jobs/types";
import { errorMessage } from "@/lib/logger";
import { formatStatusReport } from "./status-report";

const now = new Date("2026-10-20T14:12:00Z");
const coverage: CensusCoverage = {
  slot: new Date("2026-10-20T14:00:00Z"),
  listed: 2_903,
  tracked: 2_712,
  minimumCcu: 100,
  withinMinutes: 15,
};
const totals = { games: 41_233, pollObservations: 1_012_345, censusRows: 1_123_456 };
const noRuns = { runs: 0, degraded: 0, failed: 0 };

function summary(job: JobName, overrides: Partial<JobSummary> = {}): JobSummary {
  return { job, latest: null, lastCompleted: null, recent: noRuns, lastError: null, ...overrides };
}

function completed(job: JobName, stats: Record<string, unknown>): JobSummary {
  return summary(job, {
    latest: { status: "success", startedAt: new Date("2026-10-20T14:10:00Z") },
    lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T14:10:40Z"), stats },
    recent: { ...noRuns, runs: 1 },
  });
}

function failed(job: JobName, message: string): JobSummary {
  return summary(job, { lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message } });
}

function reportLines(jobs: JobSummary[], coverageOverride: CensusCoverage = coverage): string[] {
  return formatStatusReport({ now, windowHours: 24, jobs, coverage: coverageOverride, totals })
    .split("\n")
    .map((line) => line.trim());
}

describe("formatStatusReport", () => {
  it("renders each job with its freshness, its watched stats and its last error, then coverage and totals", () => {
    const jobs = [
      summary("census", {
        latest: { status: "running", startedAt: new Date("2026-10-20T14:10:00Z") },
        lastCompleted: {
          status: "degraded",
          finishedAt: new Date("2026-10-20T14:01:30Z"),
          stats: { listed: 4_000, rejected: 12, listQuality: "success", eligible: 2_900, resolved: 0, deferred: 40 },
        },
        recent: { runs: 3, degraded: 1, failed: 0 },
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
        recent: { runs: 288, degraded: 3, failed: 2 },
        lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message: "poll exceeded 270000 ms" },
      }),
      summary("votes", {
        latest: { status: "failed", startedAt: new Date("2026-10-17T09:00:00Z") },
        lastError: { startedAt: new Date("2026-10-17T09:00:00Z"), message: "votes went quiet" },
      }),
      summary("charts", {
        latest: { status: "success", startedAt: new Date("2026-10-20T13:00:00Z") },
        lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T13:03:00Z"), stats: { sorts: 22 } },
        recent: { runs: 24, degraded: 0, failed: 0 },
      }),
      summary("explore"),
    ];

    expect(formatStatusReport({ now, windowHours: 24, jobs, coverage, totals })).toBe(
      [
        "Radar status at 2026-10-20 14:12 UTC",
        "",
        "Jobs (counts over the last 24 h)",
        "job      latest run       last completed    runs  degraded  failed",
        "census   running 2m ago   degraded 10m ago     3         1       0",
        "         listQuality=success listed=4000 rejected=12 resolved=0 deferred=40",
        "poll     failed 7m ago    success 11m ago    288         3       2",
        "         rateLimited=true http.rateLimitedResponses=4 skipped=600 shedBelowCcu=63",
        "         error 7m ago: poll exceeded 270000 ms",
        "votes    failed 3d ago    never                0         0       0",
        "         error 3d ago: votes went quiet",
        "charts   success 72m ago  success 69m ago     24         0       0",
        "explore  never            never                0         0       0",
        "",
        "Coverage: 2,712/2,903 Rolimon's places at or above 100 CCU polled in the last 15 min (93.4%); complete census list 12m old",
        "Data: 41,233 games; last 24 h: 1,012,345 poll observations, 1,123,456 census rows",
      ].join("\n"),
    );
  });

  it("renders null and missing watched stats as a dash", () => {
    const lines = reportLines([completed("poll", { rateLimited: false, http: {}, skipped: 0, shedBelowCcu: null })]);
    expect(lines).toContain("rateLimited=false http.rateLimitedResponses=- skipped=0 shedBelowCcu=-");
  });

  it("keeps a short error whole on one line", () => {
    expect(reportLines([failed("thumbnails", "fetch failed:\n\tconnect ECONNREFUSED 127.0.0.1:443")])).toContain(
      "error 7m ago: fetch failed: connect ECONNREFUSED 127.0.0.1:443",
    );
  });

  it("keeps the head and the root cause of a long failed query", () => {
    const query =
      `insert into "games" ("universe_id", "root_place_id", "name") values ` +
      `${Array.from({ length: 50 }, (_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(", ")} ` +
      `on conflict ("universe_id") do update set "name" = excluded.name`;
    const params = Array.from({ length: 150 }, (_, index) => index);
    const message = errorMessage(new DrizzleQueryError(query, params, new Error("canceling statement due to lock timeout")));
    expect(reportLines([failed("poll", message)])).toContain(
      'error 7m ago: Failed query: insert into "games" ("univ … "universe_id")…(535 more characters): canceling statement due to lock timeout',
    );
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

  it("reports the absence of a complete census list", () => {
    expect(reportLines([], { ...coverage, slot: null, listed: 0, tracked: 0 })).toContain(
      "Coverage: no complete census list in the last 24 h",
    );
  });

  it("labels coverage with the criteria it was counted with", () => {
    expect(reportLines([], { ...coverage, listed: 0, tracked: 0, minimumCcu: 50, withinMinutes: 10 })).toContain(
      "Coverage: 0/0 Rolimon's places at or above 50 CCU polled in the last 10 min (n/a); complete census list 12m old",
    );
  });
});
