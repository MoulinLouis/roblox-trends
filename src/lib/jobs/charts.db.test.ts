import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chartPlacements, discoverySources, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import type { RobloxChartGame, RobloxSort } from "@/lib/api/roblox";
import { gameDetail } from "@/test/fixtures";
import { createChartsJob, type ChartsDependencies } from "./charts";
import { PromotionApiError } from "./promotion";
import { executeJob } from "./runner";

const getGameDetails: ChartsDependencies["roblox"]["getGameDetails"] = async (ids) => ids.map((id) => gameDetail(Number(id)));

function chartGame(universeId: number, overrides: Partial<RobloxChartGame> = {}): RobloxChartGame {
  return { universeId, rootPlaceId: universeId * 10, name: `Game ${universeId}`, playerCount: 100, ...overrides };
}

// The games are listed in order, after `skipped` malformed entries the parser dropped.
function sortOf(sortId: string, games: RobloxChartGame[], skipped = 0): RobloxSort {
  return { sortId, sortDisplayName: sortId, games: games.map((game, index) => ({ ...game, position: skipped + index + 1 })), skipped };
}

type Listing = RobloxChartGame[] | { games: RobloxChartGame[]; skipped: number } | Error;

// One entry per sort, in collection order: the games it lists, or the error its request throws.
function chartsJob(listings: Record<string, Listing>, roblox: Partial<ChartsDependencies["roblox"]> = {}) {
  return createChartsJob({
    sortIds: Object.keys(listings),
    roblox: {
      getSortContent: async (sortId) => {
        const listing = listings[sortId];
        if (listing instanceof Error) throw listing;
        return Array.isArray(listing) ? sortOf(sortId, listing) : sortOf(sortId, listing.games, listing.skipped);
      },
      getGameDetails,
      ...roblox,
    },
  });
}

describe.skipIf(!hasTestDatabase)("charts job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(chartPlacements);
    await database.db.delete(discoverySources);
    await database.db.delete(games);
    await database.db.delete(jobRuns);
  });

  async function storedUniverses(sortId: string, observedAt: Date): Promise<number[]> {
    const rows = await database.db
      .select({ universeId: chartPlacements.universeId })
      .from(chartPlacements)
      .where(and(eq(chartPlacements.sortId, sortId), eq(chartPlacements.observedAt, observedAt)));
    return rows.map((row) => row.universeId).sort((left, right) => left - right);
  }

  async function lastRun() {
    const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
    return run;
  }

  it("stores placements, promotes new games and tolerates one failing sort", async () => {
    const job = createChartsJob({
      sortIds: ["top-trending", "up-and-coming", "top-earning", "top-rated", "most-popular"],
      roblox: {
        getSortContent: async (sortId) => {
          if (sortId === "top-rated") throw new Error("unavailable");
          return sortOf(sortId, [{ universeId: 7, rootPlaceId: 70, name: "Seven", playerCount: 900 }]);
        },
        getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id))),
      },
    });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("success");
    expect(await database.db.select().from(chartPlacements)).toHaveLength(4);
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([7]);
    expect((await database.db.select().from(discoverySources)).map((row) => row.detail).sort()).toEqual([
      "most-popular",
      "top-earning",
      "top-trending",
      "up-and-coming",
    ]);
    const [placement] = await database.db.select().from(chartPlacements).where(eq(chartPlacements.sortId, "top-trending"));
    expect(placement).toEqual({
      sortId: "top-trending",
      universeId: 7,
      observedAt: new Date("2026-10-20T14:00:00Z"),
      rank: 1,
      playerCount: 900,
      isSponsored: null,
    });
    expect((await lastRun()).stats).toMatchObject({ sorts: 5, failedSorts: 1, placements: 4, promotionRequested: 1, promoted: 1 });
  });

  it("replaces the whole slot of a sort when the same hour is collected again", async () => {
    const lists: Record<number, number[]> = { 1: [7, 8], 2: [7] };
    let attempt = 0;
    const job = createChartsJob({
      sortIds: ["up-and-coming"],
      roblox: {
        getSortContent: async (sortId) => {
          attempt += 1;
          return sortOf(sortId, lists[attempt].map((universeId) => chartGame(universeId)));
        },
        getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id))),
      },
    });
    const at = new Date("2026-10-20T15:02:00Z");
    await executeJob(job, database.db, at);
    await executeJob(job, database.db, at);
    const rows = await database.db
      .select()
      .from(chartPlacements)
      .where(and(eq(chartPlacements.sortId, "up-and-coming"), eq(chartPlacements.observedAt, new Date("2026-10-20T15:00:00Z"))));
    expect(rows.map((row) => row.universeId)).toEqual([7]);
  });

  it("stores the sponsored flag of each placement", async () => {
    const job = chartsJob({ "top-trending": [chartGame(7, { isSponsored: true }), chartGame(8, { isSponsored: false }), chartGame(9)] });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("success");
    const rows = await database.db
      .select({ universeId: chartPlacements.universeId, rank: chartPlacements.rank, isSponsored: chartPlacements.isSponsored })
      .from(chartPlacements)
      .orderBy(chartPlacements.rank);
    expect(rows).toEqual([
      { universeId: 7, rank: 1, isSponsored: true },
      { universeId: 8, rank: 2, isSponsored: false },
      { universeId: 9, rank: 3, isSponsored: null },
    ]);
  });

  it("degrades when fewer sorts than the minimum share answer", async () => {
    const job = chartsJob({
      "top-trending": [chartGame(7)],
      "up-and-coming": new Error("unavailable"),
      "top-earning": [chartGame(8)],
      "top-rated": new Error("unavailable"),
      "most-popular": [chartGame(9)],
    });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("degraded");
    expect(await database.db.select().from(chartPlacements)).toHaveLength(3);
    expect((await lastRun()).stats).toMatchObject({ sorts: 5, failedSorts: 2, placements: 3, promoted: 3 });
  });

  it("counts an empty sort as failed and keeps what an earlier attempt of the hour stored", async () => {
    const at = new Date("2026-10-20T14:02:00Z");
    const slot = new Date("2026-10-20T14:00:00Z");
    expect(await executeJob(chartsJob({ "top-trending": [chartGame(7), chartGame(8)] }), database.db, at)).toBe("success");
    expect(await executeJob(chartsJob({ "top-trending": [] }), database.db, at)).toBe("degraded");
    expect(await storedUniverses("top-trending", slot)).toEqual([7, 8]);
    expect((await lastRun()).stats).toMatchObject({ sorts: 1, failedSorts: 1, placements: 0 });
  });

  it("counts a sort with too many malformed entries as failed and keeps what an earlier attempt stored", async () => {
    const at = new Date("2026-10-20T14:02:00Z");
    const slot = new Date("2026-10-20T14:00:00Z");
    expect(await executeJob(chartsJob({ "top-trending": [chartGame(7)], "up-and-coming": [chartGame(8)] }), database.db, at)).toBe("success");
    const job = chartsJob({
      // 1 malformed entry out of 5 is exactly the maximum share of 0.2: the sort is stored.
      "top-trending": { games: [chartGame(7), chartGame(9), chartGame(10), chartGame(11)], skipped: 1 },
      // 1 out of 4 is above it.
      "up-and-coming": { games: [chartGame(12), chartGame(13), chartGame(14)], skipped: 1 },
    });
    expect(await executeJob(job, database.db, at)).toBe("degraded");
    expect(await storedUniverses("top-trending", slot)).toEqual([7, 9, 10, 11]);
    expect(await storedUniverses("up-and-coming", slot)).toEqual([8]);
    expect((await lastRun()).stats).toMatchObject({ failedSorts: 1, skippedItems: 2, placements: 4 });
  });

  it("keeps the placements and reports the error when promotion fails", async () => {
    const unavailable = new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games");
    const job = chartsJob(
      { "top-trending": [chartGame(7)] },
      {
        getGameDetails: async () => {
          throw unavailable;
        },
      },
    );
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("degraded");
    expect(await storedUniverses("top-trending", new Date("2026-10-20T14:00:00Z"))).toEqual([7]);
    expect(await database.db.select().from(games)).toEqual([]);
    expect((await lastRun()).stats).toMatchObject({
      failedSorts: 0,
      placements: 1,
      promotionRequested: 1,
      promoted: 0,
      // The message of the wrapper already holds its cause once.
      promotionError: new PromotionApiError(unavailable).message,
    });
  });

  it("fails the run when the database fails during promotion", async () => {
    // Recording the discovery is the last step of promotion, after the Games API answered.
    await database.db.execute(sql`alter table discovery_sources rename to discovery_sources_hidden`);
    try {
      expect(await executeJob(chartsJob({ "top-trending": [chartGame(7)] }), database.db, new Date("2026-10-20T14:02:00Z"))).toBe("failed");
    } finally {
      await database.db.execute(sql`alter table discovery_sources_hidden rename to discovery_sources`);
    }
    expect((await lastRun()).error).toContain("discovery_sources");
  });

  it("fails the run when placements cannot be stored", async () => {
    // A player count beyond the integer column makes the insert fail in the database, not in the API call.
    const job = chartsJob({ "top-trending": [chartGame(7, { playerCount: 3_000_000_000 })], "up-and-coming": [chartGame(8)] });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("failed");
    expect(await database.db.select().from(chartPlacements)).toEqual([]);
    expect((await lastRun()).error).toMatch(/out of range/);
  });

  it("keeps the sorts it stored when the run exceeds its timeout", async () => {
    const job = createChartsJob({
      sortIds: ["top-trending", "up-and-coming"],
      roblox: {
        // The second sort never answers, like a request stuck in its retries.
        getSortContent: async (sortId) =>
          sortId === "top-trending" ? sortOf(sortId, [chartGame(7)]) : new Promise(() => undefined),
        getGameDetails,
      },
    });
    expect(await executeJob({ ...job, timeoutMs: 1_000 }, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("failed");
    expect(await storedUniverses("top-trending", new Date("2026-10-20T14:00:00Z"))).toEqual([7]);
  });
});
