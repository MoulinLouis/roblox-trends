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
  const slot = new Date("2026-10-20T14:10:00Z");
  const earlierSlot = new Date("2026-10-20T13:50:00Z");
  const dayBefore = new Date("2026-10-19T14:00:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1), gameDetail(2)], now);
    // Place 9_999 failed to resolve: it is listed but cannot be tracked.
    await savePlaceResolution(database.db, { placeId: 9_999, universeId: null, resolvedAt: now, error: "no universe" });
    await writeCensusObservations(database.db, [
      { placeId: 1_000_001, observedAt: slot, ccu: 500 },
      { placeId: 1_000_002, observedAt: slot, ccu: 300 },
      { placeId: 9_999, observedAt: slot, ccu: 200 },
      { placeId: 8_888, observedAt: slot, ccu: 20 },
      // Only the latest slot is the current list.
      { placeId: 7_777, observedAt: earlierSlot, ccu: 900 },
      { placeId: 1_000_002, observedAt: earlierSlot, ccu: 300 },
      { placeId: 1_000_001, observedAt: dayBefore, ccu: 500 },
    ]);
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-10-20T14:05:00Z"), ccu: 500, visits: 1, favorites: 1 },
      // Polled 22 minutes before `now`: outside the 15-minute window.
      { universeId: 2, observedAt: earlierSlot, ccu: 300, visits: 1, favorites: 1 },
      { universeId: 2, observedAt: dayBefore, ccu: 300, visits: 1, favorites: 1 },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("counts listed places above the threshold and those polled recently", async () => {
    expect(await censusCoverage(database.db, now, 100, 15)).toEqual({ slot, listed: 3, tracked: 1 });
  });

  it("counts games and the observations of the last 24 hours", async () => {
    expect(await dataTotals(database.db, now)).toEqual({ games: 2, observations24h: 2, censusRows24h: 6 });
  });

  describe("jobSummaries", () => {
    async function insertRun(run: {
      job: JobName;
      status: JobStatus;
      startedAt: string;
      finishedAt?: string;
      stats?: Record<string, unknown>;
      error?: string;
    }) {
      const startedAt = new Date(run.startedAt);
      await database.db.insert(jobRuns).values({
        id: randomUUID(),
        job: run.job,
        status: run.status,
        slot: startedAt,
        startedAt,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        stats: run.stats ?? {},
        error: run.error ?? null,
      });
    }

    beforeAll(async () => {
      // census: the latest run is still running, so the stats come from the degraded run before it.
      await insertRun({ job: "census", status: "failed", startedAt: "2026-10-18T10:00:00Z", error: "outside the window" });
      await insertRun({
        job: "census",
        status: "success",
        startedAt: "2026-10-20T13:50:00Z",
        finishedAt: "2026-10-20T13:52:00Z",
        stats: { listQuality: "success", listed: 7_800 },
      });
      await insertRun({
        job: "census",
        status: "degraded",
        startedAt: "2026-10-20T14:00:00Z",
        finishedAt: "2026-10-20T14:01:30Z",
        stats: { listQuality: "degraded", listed: 4_000 },
      });
      await insertRun({ job: "census", status: "running", startedAt: "2026-10-20T14:10:00Z" });
      // poll: the latest run failed; the run exactly 24 hours ago is outside the window.
      await insertRun({ job: "poll", status: "success", startedAt: "2026-10-19T14:12:00Z", finishedAt: "2026-10-19T14:13:00Z" });
      await insertRun({ job: "poll", status: "failed", startedAt: "2026-10-20T13:55:00Z", error: "first failure" });
      await insertRun({
        job: "poll",
        status: "success",
        startedAt: "2026-10-20T14:00:00Z",
        finishedAt: "2026-10-20T14:00:40Z",
        stats: { rateLimited: false, http: { rateLimitedResponses: 0 } },
      });
      await insertRun({ job: "poll", status: "failed", startedAt: "2026-10-20T14:05:00Z", error: "poll exceeded 270000 ms" });
      // votes: one failed run, days ago. Its error stays visible because it is the latest run.
      await insertRun({ job: "votes", status: "failed", startedAt: "2026-10-17T09:00:00Z", error: "votes went quiet" });
      // charts: an error older than 24 hours is history once a later run exists.
      await insertRun({ job: "charts", status: "failed", startedAt: "2026-10-19T08:00:00Z", error: "old failure" });
      await insertRun({ job: "charts", status: "success", startedAt: "2026-10-20T13:00:00Z", finishedAt: "2026-10-20T13:03:00Z" });
    });

    it("summarizes every job in pipeline order, including jobs that never ran", async () => {
      expect(await jobSummaries(database.db, now)).toEqual([
        {
          job: "census",
          latest: { status: "running", startedAt: new Date("2026-10-20T14:10:00Z") },
          lastCompleted: {
            status: "degraded",
            finishedAt: new Date("2026-10-20T14:01:30Z"),
            stats: { listQuality: "degraded", listed: 4_000 },
          },
          runs24h: 3,
          degraded24h: 1,
          failed24h: 0,
          lastError: null,
        },
        {
          job: "poll",
          latest: { status: "failed", startedAt: new Date("2026-10-20T14:05:00Z") },
          lastCompleted: {
            status: "success",
            finishedAt: new Date("2026-10-20T14:00:40Z"),
            stats: { rateLimited: false, http: { rateLimitedResponses: 0 } },
          },
          runs24h: 3,
          degraded24h: 0,
          failed24h: 2,
          lastError: { startedAt: new Date("2026-10-20T14:05:00Z"), message: "poll exceeded 270000 ms" },
        },
        {
          job: "votes",
          latest: { status: "failed", startedAt: new Date("2026-10-17T09:00:00Z") },
          lastCompleted: null,
          runs24h: 0,
          degraded24h: 0,
          failed24h: 0,
          lastError: { startedAt: new Date("2026-10-17T09:00:00Z"), message: "votes went quiet" },
        },
        {
          job: "charts",
          latest: { status: "success", startedAt: new Date("2026-10-20T13:00:00Z") },
          lastCompleted: { status: "success", finishedAt: new Date("2026-10-20T13:03:00Z"), stats: {} },
          runs24h: 1,
          degraded24h: 0,
          failed24h: 0,
          lastError: null,
        },
        ...(["explore", "thumbnails"] as const).map((job) => ({
          job,
          latest: null,
          lastCompleted: null,
          runs24h: 0,
          degraded24h: 0,
          failed24h: 0,
          lastError: null,
        })),
      ]);
    });
  });
});
