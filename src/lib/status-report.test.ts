import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { CensusCoverage, JobSummary } from "@/db/status";
import type { JobName } from "@/lib/jobs/types";
import { errorMessage } from "@/lib/logger";
import { formatStatusReport, hasStat, rateLimitTotals, tailRefresh } from "./status-report";

const now = new Date("2026-10-20T14:12:00Z");
const coverage: CensusCoverage = {
  slot: new Date("2026-10-20T14:00:00Z"),
  listed: 2_903,
  tracked: 2_712,
  minimumCcu: 100,
  withinMinutes: 15,
};
const totals = { games: 41_233, pollObservations: 1_012_345, censusRows: 1_123_456 };
const tailRefreshMinutes = { young: 30, established: 240 };
const noRuns = { runs: 0, degraded: 0, failed: 0, rateLimitedRuns: null, http: null };

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
  return formatStatusReport({ now, windowHours: 24, jobs, coverage: coverageOverride, totals, tailRefreshMinutes })
    .split("\n")
    .map((line) => line.trim());
}

describe("formatStatusReport", () => {
  it("renders each job with its freshness, its watched stats and its last error, then rate limits, coverage and totals", () => {
    const jobs = [
      summary("census", {
        latest: { status: "running", startedAt: new Date("2026-10-20T14:10:00Z") },
        lastCompleted: {
          status: "degraded",
          finishedAt: new Date("2026-10-20T14:01:30Z"),
          stats: {
            listed: 4_000,
            rejected: 12,
            listQuality: "success",
            eligible: 2_900,
            resolved: 0,
            resolutionFailures: 3,
            deferred: 40,
            rateLimited: false,
            promotionError: "Game details request failed: 503 Service Unavailable",
          },
        },
        recent: { runs: 3, degraded: 1, failed: 0, rateLimitedRuns: 0, http: { rateLimitedResponses: 1, attempts: 360 } },
      }),
      summary("poll", {
        latest: { status: "failed", startedAt: new Date("2026-10-20T14:05:00Z") },
        lastCompleted: {
          status: "success",
          finishedAt: new Date("2026-10-20T14:00:40Z"),
          stats: {
            active: 3_600,
            rateLimited: true,
            stoppedBy: "error",
            http: { attempts: 80, retries: 4, rateLimitedResponses: 4, endpointIntervalMs: { "games.roblox.com/v1/games": 10_500 } },
            requested: 3_150,
            skipped: 600,
            missing: 1,
            missingSample: [3_269_082_462],
            shedBelowCcu: 63,
            medianTailDetailsMinutes: { young: 31, established: 200 },
          },
        },
        recent: { runs: 288, degraded: 3, failed: 2, rateLimitedRuns: 1, http: { rateLimitedResponses: 12, attempts: 20_160 } },
        lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message: "poll exceeded 270000 ms" },
      }),
      summary("votes", {
        latest: { status: "failed", startedAt: new Date("2026-10-17T09:00:00Z") },
        lastError: { startedAt: new Date("2026-10-17T09:00:00Z"), message: "votes went quiet" },
      }),
      summary("charts", {
        latest: { status: "success", startedAt: new Date("2026-10-20T13:00:00Z") },
        lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T13:03:00Z"), stats: { sorts: 22 } },
        recent: { runs: 24, degraded: 0, failed: 0, rateLimitedRuns: 0, http: { rateLimitedResponses: 0, attempts: 528 } },
      }),
      summary("explore"),
    ];

    expect(formatStatusReport({ now, windowHours: 24, jobs, coverage, totals, tailRefreshMinutes })).toBe(
      [
        "Radar status at 2026-10-20 14:12 UTC",
        "",
        "Jobs (counts over the last 24 h)",
        "job      latest run       last completed    runs  degraded  failed  rate-limited  429s/requests",
        "census   running 2m ago   degraded 10m ago     3         1       0             0          1/360",
        "         listQuality=success listed=4000 rejected=12 resolved=0 resolutionFailures=3 deferred=40 rateLimited=false",
        "         promotionError: Game details request failed: 503 Service Unavailable",
        "poll     failed 7m ago    success 11m ago    288         3       2             1      12/20,160",
        "         rateLimited=true stoppedBy=error http.rateLimitedResponses=4 requested=3150 skipped=600 missing=1",
        "         shedBelowCcu=63 medianTailDetailsMinutes.young=31 medianTailDetailsMinutes.established=200",
        '         http.endpointIntervalMs={"games.roblox.com/v1/games":10500}',
        "         error 7m ago: poll exceeded 270000 ms",
        "votes    failed 3d ago    never                0         0       0",
        "         error 3d ago: votes went quiet",
        "charts   success 72m ago  success 69m ago     24         0       0             0          0/528",
        "explore  never            never                0         0       0",
        "",
        "429s over the last 24 h: 13/21,048 requests (0.06%); 1 rate-limited run",
        "Coverage: 2,712/2,903 (93.4%) Rolimon's places at or above 100 CCU polled within 15m; complete list 12m old",
        "Tail refresh in the last poll run: young games 31 min (target 30), established 200 min (target 240)",
        "Data: 41,233 games; last 24 h: 1,012,345 poll observations, 1,123,456 census rows",
      ].join("\n"),
    );
  });

  it("renders null and missing watched stats as a dash and leaves out absent messages", () => {
    const lines = reportLines([
      completed("poll", { rateLimited: false, stoppedBy: null, http: {}, skipped: 0, shedBelowCcu: null, medianTailDetailsMinutes: null }),
      completed("census", { listQuality: "success", listed: 7_800 }),
    ]);
    expect(lines).toContain("rateLimited=false stoppedBy=- http.rateLimitedResponses=- requested=- skipped=0 missing=- shedBelowCcu=-");
    expect(lines).toContain("medianTailDetailsMinutes.young=- medianTailDetailsMinutes.established=- http.endpointIntervalMs=-");
    expect(lines).toContain("Tail refresh in the last poll run: young games n/a (target 30), established n/a (target 240)");
    expect(lines).toContain("listQuality=success listed=7800 rejected=- resolved=- resolutionFailures=- deferred=- rateLimited=-");
    expect(lines.some((line) => line.startsWith("promotionError") || line.startsWith("listError"))).toBe(false);
  });

  it("shows why a census run has no list", () => {
    const lines = reportLines([
      completed("census", {
        listQuality: "failed",
        listed: null,
        rejected: null,
        resolved: 0,
        resolutionFailures: 0,
        deferred: 0,
        rateLimited: false,
        listError: "503 Service Unavailable for api.rolimons.com",
      }),
    ]);
    expect(lines).toContain("listQuality=failed listed=- rejected=- resolved=0 resolutionFailures=0 deferred=0 rateLimited=false");
    expect(lines).toContain("listError: 503 Service Unavailable for api.rolimons.com");
  });

  it("wraps watched stats that do not fit on one line", () => {
    const stats = {
      listQuality: "success",
      listed: 12_345,
      rejected: 12_345,
      resolved: 12_345,
      resolutionFailures: 12_345,
      deferred: 12_345,
      rateLimited: false,
    };
    const lines = reportLines([completed("census", stats)]);
    const first = lines.indexOf("listQuality=success listed=12345 rejected=12345 resolved=12345 resolutionFailures=12345 deferred=12345");
    expect(first).toBeGreaterThan(0);
    expect(lines[first + 1]).toBe("rateLimited=false");
  });

  it("keeps every line of a busy report within 120 columns", () => {
    const longQuery = `insert into "games" ("universe_id", "name") values ${Array.from({ length: 200 }, (_, index) => `($${index})`).join(", ")}`;
    const lockTimeout = errorMessage(
      new DrizzleQueryError(longQuery, [1, 2, 3], new Error("canceling statement due to lock timeout")),
    );
    const busy = (job: JobName, stats: Record<string, unknown>, http: JobSummary["recent"]["http"]): JobSummary => ({
      job,
      latest: { status: "degraded", startedAt: new Date("2026-10-20T12:13:00Z") },
      lastCompleted: { status: "degraded", finishedAt: new Date("2026-10-20T12:13:00Z"), stats },
      recent: { runs: 288, degraded: 288, failed: 288, rateLimitedRuns: 288, http },
      lastError: { startedAt: new Date("2026-10-20T12:13:00Z"), message: lockTimeout },
    });
    const census = busy(
      "census",
      {
        listQuality: "success",
        listed: 12_345,
        rejected: 12_345,
        resolved: 12_345,
        resolutionFailures: 12_345,
        deferred: 12_345,
        rateLimited: true,
        promotionError: `Game details request failed: ${"503 Service Unavailable ".repeat(20)}`,
      },
      { rateLimitedResponses: 12_345, attempts: 123_456 },
    );
    const poll = busy(
      "poll",
      {
        rateLimited: true,
        stoppedBy: "repeatedFailures",
        http: { rateLimitedResponses: 12_345, endpointIntervalMs: { "games.roblox.com/v1/games": 30_000 } },
        requested: 123_456,
        skipped: 12_345,
        missing: 123_456,
        shedBelowCcu: 12_345,
        medianTailDetailsMinutes: { young: 12_345, established: 12_345 },
      },
      { rateLimitedResponses: 123_456, attempts: 1_234_567 },
    );
    const others = (["votes", "charts", "explore", "thumbnails"] as const).map((job) =>
      busy(job, {}, { rateLimitedResponses: 12_345, attempts: 123_456 }),
    );
    const report = formatStatusReport({
      now,
      windowHours: 24,
      jobs: [census, poll, ...others],
      coverage: { slot: new Date("2026-10-20T12:13:00Z"), listed: 12_345, tracked: 12_345, minimumCcu: 100, withinMinutes: 15 },
      totals: { games: 123_456, pollObservations: 12_345_678, censusRows: 12_345_678 },
      tailRefreshMinutes: { young: 12_345, established: 12_345 },
    });
    const lines = report.split("\n");
    expect(lines.filter((line) => line.length > 120)).toEqual([]);
    // The budget is met by the preview, not by dropping the cause.
    const errors = lines.filter((line) => line.trimStart().startsWith("error 119m ago: "));
    expect(errors).toHaveLength(6);
    for (const line of errors) expect(line.endsWith("canceling statement due to lock timeout")).toBe(true);
    expect(lines.filter((line) => line.trimStart().startsWith("promotionError: Game details request failed: 503"))).toHaveLength(1);
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
      'error 7m ago: Failed query: insert into "games" ("univ … more characters): canceling statement due to lock timeout',
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

  it("reports the absence of a complete census list and of recorded requests", () => {
    const lines = reportLines([], { ...coverage, slot: null, listed: 0, tracked: 0 });
    expect(lines).toContain("Coverage: no complete census list in the last 24 h");
    expect(lines).toContain("429s over the last 24 h: no requests recorded; 0 rate-limited runs");
  });

  it("labels coverage with the criteria it was counted with", () => {
    expect(reportLines([], { ...coverage, listed: 0, tracked: 0, minimumCcu: 50, withinMinutes: 10 })).toContain(
      "Coverage: 0/0 (n/a) Rolimon's places at or above 50 CCU polled within 10m; complete list 12m old",
    );
    expect(reportLines([], { ...coverage, withinMinutes: 6 * 60 })).toContain(
      "Coverage: 2,712/2,903 (93.4%) Rolimon's places at or above 100 CCU polled within 6h; complete list 12m old",
    );
  });
});

describe("hasStat", () => {
  it("finds a nested key even when its value is null", () => {
    expect(hasStat({ http: { rateLimitedResponses: 0 }, shedBelowCcu: null }, "http.rateLimitedResponses")).toBe(true);
    expect(hasStat({ shedBelowCcu: null }, "shedBelowCcu")).toBe(true);
    expect(hasStat({ http: {} }, "http.rateLimitedResponses")).toBe(false);
    expect(hasStat({ http: null }, "http.rateLimitedResponses")).toBe(false);
    expect(hasStat({}, "stoppedBy")).toBe(false);
  });
});

describe("tailRefresh", () => {
  it("reads each lane's median wait from poll's last completed run beside its target", () => {
    const jobs = [completed("census", {}), completed("poll", { medianTailDetailsMinutes: { young: 28, established: null } })];
    expect(tailRefresh(jobs, tailRefreshMinutes)).toEqual([
      { lane: "young", minutes: 28, targetMinutes: 30 },
      { lane: "established", minutes: null, targetMinutes: 240 },
    ]);
  });

  it("has no wait to report before poll completes a run with lanes", () => {
    const unknown = [
      { lane: "young", minutes: null, targetMinutes: 30 },
      { lane: "established", minutes: null, targetMinutes: 240 },
    ];
    expect(tailRefresh([summary("poll")], tailRefreshMinutes)).toEqual(unknown);
    expect(tailRefresh([], tailRefreshMinutes)).toEqual(unknown);
    // A run from before the lanes reported one median for the whole tail.
    expect(tailRefresh([completed("poll", { medianTailDetailsMinutes: 70 })], tailRefreshMinutes)).toEqual(unknown);
  });
});

describe("rateLimitTotals", () => {
  it("adds the 429s, requests and rate-limited runs of every job that records them", () => {
    const jobs = [
      summary("poll", { recent: { ...noRuns, runs: 6, rateLimitedRuns: 1, http: { rateLimitedResponses: 4, attempts: 100 } } }),
      summary("charts", { recent: { ...noRuns, runs: 1, rateLimitedRuns: 0, http: { rateLimitedResponses: 0, attempts: 50 } } }),
      summary("explore"),
    ];
    expect(rateLimitTotals(jobs)).toEqual({ responses: 4, attempts: 150, runs: 1, recorded: true });
    expect(rateLimitTotals([])).toEqual({ responses: 0, attempts: 0, runs: 0, recorded: false });
  });
});
