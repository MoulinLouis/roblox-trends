import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { gameObservations, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { RobloxClient } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { hasStat, WATCHED_STATS } from "@/lib/status-report";
import { gameDetail } from "@/test/fixtures";
import { createPollJob } from "./poll";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("poll job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:07:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function observedUniverses(): Promise<number[]> {
    const rows = await database.db.select({ universeId: gameObservations.universeId }).from(gameObservations);
    return rows.map((row) => row.universeId).sort((left, right) => left - right);
  }

  describe("with two busy games", () => {
    beforeAll(async () => {
      await upsertGameDetails(database.db, [gameDetail(1, { playing: 500 }), gameDetail(2, { playing: 400 })], now);
    });

    it("writes one observation per returned game in the ten-minute slot", async () => {
      const job = createPollJob({
        roblox: { getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id), { playing: 700 })) },
      });
      expect(await executeJob(job, database.db, now)).toBe("success");
      const rows = await database.db.select().from(gameObservations);
      expect(rows.map((row) => [row.universeId, row.ccu, row.observedAt.toISOString()]).sort()).toEqual([
        [1, 700, "2026-10-20T14:00:00.000Z"],
        [2, 700, "2026-10-20T14:00:00.000Z"],
      ]);
    });

    it("marks a run degraded when games are missing from the response", async () => {
      const job = createPollJob({
        roblox: { getGameDetails: async (ids) => ids.slice(0, 1).map((id) => gameDetail(Number(id))) },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
    });

    it("reports the HTTP requests of the run", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const ids = new URL(String(input)).searchParams.get("universeIds")?.split(",") ?? [];
          return Response.json({ data: ids.map((id) => gameDetail(Number(id), { playing: 600 })) });
        }),
      );
      try {
        expect(await executeJob(createPollJob({ roblox: new RobloxClient() }), database.db, now)).toBe("success");
      } finally {
        vi.unstubAllGlobals();
      }
      const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
      expect(run.stats).toMatchObject({
        active: 2,
        hot: 2,
        tail: 0,
        tailRequested: 0,
        requested: 2,
        returned: 2,
        http: { attempts: 1, retries: 0, rateLimitedResponses: 0, endpointIntervalMs: { "games.roblox.com/v1/games": 7_000 } },
        shedBelowCcu: null,
        medianTailDetailsMinutes: null,
        missing: 0,
        missingSample: [],
      });
      expect(Object.keys(run.stats).sort()).toEqual([
        "active",
        "attempted",
        "failedBatches",
        "hot",
        "http",
        "medianTailDetailsMinutes",
        "metadataChanges",
        "missing",
        "missingSample",
        "newGames",
        "rateLimited",
        "requested",
        "returned",
        "shedBelowCcu",
        "skipped",
        "stoppedBy",
        "tail",
        "tailRequested",
      ]);
      // `npm run status` prints these paths: a renamed stat must fail here rather than print a dash.
      expect(WATCHED_STATS.poll?.values.filter((path) => !hasStat(run.stats, path))).toEqual([]);
    });
  });

  describe("with more busy games than one batch", () => {
    // Priorities fall from 1,899 (universe 101) to 1,840 (universe 160), so the first batch of 50 holds 101 to 150.
    const universeIds = Array.from({ length: 60 }, (_, index) => 101 + index);
    const firstBatch = universeIds.slice(0, JOB_CONFIG.poll.batchSize);

    beforeEach(async () => {
      await database.db.delete(gameObservations);
      await database.db.delete(jobRuns);
      await database.db.delete(games);
      await upsertGameDetails(database.db, universeIds.map((id) => gameDetail(id, { playing: 2_000 - id })), now);
    });

    it("sheds the quietest games once the deadline passes", async () => {
      let clockMs = 0;
      const job = createPollJob({
        roblox: {
          getGameDetails: async (ids) => {
            clockMs += JOB_CONFIG.poll.deadlineMs + 1;
            return ids.map((id) => gameDetail(Number(id)));
          },
        },
        clock: () => clockMs,
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(await observedUniverses()).toEqual(firstBatch);
      const [run] = await database.db.select().from(jobRuns);
      // Universe 151, the busiest game left out, has 2,000 - 151 players.
      expect(run.stats).toMatchObject({ active: 60, attempted: 50, returned: 50, failedBatches: 0, skipped: 10, shedBelowCcu: 1_849 });
    });

    it("sheds the tail behind the hot set and reports the first game left out in the request order", async () => {
      // Universe 160, the quietest, has the oldest details, so it heads the tail.
      await database.db
        .update(games)
        .set({ lastCcuAt: new Date(now.getTime() - 30 * 60_000) })
        .where(eq(games.universeId, 160));
      let clockMs = 0;
      const job = createPollJob({
        roblox: {
          getGameDetails: async (ids) => {
            clockMs += JOB_CONFIG.poll.deadlineMs + 1;
            return ids.map((id) => gameDetail(Number(id), { playing: 2_000 - Number(id) }));
          },
        },
        clock: () => clockMs,
        hotUniverses: JOB_CONFIG.poll.batchSize,
        tailUniversesPerRun: 10,
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(await observedUniverses()).toEqual(firstBatch);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: 60,
        hot: 50,
        tail: 10,
        tailRequested: 10,
        requested: 60,
        attempted: 50,
        returned: 50,
        skipped: 10,
        stoppedBy: "deadline",
        shedBelowCcu: 1_840,
        // The tail games shed at the deadline were never requested: they are skipped, not missing, and still count here.
        // Nine of the ten hold details stored at `now`, so their median age is 0 (null if they did not count).
        medianTailDetailsMinutes: 0,
        missing: 0,
      });
    });

    it("keeps going after a failed batch and stores the others", async () => {
      let calls = 0;
      const job = createPollJob({
        roblox: {
          getGameDetails: async (ids) => {
            calls += 1;
            if (calls === 1) throw new Error("socket hang up");
            return ids.map((id) => gameDetail(Number(id)));
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(await observedUniverses()).toEqual(universeIds.slice(JOB_CONFIG.poll.batchSize));
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        attempted: 60,
        returned: 10,
        failedBatches: 1,
        skipped: 0,
        stoppedBy: null,
        rateLimited: false,
        shedBelowCcu: null,
        // The games of the failed batch were requested and not answered.
        missing: 50,
        missingSample: universeIds.slice(0, 10),
      });
    });

    it("counts the requested games Roblox left out and lists the first ten universe ids", async () => {
      // Priorities now rise with the universe id, so the games are requested from 160 down to 101.
      await upsertGameDetails(database.db, universeIds.map((id) => gameDetail(id, { playing: id })), now);
      const unanswered = universeIds.filter((id) => id % 4 === 0);
      const job = createPollJob({
        roblox: {
          getGameDetails: async (ids) => ids.map(Number).filter((id) => !unanswered.includes(id)).map((id) => gameDetail(id)),
        },
      });
      await executeJob(job, database.db, now);
      const [run] = await database.db.select().from(jobRuns);
      expect(unanswered).toHaveLength(15);
      expect(run.stats).toMatchObject({
        requested: 60,
        attempted: 60,
        returned: 45,
        failedBatches: 0,
        skipped: 0,
        missing: 15,
        missingSample: [104, 108, 112, 116, 120, 124, 128, 132, 136, 140],
      });
    });

    it("fails the run when observations cannot be stored", async () => {
      let calls = 0;
      const job = createPollJob({
        roblox: {
          // A player count beyond the integer column makes the observation insert fail in the database.
          getGameDetails: async (ids) => {
            calls += 1;
            return ids.map((id) => gameDetail(Number(id), { playing: 3_000_000_000 }));
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("failed");
      expect(calls).toBe(1);
      expect(await observedUniverses()).toEqual([]);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.error).toMatch(/out of range/);
    });

    it("stops at a rate limit that outlasted the retries and skips the remaining games", async () => {
      let calls = 0;
      const job = createPollJob({
        roblox: {
          getGameDetails: async () => {
            calls += 1;
            throw new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games");
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(calls).toBe(1);
      expect(await observedUniverses()).toEqual([]);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: 60,
        attempted: 50,
        returned: 0,
        failedBatches: 1,
        skipped: 10,
        rateLimited: true,
        stoppedBy: "error",
        shedBelowCcu: 1_849,
      });
    });

    it("keeps the batches it finished when the run exceeds its timeout", async () => {
      let calls = 0;
      const job = createPollJob({
        roblox: {
          // The second batch never answers, like a request stuck in its retries.
          getGameDetails: async (ids) => {
            calls += 1;
            if (calls > 1) return new Promise(() => undefined);
            return ids.map((id) => gameDetail(Number(id)));
          },
        },
      });
      expect(await executeJob({ ...job, timeoutMs: 1_000 }, database.db, now)).toBe("failed");
      expect(calls).toBe(2);
      expect(await observedUniverses()).toEqual(firstBatch);
    });
  });

  describe("with more active games than one run requests", () => {
    // Two hot games and four tail games, two of which are requested per run. Priorities fall with the universe id.
    const playing = new Map([
      [201, 900],
      [202, 800],
      [203, 700],
      [204, 600],
      [205, 500],
      [206, 400],
    ]);
    const minutesBefore = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    let requests: number[][];

    // Roblox answers for every requested game except the unanswered ones.
    function rotatingJob(unanswered: readonly number[] = [], hotUniverses = 2) {
      return createPollJob({
        roblox: {
          getGameDetails: async (ids) => {
            requests.push(ids.map(Number));
            return ids
              .map(Number)
              .filter((id) => !unanswered.includes(id))
              .map((id) => gameDetail(id, { playing: playing.get(id) }));
          },
        },
        hotUniverses,
        tailUniversesPerRun: 2,
      });
    }

    async function setDetailsAt(universeId: number, at: Date | null): Promise<void> {
      await database.db.update(games).set({ lastCcuAt: at }).where(eq(games.universeId, universeId));
    }

    async function storedTimes(universeId: number): Promise<{ lastCcuAt: Date | null; detailsAttemptedAt: Date | null }> {
      const [row] = await database.db
        .select({ lastCcuAt: games.lastCcuAt, detailsAttemptedAt: games.detailsAttemptedAt })
        .from(games)
        .where(eq(games.universeId, universeId));
      return row;
    }

    beforeEach(async () => {
      requests = [];
      await database.db.delete(gameObservations);
      await database.db.delete(jobRuns);
      await database.db.delete(games);
      await upsertGameDetails(
        database.db,
        [...playing].map(([id, ccu]) => gameDetail(id, { playing: ccu })),
        now,
      );
      // The hot games hold the freshest details. Game 205 has none yet: it stays active as a young game with players.
      await setDetailsAt(201, minutesBefore(1));
      await setDetailsAt(202, minutesBefore(1));
      await setDetailsAt(203, minutesBefore(30));
      await setDetailsAt(204, minutesBefore(50));
      await setDetailsAt(205, null);
      await setDetailsAt(206, minutesBefore(10));
    });

    it("requests the hot set, then the tail games with the oldest details, never-detailed games first", async () => {
      expect(await executeJob(rotatingJob(), database.db, now)).toBe("success");
      expect(requests).toEqual([[201, 202, 205, 204]]);
      expect(await observedUniverses()).toEqual([201, 202, 204, 205]);
    });

    it("counts only the requested games in the quality gate and reports the plan", async () => {
      // Four of six active games returned is below the 95% share, but every requested game came back.
      expect(await executeJob(rotatingJob(), database.db, now)).toBe("success");
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: 6,
        hot: 2,
        tail: 4,
        tailRequested: 2,
        requested: 4,
        attempted: 4,
        returned: 4,
        skipped: 0,
        stoppedBy: null,
        shedBelowCcu: null,
        // Game 205 has no details to date; game 204's are 50 minutes old.
        medianTailDetailsMinutes: 50,
      });
    });

    it("degrades a run when a requested game is missing", async () => {
      const job = createPollJob({
        roblox: { getGameDetails: async (ids) => ids.slice(1).map((id) => gameDetail(Number(id), { playing: playing.get(Number(id)) })) },
        hotUniverses: 2,
        tailUniversesPerRun: 2,
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
    });

    it("moves the tail games it polled behind the others in the next runs", async () => {
      const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
      expect(await executeJob(rotatingJob(), database.db, now)).toBe("success");
      // 204 and 205 now hold this run's details: 203 (30 minutes before the first run) and 206 (10) come first.
      expect(await executeJob(rotatingJob(), database.db, later(10))).toBe("success");
      // 204 and 205 now hold the oldest details again, from the first run; the lower universe id breaks the tie.
      expect(await executeJob(rotatingJob(), database.db, later(20))).toBe("success");
      expect(requests).toEqual([
        [201, 202, 205, 204],
        [201, 202, 203, 206],
        [201, 202, 204, 205],
      ]);
      const runs = await database.db.select().from(jobRuns).orderBy(jobRuns.startedAt);
      expect(runs.map((run) => run.stats.medianTailDetailsMinutes)).toEqual([50, 30, 20]);
    });

    it("moves a requested game that Roblox did not answer behind the other tail games, once per tail cycle", async () => {
      const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
      // Game 204 holds the oldest details, from before Roblox stopped answering for it; game 205 has some too.
      await setDetailsAt(205, minutesBefore(40));
      const job = rotatingJob([204]);
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(await storedTimes(204)).toEqual({ lastCcuAt: minutesBefore(50), detailsAttemptedAt: now });
      // Every requested game gets the time, answered or not; a game left out of the request keeps none.
      expect(await storedTimes(205)).toEqual({ lastCcuAt: now, detailsAttemptedAt: now });
      expect(await storedTimes(203)).toEqual({ lastCcuAt: minutesBefore(30), detailsAttemptedAt: null });
      // 204 and 205 were both requested by the first run, answered or not: 203 and 206 come first.
      expect(await executeJob(job, database.db, later(10))).toBe("success");
      // Then 204 is retried with 205, on its turn rather than on every run.
      expect(await executeJob(job, database.db, later(20))).toBe("degraded");
      expect(requests).toEqual([
        [201, 202, 204, 205],
        [201, 202, 203, 206],
        [201, 202, 204, 205],
      ]);
      expect(await storedTimes(204)).toEqual({ lastCcuAt: minutesBefore(50), detailsAttemptedAt: later(20) });
      const runs = await database.db.select().from(jobRuns).orderBy(jobRuns.startedAt);
      expect(runs.map((run) => run.stats.missing)).toEqual([1, 0, 1]);
      expect(runs.map((run) => run.stats.missingSample)).toEqual([[204], [], [204]]);
      // Game 204's 50-minute-old details never count: the first run reports game 205's 40 minutes, the second run the
      // median of 203's 40 and 206's 20 minutes, the last game 205's details from the first run, 20 minutes before.
      expect(runs.map((run) => run.stats.medianTailDetailsMinutes)).toEqual([40, 30, 20]);
    });

    it("keeps the latest request time when an older overlapping run finishes last", async () => {
      const later = new Date(now.getTime() + 10 * 60_000);
      // Every active game is in the hot set, so both runs request game 204.
      const job = rotatingJob([204], playing.size);
      expect(await executeJob(job, database.db, later)).toBe("degraded");
      expect(await storedTimes(204)).toEqual({ lastCcuAt: minutesBefore(50), detailsAttemptedAt: later });
      // The older run requested the same games and finishes after the newer one.
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(requests.map((ids) => ids.includes(204))).toEqual([true, true]);
      expect(await storedTimes(204)).toEqual({ lastCcuAt: minutesBefore(50), detailsAttemptedAt: later });
      expect(await storedTimes(205)).toMatchObject({ detailsAttemptedAt: later });
    });
  });

  describe("without active games", () => {
    beforeEach(async () => {
      await database.db.delete(jobRuns);
      await database.db.delete(games);
    });

    it("marks the run degraded", async () => {
      let calls = 0;
      const job = createPollJob({
        roblox: {
          getGameDetails: async () => {
            calls += 1;
            return [];
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(calls).toBe(0);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({ active: 0, attempted: 0, returned: 0, failedBatches: 0, skipped: 0 });
    });
  });
});
