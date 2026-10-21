import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import { gameDetail } from "@/test/fixtures";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { jobRuns } from "./schema";
import { censusCoverage, dataTotals, jobSummaries } from "./status";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("status queries", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:12:00Z");
  const windowHours = 24;
  // The window is (now - 24 h, now]: a row stamped exactly at its start is outside.
  const windowStart = "2026-10-19T14:12:00Z";
  const olderCompleteList = new Date("2026-10-20T13:40:00Z");
  const completeList = new Date("2026-10-20T13:50:00Z");
  const truncatedList = new Date("2026-10-20T14:00:00Z");
  const dayBefore = new Date("2026-10-19T14:00:00Z");

  async function insertRun(run: {
    job: JobName;
    status: JobStatus;
    startedAt: string;
    // Census writes its list at the slot of its run; other jobs take their start time.
    slot?: Date;
    finishedAt?: string;
    stats?: Record<string, unknown>;
    error?: string;
  }) {
    const startedAt = new Date(run.startedAt);
    await database.db.insert(jobRuns).values({
      id: randomUUID(),
      job: run.job,
      status: run.status,
      slot: run.slot ?? startedAt,
      startedAt,
      finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      stats: run.stats ?? {},
      error: run.error ?? null,
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1), gameDetail(2)], now);
    // Place 9_999 failed to resolve: it is listed but cannot be tracked.
    await savePlaceResolution(database.db, { placeId: 9_999, universeId: null, resolvedAt: now, error: "no universe" });
    await writeCensusObservations(database.db, [
      { placeId: 5_555, observedAt: olderCompleteList, ccu: 900 },
      { placeId: 1_000_001, observedAt: completeList, ccu: 500 },
      { placeId: 1_000_002, observedAt: completeList, ccu: 300 },
      { placeId: 9_999, observedAt: completeList, ccu: 200 },
      { placeId: 6_666, observedAt: completeList, ccu: 100 },
      { placeId: 8_888, observedAt: completeList, ccu: 99 },
      // The latest list failed its quality check: coverage ignores it.
      { placeId: 7_777, observedAt: truncatedList, ccu: 900 },
      { placeId: 1_000_001, observedAt: truncatedList, ccu: 500 },
      { placeId: 4_444, observedAt: new Date(windowStart), ccu: 500 },
      { placeId: 1_000_001, observedAt: dayBefore, ccu: 500 },
    ]);
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-10-20T14:05:00Z"), ccu: 500, visits: 1, favorites: 1 },
      // Polled 22 minutes before `now`: outside the 15-minute window.
      { universeId: 2, observedAt: completeList, ccu: 300, visits: 1, favorites: 1 },
      // Imported v1 history is not collection.
      { universeId: 2, observedAt: new Date("2026-10-20T14:05:00Z"), ccu: 300, visits: 1, favorites: 1, source: "legacy" },
      { universeId: 2, observedAt: dayBefore, ccu: 300, visits: 1, favorites: 1 },
    ]);

    // census: still running; the latest completed run truncated its list, and the run before it kept a complete list
    // although promotion degraded it.
    await insertRun({ job: "census", status: "failed", startedAt: "2026-10-18T10:00:00Z", error: "outside the window" });
    await insertRun({
      job: "census",
      status: "success",
      startedAt: "2026-10-20T13:40:05Z",
      slot: olderCompleteList,
      finishedAt: "2026-10-20T13:41:00Z",
      stats: { listQuality: "success", listed: 7_900 },
    });
    await insertRun({
      job: "census",
      status: "degraded",
      startedAt: "2026-10-20T13:50:05Z",
      slot: completeList,
      finishedAt: "2026-10-20T13:51:00Z",
      stats: { listQuality: "success", listed: 7_800, rateLimited: true },
    });
    await insertRun({
      job: "census",
      status: "degraded",
      startedAt: "2026-10-20T14:00:05Z",
      slot: truncatedList,
      finishedAt: "2026-10-20T14:01:30Z",
      stats: { listQuality: "degraded", listed: 2, rateLimited: false },
    });
    await insertRun({ job: "census", status: "running", startedAt: "2026-10-20T14:10:05Z" });
    // poll: the latest run failed, and failed runs keep no stats.
    await insertRun({
      job: "poll",
      status: "success",
      startedAt: windowStart,
      finishedAt: "2026-10-19T14:13:00Z",
      stats: { rateLimited: true, http: { attempts: 1_000, retries: 0, rateLimitedResponses: 1_000 } },
    });
    await insertRun({
      job: "poll",
      status: "degraded",
      startedAt: "2026-10-20T13:45:00Z",
      finishedAt: "2026-10-20T13:46:00Z",
      stats: { rateLimited: true, stoppedBy: "error", http: { attempts: 60, retries: 3, rateLimitedResponses: 5 } },
    });
    await insertRun({ job: "poll", status: "failed", startedAt: "2026-10-20T13:55:00Z", error: "first failure" });
    await insertRun({
      job: "poll",
      status: "success",
      startedAt: "2026-10-20T14:00:00Z",
      finishedAt: "2026-10-20T14:00:40Z",
      stats: { rateLimited: false, stoppedBy: null, http: { attempts: 80, retries: 1, rateLimitedResponses: 1 } },
    });
    await insertRun({ job: "poll", status: "failed", startedAt: "2026-10-20T14:05:00Z", error: "poll exceeded 270000 ms" });
    // votes: one failed run, days ago. Its error stays visible because it is the latest run.
    await insertRun({ job: "votes", status: "failed", startedAt: "2026-10-17T09:00:00Z", error: "votes went quiet" });
    // charts: a failure exactly at the window start is outside it, like for the run counts. Malformed HTTP stats count 0.
    await insertRun({ job: "charts", status: "failed", startedAt: windowStart, error: "at the window start" });
    // Only a boolean counts: a string "true" is a malformed stat.
    await insertRun({
      job: "charts",
      status: "degraded",
      startedAt: "2026-10-20T12:00:00Z",
      finishedAt: "2026-10-20T12:03:00Z",
      stats: { rateLimited: "true" },
    });
    await insertRun({
      job: "charts",
      status: "success",
      startedAt: "2026-10-20T13:00:00Z",
      finishedAt: "2026-10-20T13:03:00Z",
      stats: { rateLimited: false, http: { attempts: "80", rateLimitedResponses: null } },
    });
    // thumbnails: recovered since its failure, which stays visible within the window. It reports no `rateLimited`.
    await insertRun({ job: "thumbnails", status: "failed", startedAt: "2026-10-20T12:00:00Z", error: "thumbnails failed" });
    await insertRun({
      job: "thumbnails",
      status: "success",
      startedAt: "2026-10-20T13:30:00Z",
      finishedAt: "2026-10-20T13:35:00Z",
      stats: { stoppedBy: null, http: { attempts: 10, retries: 0, rateLimitedResponses: 0 } },
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe("censusCoverage", () => {
    const criteria = { minimumCcu: 100, withinMinutes: 15, listWithinHours: windowHours };

    it("counts the places of the latest complete list at or above the threshold and those polled recently", async () => {
      expect(await censusCoverage(database.db, now, criteria)).toEqual({
        slot: completeList,
        listed: 4,
        tracked: 1,
        minimumCcu: 100,
        withinMinutes: 15,
      });
    });

    it("reports no list when no complete list was collected within the window", async () => {
      expect(await censusCoverage(database.db, new Date("2026-10-22T14:12:00Z"), criteria)).toEqual({
        slot: null,
        listed: 0,
        tracked: 0,
        minimumCcu: 100,
        withinMinutes: 15,
      });
    });
  });

  it("counts games and the poll and census rows of the window", async () => {
    expect(await dataTotals(database.db, now, windowHours)).toEqual({ games: 2, pollObservations: 2, censusRows: 8 });
  });

  it("summarizes every job in pipeline order, including jobs that never ran", async () => {
    expect(await jobSummaries(database.db, now, windowHours)).toEqual([
      {
        job: "census",
        latest: { status: "running", startedAt: new Date("2026-10-20T14:10:05Z") },
        lastCompleted: {
          status: "degraded",
          finishedAt: new Date("2026-10-20T14:01:30Z"),
          stats: { listQuality: "degraded", listed: 2, rateLimited: false },
        },
        recent: { runs: 4, degraded: 2, failed: 0, rateLimitedRuns: 1, http: null },
        lastError: null,
      },
      {
        job: "poll",
        latest: { status: "failed", startedAt: new Date("2026-10-20T14:05:00Z") },
        lastCompleted: {
          status: "success",
          finishedAt: new Date("2026-10-20T14:00:40Z"),
          stats: { rateLimited: false, stoppedBy: null, http: { attempts: 80, retries: 1, rateLimitedResponses: 1 } },
        },
        recent: { runs: 4, degraded: 1, failed: 2, rateLimitedRuns: 1, http: { rateLimitedResponses: 6, attempts: 140 } },
        lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message: "poll exceeded 270000 ms" },
      },
      {
        job: "votes",
        latest: { status: "failed", startedAt: new Date("2026-10-17T09:00:00Z") },
        lastCompleted: null,
        recent: { runs: 0, degraded: 0, failed: 0, rateLimitedRuns: null, http: null },
        lastError: { startedAt: new Date("2026-10-17T09:00:00Z"), message: "votes went quiet" },
      },
      {
        job: "charts",
        latest: { status: "success", startedAt: new Date("2026-10-20T13:00:00Z") },
        lastCompleted: {
          status: "success",
          finishedAt: new Date("2026-10-20T13:03:00Z"),
          stats: { rateLimited: false, http: { attempts: "80", rateLimitedResponses: null } },
        },
        recent: { runs: 2, degraded: 1, failed: 0, rateLimitedRuns: 0, http: { rateLimitedResponses: 0, attempts: 0 } },
        lastError: null,
      },
      {
        job: "explore",
        latest: null,
        lastCompleted: null,
        recent: { runs: 0, degraded: 0, failed: 0, rateLimitedRuns: null, http: null },
        lastError: null,
      },
      {
        job: "thumbnails",
        latest: { status: "success", startedAt: new Date("2026-10-20T13:30:00Z") },
        lastCompleted: {
          status: "success",
          finishedAt: new Date("2026-10-20T13:35:00Z"),
          stats: { stoppedBy: null, http: { attempts: 10, retries: 0, rateLimitedResponses: 0 } },
        },
        recent: { runs: 2, degraded: 0, failed: 1, rateLimitedRuns: null, http: { rateLimitedResponses: 0, attempts: 10 } },
        lastError: { startedAt: new Date("2026-10-20T12:00:00Z"), message: "thumbnails failed" },
      },
    ]);
  });
});
