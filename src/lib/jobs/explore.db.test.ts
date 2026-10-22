import { randomUUID } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { discoveryCandidates, discoverySources, gameObservations, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { RobloxClient, type RobloxChartGame, type RobloxSearchPage, type RobloxSort } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { createExploreJob, type ExploreDependencies } from "./explore";
import { executeJob } from "./runner";

type Roblox = ExploreDependencies["roblox"];

function listed(universeId: number, playerCount: number): RobloxChartGame {
  return { universeId, rootPlaceId: universeId * 10, name: `Game ${universeId}`, playerCount };
}

function sort(sortId: string, chartGames: RobloxChartGame[]): RobloxSort {
  return { sortId, sortDisplayName: sortId, games: chartGames.map((game, index) => ({ ...game, position: index + 1 })), skipped: 0 };
}

function page(chartGames: RobloxChartGame[], nextPageToken: string | null = null): RobloxSearchPage {
  return { games: chartGames, nextPageToken };
}

// A game under the minimum CCU: the response is not empty, but nothing in it is a sighting.
const tiny = listed(99, 5);

function exploreJob(roblox: Partial<Roblox>, options: Omit<ExploreDependencies, "roblox"> = {}) {
  return createExploreJob({
    roblox: {
      getSortContent: async (sortId) => sort(sortId, [tiny]),
      getRecommendations: async () => [tiny],
      searchGames: async () => page([tiny]),
      ...roblox,
    },
    countries: ["us"],
    ...options,
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
    await database.db.delete(discoveryCandidates);
    await database.db.delete(jobRuns);
  });

  // A young game with `ccu` players in the seed window; a larger `ccu` ranks higher.
  async function youngGame(universeId: number, name: string, ccu: number) {
    await upsertGameDetails(database.db, [gameDetail(universeId, { name, created: new Date("2026-10-15T00:00:00Z") })], now);
    await writeGameObservations(database.db, [{ universeId, observedAt: new Date("2026-10-20T13:00:00Z"), ccu, visits: 2, favorites: 2 }]);
  }

  async function discoveries() {
    const rows = await database.db
      .select()
      .from(discoverySources)
      .orderBy(discoverySources.universeId, discoverySources.source, discoverySources.detail);
    return rows.map((row) => [row.universeId, row.source, row.detail]);
  }

  async function queued() {
    const rows = await database.db
      .select()
      .from(discoveryCandidates)
      .orderBy(discoveryCandidates.universeId, discoveryCandidates.source, discoveryCandidates.detail);
    return rows.map((row) => [row.universeId, row.source, row.detail, row.playerCount]);
  }

  async function lastRun() {
    const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
    return run;
  }

  it("queues the untracked games of country sorts, recommendations and two search pages, and records the tracked ones", async () => {
    await youngGame(1, "+1 Slinky Escape", 5_000);
    await youngGame(2, "[W4] +1 Paper Plane", 3_000);
    const getSortContent = vi.fn<Roblox["getSortContent"]>(async (sortId, country) =>
      sort(sortId, sortId === "up-and-coming" && country === "us" ? [listed(30, 2_400), listed(2, 3_000)] : [tiny]),
    );
    const getRecommendations = vi.fn<Roblox["getRecommendations"]>(async (seed) => (seed === "1" ? [listed(2, 3_000), listed(40, 380)] : [tiny]));
    const searchGames = vi.fn<Roblox["searchGames"]>(async (_term, pageToken) =>
      pageToken === undefined ? page([listed(1, 5_000), listed(50, 8_000), tiny], "page-2") : page([listed(51, 600)], "page-3"),
    );
    expect(await executeJob(exploreJob({ getSortContent, getRecommendations, searchGames }), database.db, now)).toBe("success");

    expect(getSortContent.mock.calls).toEqual([
      ["up-and-coming", "us"],
      ["top-trending", "us"],
    ]);
    expect(getRecommendations.mock.calls).toEqual([
      ["1", JOB_CONFIG.explore.recommendationsPerSeed],
      ["2", JOB_CONFIG.explore.recommendationsPerSeed],
    ]);
    // "+1" is the only word both titles share; its third page is beyond the pages read per term.
    expect(searchGames.mock.calls).toEqual([
      ["+1", undefined],
      ["+1", "page-2"],
    ]);
    // Poll promotes the untracked games: explore only queues them.
    expect(await queued()).toEqual([
      [30, "chart", "up-and-coming:us", 2_400],
      [40, "recommendation", "1", 380],
      [50, "search", "+1", 8_000],
      [51, "search", "+1", 600],
    ]);
    expect((await database.db.select({ universeId: games.universeId }).from(games)).map((game) => game.universeId).sort()).toEqual([1, 2]);
    // Tracked games are recorded: they show how games relate.
    expect(await discoveries()).toEqual([
      [1, "search", "+1"],
      [2, "chart", "up-and-coming:us"],
      [2, "recommendation", "1"],
    ]);
    expect((await lastRun()).stats).toMatchObject({
      seeds: 2,
      vocabulary: 1,
      terms: ["+1"],
      chart: { requests: 2, failures: 0, emptyResponses: 0, sightings: 2, rateLimited: false },
      recommendation: { requests: 2, failures: 0, emptyResponses: 0, sightings: 2, rateLimited: false },
      search: { requests: 2, failures: 0, emptyResponses: 0, sightings: 3, rateLimited: false },
      rateLimited: false,
      stoppedBy: null,
      queued: 4,
      discoveries: 3,
    });
  });

  it("succeeds with only the country sorts when no young game is active", async () => {
    const getRecommendations = vi.fn<Roblox["getRecommendations"]>(async () => [tiny]);
    const searchGames = vi.fn<Roblox["searchGames"]>(async () => page([tiny]));
    expect(await executeJob(exploreJob({ getRecommendations, searchGames }), database.db, now)).toBe("success");
    expect(getRecommendations).not.toHaveBeenCalled();
    expect(searchGames).not.toHaveBeenCalled();
    expect((await lastRun()).stats).toMatchObject({
      seeds: 0,
      vocabulary: 0,
      terms: [],
      chart: { requests: 2 },
      recommendation: { requests: 0 },
      search: { requests: 0 },
      queued: 0,
    });
  });

  it("searches the most shared words first, then puts the words it searched behind the others", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(2, "Steal a Moon Egg", 4_000);
    await youngGame(3, "Egg Chop", 3_000);
    await youngGame(4, "Chop Together", 2_000);
    const searchGames = vi.fn<Roblox["searchGames"]>(async () => page([tiny]));
    const job = exploreJob({ searchGames });
    expect(await executeJob(job, database.db, now)).toBe("success");
    // An hour later the three words were searched equally long ago, so the most shared still comes first.
    expect(await executeJob(job, database.db, new Date(now.getTime() + 60 * 60_000))).toBe("success");
    expect(searchGames.mock.calls.map(([term]) => term)).toEqual(["egg", "chop", "steal", "egg", "chop", "steal"]);

    // A word searched an hour ago waits behind one searched a day ago.
    await database.db.delete(jobRuns);
    const searchedAt = (hoursAgo: number, terms: string[]) =>
      database.db.insert(jobRuns).values({
        id: randomUUID(),
        job: "explore",
        slot: new Date(now.getTime() - hoursAgo * 3_600_000),
        status: "success",
        startedAt: now,
        stats: { terms },
      });
    await searchedAt(1, ["egg"]);
    await searchedAt(20, ["chop", "steal"]);
    searchGames.mockClear();
    expect(await executeJob(job, database.db, now)).toBe("success");
    // chop and steal: 2 titles × 20 hours; egg: 3 titles × 1 hour.
    expect(searchGames.mock.calls.map(([term]) => term)).toEqual(["chop", "steal", "egg"]);
  });

  it("starts no request after the deadline and keeps what it found", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(2, "Steal a Moon Egg", 4_000);
    let clockMs = 0;
    // Each search waits out its one-minute window in production; here each one takes 20 minutes of the 45.
    const searchGames = vi.fn<Roblox["searchGames"]>(async (term) => {
      clockMs += 20 * 60_000;
      return page([listed(term === "egg" ? 60 : 61, 900)], "next");
    });
    const job = exploreJob({ searchGames }, { clock: () => clockMs });
    expect(await executeJob(job, database.db, now)).toBe("success");
    // egg page 1 at 0, page 2 at 20, steal page 1 at 40; page 2 would start at 60.
    expect(searchGames.mock.calls).toEqual([
      ["egg", undefined],
      ["egg", "next"],
      ["steal", undefined],
    ]);
    expect(await queued()).toEqual([
      [60, "search", "egg", 900],
      [61, "search", "steal", 900],
    ]);
    // Each sighting is dated when its answer came: egg's pages at 20 and 40 minutes into the run, steal's at 60.
    const minutesIn = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    const windows = await database.db.select().from(discoveryCandidates).orderBy(discoveryCandidates.universeId);
    expect(windows.map((row) => [row.universeId, row.firstSeenAt, row.lastSeenAt])).toEqual([
      [60, minutesIn(20), minutesIn(40)],
      [61, minutesIn(60), minutesIn(60)],
    ]);
    expect((await lastRun()).stats).toMatchObject({ terms: ["egg", "steal"], stoppedBy: "deadline", queued: 2 });
  });

  it("tolerates a failing request", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(4, "Egg Obby", 3_000);
    const job = exploreJob({
      getRecommendations: async (seed) => {
        if (seed === "1") throw new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games/recommendations/game/1");
        return [listed(8, 600)];
      },
      searchGames: async () => page([listed(9, 800)]),
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await queued()).toEqual([
      [8, "recommendation", "4", 600],
      [9, "search", "egg", 800],
    ]);
    // Both titles share "egg"; "steal" is in one of the two.
    expect((await lastRun()).stats).toMatchObject({
      terms: ["egg"],
      recommendation: { requests: 2, failures: 1, emptyResponses: 0 },
      search: { requests: 1, failures: 0, emptyResponses: 0 },
    });
  });

  it("degrades the run when an endpoint fails or answers empty on every request, and keeps the others' finds", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(4, "Steal Egg Obby", 3_000);
    const job = exploreJob({
      getRecommendations: async () => [listed(8, 600)],
      searchGames: async (term) => {
        if (term === "egg") throw new Error("unavailable");
        return page([]);
      },
    });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await queued()).toEqual([
      [8, "recommendation", "1", 600],
      [8, "recommendation", "4", 600],
    ]);
    // A term whose first page failed is not counted as searched: the next run tries it first again.
    expect((await lastRun()).stats).toMatchObject({
      terms: ["steal"],
      search: { requests: 2, failures: 1, emptyResponses: 1 },
      rateLimited: false,
    });
  });

  it("stops an endpoint after a rate limit that outlasted the retries, and the others carry on", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(4, "Steal Egg Obby", 4_000);
    const getRecommendations = vi.fn<Roblox["getRecommendations"]>(async () => {
      throw new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games/recommendations/game/1");
    });
    const searchGames = vi.fn<Roblox["searchGames"]>(async (term) => {
      if (term === "steal") throw new HttpError(429, "Too Many Requests", "https://apis.roblox.com/search-api/omni-search");
      return page([listed(9, 800)]);
    });
    const job = exploreJob({ getRecommendations, searchGames });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(getRecommendations.mock.calls).toEqual([["1", JOB_CONFIG.explore.recommendationsPerSeed]]);
    expect(searchGames.mock.calls.map(([term]) => term)).toEqual(["egg", "steal"]);
    expect(await queued()).toEqual([[9, "search", "egg", 800]]);
    expect((await lastRun()).stats).toMatchObject({
      terms: ["egg"],
      recommendation: { requests: 1, failures: 1, rateLimited: true },
      search: { requests: 2, failures: 1, rateLimited: true },
      rateLimited: true,
    });
  });

  it("expands the recommendations while it reads the sorts, and searches once the sorts are read", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(4, "Egg Obby", 3_000);
    const events: string[] = [];
    let recommendationsDone = () => {};
    const recommended = new Promise<void>((resolve) => {
      recommendationsDone = resolve;
    });
    const job = exploreJob({
      // Each sort answers once the recommendations are done, or after a second if they have not started.
      getSortContent: async (sortId, country) => {
        await Promise.race([recommended, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        events.push(`sort ${sortId}:${country}`);
        return sort(sortId, [tiny]);
      },
      getRecommendations: async (seed) => {
        events.push(`recommendation ${seed}`);
        if (seed === "4") recommendationsDone();
        return [tiny];
      },
      searchGames: async (term) => {
        events.push(`search ${term}`);
        return page([tiny]);
      },
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(events).toEqual([
      "recommendation 1",
      "recommendation 4",
      "sort up-and-coming:us",
      "sort top-trending:us",
      "search egg",
    ]);
  });

  it("fails the run when the database fails while recording", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await database.db.execute(sql`alter table discovery_candidates rename to discovery_candidates_hidden`);
    try {
      const job = exploreJob({ getRecommendations: async () => [listed(2, 3_000)] });
      expect(await executeJob(job, database.db, now)).toBe("failed");
    } finally {
      await database.db.execute(sql`alter table discovery_candidates_hidden rename to discovery_candidates`);
    }
    expect((await lastRun()).error).toContain("discovery_candidates");
  });

  it("reads sorts, recommendations and search pages through the Roblox client", async () => {
    await youngGame(1, "Steal An Egg", 5_000);
    await youngGame(4, "Egg Obby", 3_000);
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(`${url.hostname}${url.pathname}?${url.searchParams.get("country") ?? url.searchParams.get("pageToken") ?? ""}`);
        if (url.pathname === "/explore-api/v1/get-sort-content") {
          const sortId = url.searchParams.get("sortId");
          return Response.json({ sortId, games: [{ universeId: 30, rootPlaceId: 300, name: "Rising Here", playerCount: 2_400 }] });
        }
        if (url.pathname.startsWith("/v1/games/recommendations/")) {
          return Response.json({ games: [{ universeId: 2, placeId: 20, name: "Break and Steal an Egg", playerCount: 3_000 }] });
        }
        const next = url.searchParams.get("pageToken") ? null : "page-2";
        return Response.json({
          searchResults: [{ contents: [{ contentType: "Game", universeId: next ? 3 : 5, rootPlaceId: 30, name: "Egg", playerCount: 900 }] }],
          nextPageToken: next,
        });
      }),
    );
    try {
      expect(await executeJob(createExploreJob({ roblox: new RobloxClient(), countries: ["us"] }), database.db, now)).toBe("success");
    } finally {
      vi.unstubAllGlobals();
    }
    // On apis.roblox.com the sorts come before the search; recommendations run beside them, each at its own pace.
    expect(requested.filter((request) => request.startsWith("apis.roblox.com"))).toEqual([
      "apis.roblox.com/explore-api/v1/get-sort-content?us",
      "apis.roblox.com/explore-api/v1/get-sort-content?us",
      "apis.roblox.com/search-api/omni-search?",
      "apis.roblox.com/search-api/omni-search?page-2",
    ]);
    expect(requested.filter((request) => request.startsWith("games.roblox.com"))).toEqual([
      "games.roblox.com/v1/games/recommendations/game/1?",
      "games.roblox.com/v1/games/recommendations/game/4?",
    ]);
    expect(await queued()).toEqual([
      [2, "recommendation", "1", 3_000],
      [2, "recommendation", "4", 3_000],
      [3, "search", "egg", 900],
      [5, "search", "egg", 900],
      [30, "chart", "top-trending:us", 2_400],
      [30, "chart", "up-and-coming:us", 2_400],
    ]);
    expect((await lastRun()).stats).toMatchObject({
      queued: 4,
      http: {
        attempts: 6,
        retries: 0,
        rateLimitedResponses: 0,
        endpointIntervalMs: { "games.roblox.com/v1/games/recommendations/game/*": 2_500 },
      },
    });
  });
});
