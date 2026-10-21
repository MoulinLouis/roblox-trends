import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { games, jobRuns, voteObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { JOB_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createVotesJob } from "./votes";

describe.skipIf(!hasTestDatabase)("votes job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:20:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe("with one busy game", () => {
    beforeAll(async () => {
      await upsertGameDetails(database.db, [gameDetail(1, { playing: 500 })], now);
    });

    it("writes hourly vote totals for active games", async () => {
      const job = createVotesJob({
        roblox: { getGameVotes: async (ids) => ids.map((id) => ({ id: Number(id), upVotes: 90, downVotes: 10 })) },
      });
      expect(await executeJob(job, database.db, now)).toBe("success");
      const [row] = await database.db.select().from(voteObservations);
      expect(row).toEqual({ universeId: 1, observedAt: new Date("2026-10-20T14:00:00Z"), upVotes: 90, downVotes: 10 });
    });
  });

  describe("with more busy games than one batch", () => {
    const universeIds = Array.from({ length: 60 }, (_, index) => 101 + index);

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
          // Only the first batch is rate limited: a run that went on would store the second one.
          getGameVotes: async (ids) => {
            calls += 1;
            if (calls === 1) throw new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games/votes");
            return ids.map((id) => ({ id: Number(id), upVotes: 90, downVotes: 10 }));
          },
        },
      });
      expect(await executeJob(job, database.db, now)).toBe("degraded");
      expect(calls).toBe(1);
      expect(await database.db.select().from(voteObservations)).toEqual([]);
      const [run] = await database.db.select().from(jobRuns);
      expect(run.stats).toMatchObject({
        active: 60,
        attempted: JOB_CONFIG.votes.batchSize,
        returned: 0,
        failedBatches: 1,
        skipped: 60 - JOB_CONFIG.votes.batchSize,
        stoppedBy: "error",
        rateLimited: true,
      });
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
      expect(run.stats).toMatchObject({ active: 0, attempted: 0, returned: 0 });
    });
  });
});
