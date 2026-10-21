import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { games, jobRuns, voteObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { JOB_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createVotesJob } from "./votes";

const { batchSize, maximumConsecutiveFailedBatches } = JOB_CONFIG.votes;

function votesFor(ids: string[]) {
  return ids.map((id) => ({ id: Number(id), upVotes: 90, downVotes: 10 }));
}

describe.skipIf(!hasTestDatabase)("votes job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:20:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function votedUniverses(): Promise<number[]> {
    const rows = await database.db.select({ universeId: voteObservations.universeId }).from(voteObservations);
    return rows.map((row) => row.universeId).sort((left, right) => left - right);
  }

  describe("with one busy game", () => {
    beforeAll(async () => {
      await upsertGameDetails(database.db, [gameDetail(1, { playing: 500 })], now);
    });

    it("writes hourly vote totals for active games", async () => {
      const job = createVotesJob({ roblox: { getGameVotes: async (ids) => votesFor(ids) } });
      expect(await executeJob(job, database.db, now)).toBe("success");
      expect(await database.db.select().from(voteObservations)).toEqual([
        { universeId: 1, observedAt: new Date("2026-10-20T14:00:00Z"), upVotes: 90, downVotes: 10 },
      ]);
    });
  });

  describe("with more busy games than one batch", () => {
    // One batch more than the repeated-failure stop allows, so that stop skips games. Priorities fall from 1,899
    // (universe 101) onwards, so the first batch holds the lowest universe ids.
    const universeIds = Array.from({ length: (maximumConsecutiveFailedBatches + 1) * batchSize }, (_, index) => 101 + index);
    const firstBatch = universeIds.slice(0, batchSize);

    beforeEach(async () => {
      await database.db.delete(voteObservations);
      await database.db.delete(jobRuns);
      await database.db.delete(games);
      await upsertGameDetails(database.db, universeIds.map((id) => gameDetail(id, { playing: 2_000 - id })), now);
    });

    it("stops at a rate limit that outlasted the retries and writes no votes", async () => {
      let calls = 0;
      const job = createVotesJob({
        roblox: {
          // Only the first batch is rate limited: a run that went on would store the next ones.
          getGameVotes: async (ids) => {
            calls += 1;
            if (calls === 1) throw new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games/votes");
            return votesFor(ids);
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(calls).toBe(1);
      expect(await votedUniverses()).toEqual([]);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: universeIds.length,
        attempted: batchSize,
        returned: 0,
        failedBatches: 1,
        skipped: universeIds.length - batchSize,
        stoppedBy: "error",
        rateLimited: true,
      });
    });

    it("stops after repeated batch failures and skips the remaining games", async () => {
      let calls = 0;
      const job = createVotesJob({
        roblox: {
          getGameVotes: async () => {
            calls += 1;
            throw new Error("socket hang up");
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(calls).toBe(maximumConsecutiveFailedBatches);
      expect(await votedUniverses()).toEqual([]);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: universeIds.length,
        attempted: maximumConsecutiveFailedBatches * batchSize,
        returned: 0,
        failedBatches: maximumConsecutiveFailedBatches,
        skipped: universeIds.length - maximumConsecutiveFailedBatches * batchSize,
        stoppedBy: "repeatedFailures",
        rateLimited: false,
      });
    });

    it("keeps the batches it finished when the run exceeds its timeout", async () => {
      let calls = 0;
      const job = createVotesJob({
        roblox: {
          // The second batch never answers, like a request stuck in its retries.
          getGameVotes: async (ids) => {
            calls += 1;
            if (calls > 1) return new Promise(() => undefined);
            return votesFor(ids);
          },
        },
      });
      expect(await executeJob({ ...job, timeoutMs: 1_000 }, database.db, now)).toBe("failed");
      expect(calls).toBe(2);
      expect(await votedUniverses()).toEqual(firstBatch);
    });
  });

  describe("without active games", () => {
    beforeEach(async () => {
      await database.db.delete(jobRuns);
      await database.db.delete(games);
    });

    it("marks the run degraded", async () => {
      let calls = 0;
      const job = createVotesJob({
        roblox: {
          getGameVotes: async () => {
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
