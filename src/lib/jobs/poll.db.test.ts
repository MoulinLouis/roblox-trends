import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { gameObservations, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { JOB_CONFIG } from "@/lib/config";
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

    it("writes one observation per returned game in the five-minute slot", async () => {
      const job = createPollJob({
        roblox: { getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id), { playing: 700 })) },
      });
      expect(await executeJob(job, database.db, now)).toBe("success");
      const rows = await database.db.select().from(gameObservations);
      expect(rows.map((row) => [row.universeId, row.ccu, row.observedAt.toISOString()]).sort()).toEqual([
        [1, 700, "2026-10-20T14:05:00.000Z"],
        [2, 700, "2026-10-20T14:05:00.000Z"],
      ]);
    });

    it("marks a run degraded when games are missing from the response", async () => {
      const job = createPollJob({
        roblox: { getGameDetails: async (ids) => ids.slice(0, 1).map((id) => gameDetail(Number(id))) },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
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
      expect(run.stats).toMatchObject({ active: 60, attempted: 50, returned: 50, failedBatches: 0, skipped: 10 });
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
