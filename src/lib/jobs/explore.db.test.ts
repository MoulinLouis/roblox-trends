import { desc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { discoverySources, gameObservations, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { RobloxClient, type RobloxChartGame } from "@/lib/api/roblox";
import { gameDetail } from "@/test/fixtures";
import { createExploreJob, type ExploreDependencies } from "./explore";
import { PromotionApiError } from "./promotion";
import { executeJob } from "./runner";

type Roblox = ExploreDependencies["roblox"];

const getGameDetails: Roblox["getGameDetails"] = async (ids) => ids.map((id) => gameDetail(Number(id)));

function listed(universeId: number, playerCount: number): RobloxChartGame {
  return { universeId, rootPlaceId: universeId * 10, name: `Game ${universeId}`, playerCount };
}

function exploreJob(roblox: Partial<Roblox>) {
  return createExploreJob({
    roblox: { getRecommendations: async () => [], searchGames: async () => [], getGameDetails, ...roblox },
  });
}

describe.skipIf(!hasTestDatabase)("explore job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:35:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    // Deleting games cascades to discovery_sources.
    await database.db.delete(games);
    await database.db.delete(gameObservations);
    await database.db.delete(jobRuns);
  });

  // A young game that went from 100 CCU a day ago to `ccu` now.
  async function risingGame(universeId: number, name: string, ccu: number) {
    await upsertGameDetails(database.db, [gameDetail(universeId, { name, created: new Date("2026-10-15T00:00:00Z") })], now);
    await writeGameObservations(database.db, [
      { universeId, observedAt: new Date("2026-10-19T12:00:00Z"), ccu: 100, visits: 1, favorites: 1 },
      { universeId, observedAt: new Date("2026-10-20T13:00:00Z"), ccu, visits: 2, favorites: 2 },
    ]);
  }

  async function discoveries() {
    const rows = await database.db
      .select()
      .from(discoverySources)
      .orderBy(discoverySources.universeId, discoverySources.source, discoverySources.detail);
    return rows.map((row) => [row.universeId, row.source, row.detail]);
  }

  async function lastRun() {
    const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
    return run;
  }

  it("explores recommendations of rising young games and records the seed", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    const getRecommendations = vi.fn<Roblox["getRecommendations"]>(async () => [listed(2, 3_000), listed(3, 5)]);
    const job = exploreJob({ getRecommendations });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(getRecommendations.mock.calls).toEqual([["1", 20]]);
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 2, source: "recommendation", detail: "1" }),
    ]);
    // The game below the minimum CCU is neither promoted nor recorded.
    expect((await database.db.select({ universeId: games.universeId }).from(games)).map((game) => game.universeId).sort()).toEqual([1, 2]);
  });

  it("searches the words rising titles share and records games already tracked", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    await risingGame(4, "Egg Obby", 3_000);
    const searchGames = vi.fn<Roblox["searchGames"]>(async () => [listed(1, 5_000), listed(9, 800), listed(10, 10)]);
    const job = exploreJob({
      getRecommendations: async (seed) => (seed === "1" ? [listed(4, 3_000)] : []),
      searchGames,
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(searchGames.mock.calls).toEqual([["egg"]]);
    expect(await discoveries()).toEqual([
      [1, "search", "egg"],
      [4, "recommendation", "1"],
      [9, "search", "egg"],
    ]);
    expect((await lastRun()).stats).toMatchObject({
      seeds: 2,
      terms: ["egg"],
      requests: 3,
      failures: 0,
      rateLimited: false,
      candidates: 3,
      promoted: 1,
      discoveries: 3,
    });
  });

  it("tolerates a failing request", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    await risingGame(4, "Egg Obby", 3_000);
    const job = exploreJob({
      getRecommendations: async (seed) => {
        if (seed === "1") throw new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games/recommendations/game/1");
        return [listed(8, 600)];
      },
      searchGames: async () => [listed(9, 800)],
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await discoveries()).toEqual([
      [8, "recommendation", "4"],
      [9, "search", "egg"],
    ]);
    expect((await lastRun()).stats).toMatchObject({ requests: 3, failures: 1, rateLimited: false });
  });

  it("degrades the run when an endpoint fails every request", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    const job = exploreJob({
      getRecommendations: async () => [listed(8, 600)],
      searchGames: async () => {
        throw new Error("unavailable");
      },
    });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
    // What the other endpoint found is still promoted.
    expect(await discoveries()).toEqual([[8, "recommendation", "1"]]);
    expect((await lastRun()).stats).toMatchObject({ terms: ["egg", "steal"], requests: 3, failures: 2, rateLimited: false, promoted: 1 });
  });

  it("stops an endpoint after a rate limit that outlasted the retries and degrades the run", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    await risingGame(4, "Egg Obby", 4_000);
    await risingGame(5, "Egg Farm", 3_000);
    const getRecommendations = vi.fn<Roblox["getRecommendations"]>(async () => {
      throw new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games/recommendations/game/1");
    });
    const job = exploreJob({ getRecommendations, searchGames: async () => [listed(9, 800)] });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
    // The search endpoint is separate, so it still runs.
    expect(getRecommendations.mock.calls).toEqual([["1", 20]]);
    expect(await discoveries()).toEqual([[9, "search", "egg"]]);
    expect((await lastRun()).stats).toMatchObject({
      seeds: 3,
      terms: ["egg"],
      requests: 2,
      failures: 1,
      skippedRequests: 2,
      rateLimited: true,
      promoted: 1,
    });
  });

  it("reports the error and degrades the run when promotion fails", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    const unavailable = new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games");
    const job = exploreJob({
      getRecommendations: async () => [listed(2, 3_000)],
      getGameDetails: async () => {
        throw unavailable;
      },
    });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await discoveries()).toEqual([]);
    expect((await lastRun()).stats).toMatchObject({ promoted: 0, promotionError: new PromotionApiError(unavailable).message });
  });

  it("fails the run when the database fails during promotion", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    // Recording the discovery is the last step of promotion, after the Games API answered.
    await database.db.execute(sql`alter table discovery_sources rename to discovery_sources_hidden`);
    try {
      const job = exploreJob({ getRecommendations: async () => [listed(2, 3_000)] });
      expect(await executeJob(job, database.db, now)).toBe("failed");
    } finally {
      await database.db.execute(sql`alter table discovery_sources_hidden rename to discovery_sources`);
    }
    expect((await lastRun()).error).toContain("discovery_sources");
  });

  it("reads recommendations and search results through the Roblox client", async () => {
    await risingGame(1, "Steal An Egg", 5_000);
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(`${url.hostname}${url.pathname}`);
        if (url.pathname.startsWith("/v1/games/recommendations/")) {
          return Response.json({ games: [{ universeId: 2, placeId: 20, name: "Break and Steal an Egg", playerCount: 3_000 }] });
        }
        if (url.pathname === "/search-api/omni-search") {
          const term = url.searchParams.get("searchQuery");
          return Response.json({
            searchResults: [{ contents: [{ contentType: "Game", universeId: term === "egg" ? 3 : 4, rootPlaceId: 30, name: "Egg", playerCount: 900 }] }],
          });
        }
        const ids = url.searchParams.get("universeIds")?.split(",") ?? [];
        return Response.json({ data: ids.map((id) => gameDetail(Number(id))) });
      }),
    );
    try {
      expect(await executeJob(createExploreJob({ roblox: new RobloxClient() }), database.db, now)).toBe("success");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(requested).toEqual([
      "games.roblox.com/v1/games/recommendations/game/1",
      "apis.roblox.com/search-api/omni-search",
      "apis.roblox.com/search-api/omni-search",
      "games.roblox.com/v1/games",
    ]);
    expect(await discoveries()).toEqual([
      [2, "recommendation", "1"],
      [3, "search", "egg"],
      [4, "search", "steal"],
    ]);
    expect((await lastRun()).stats).toMatchObject({ promoted: 3, http: { attempts: 4, retries: 0, rateLimitedResponses: 0 } });
  });
});
