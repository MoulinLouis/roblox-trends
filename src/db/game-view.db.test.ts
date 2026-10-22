import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { createDatabase } from "./client";
import { upsertGameDetails } from "./games";
import { readGameView } from "./game-view";
import { writeChartPlacements, writeGameObservations, writeVoteObservations } from "./observations";
import { chartPlacements, discoverySources, gameObservations, games, voteObservations } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const hourMs = 60 * 60 * 1000;
const now = new Date("2026-10-21T12:00:00Z");
const firstSeen = new Date("2026-10-20T10:00:00Z");

describe.skipIf(!hasTestDatabase)("readGameView", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(gameObservations);
    await database.db.delete(voteObservations);
    await database.db.delete(chartPlacements);
    // Deleting games cascades to discovery_sources and game_versions.
    await database.db.delete(games);
  });

  async function fixture(): Promise<void> {
    const created = new Date("2026-10-01T00:00:00Z");
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Game 1", created })], firstSeen);
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Game 1 [UPD]", created })], new Date("2026-10-21T10:00:00Z"));
    await database.db.insert(discoverySources).values({
      universeId: 1,
      source: "chart",
      detail: "top-trending",
      firstSeenAt: firstSeen,
      lastSeenAt: now,
    });
    // An old observation outside the 14-day curve and the 7-day engagement window, then 48 hours at 1,000 CCU with
    // 2,000 new visits and 10 new favorites per hour.
    const rows = [{ universeId: 1, observedAt: new Date("2026-10-01T06:00:00Z"), ccu: 300, visits: 50_000, favorites: 4_000 }];
    for (let hour = 0; hour <= 48; hour += 1) {
      rows.push({
        universeId: 1,
        observedAt: new Date(Date.parse("2026-10-19T00:00:00Z") + hour * hourMs),
        ccu: 1_000,
        visits: 100_000 + hour * 2_000,
        favorites: 5_000 + hour * 10,
      });
    }
    await writeGameObservations(database.db, rows);
    await writeVoteObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-10-20T00:00:00Z"), upVotes: 900, downVotes: 100 },
      { universeId: 1, observedAt: new Date("2026-10-21T00:00:00Z"), upVotes: 950, downVotes: 50 },
    ]);
    await writeChartPlacements(database.db, [
      { sortId: "top-earning", universeId: 1, observedAt: new Date("2026-10-15T08:00:00Z"), rank: 5, playerCount: 1_000, isSponsored: false },
      { sortId: "top-earning", universeId: 1, observedAt: new Date("2026-10-20T23:00:00Z"), rank: 12, playerCount: 1_000, isSponsored: false },
      { sortId: "top-playing-now", universeId: 1, observedAt: new Date("2026-10-21T11:00:00Z"), rank: 30, playerCount: 1_000, isSponsored: false },
    ]);
  }

  it("returns null for an unknown game", async () => {
    expect(await readGameView(database.db, 999, now)).toBeNull();
  });

  it("gathers the game, its curves, versions, charts, votes and engagement window", async () => {
    await fixture();
    const view = await readGameView(database.db, 1, now);
    expect(view?.game).toMatchObject({ universeId: 1, name: "Game 1 [UPD]", firstObservedAt: firstSeen });
    expect(view?.discovery).toEqual({ source: "chart", detail: "top-trending", firstSeenAt: firstSeen });
    expect(view?.recent).toHaveLength(49);
    expect(view?.recent[0]).toEqual({ at: new Date("2026-10-19T00:00:00Z"), ccu: 1_000 });
    expect(view?.daily.map((day) => [day.day.toISOString().slice(0, 10), day.peak, day.origin])).toEqual([
      ["2026-10-01", 300, "observed"],
      ["2026-10-19", 1_000, "observed"],
      ["2026-10-20", 1_000, "observed"],
      ["2026-10-21", 1_000, "observed"],
    ]);
    // upsertGameDetails records the first metadata version when it inserts a game (games.db.test.ts), so the original
    // title comes before the update.
    expect(view?.versions.filter((version) => version.kind === "metadata").map((version) => version.name)).toEqual([
      "Game 1",
      "Game 1 [UPD]",
    ]);
    expect(view?.votes).toEqual({ upVotes: 950, downVotes: 50, observedAt: new Date("2026-10-21T00:00:00Z") });
    expect(view?.charts).toEqual([
      {
        sortId: "top-earning",
        firstSeenAt: new Date("2026-10-15T08:00:00Z"),
        lastSeenAt: new Date("2026-10-20T23:00:00Z"),
        bestRank: 5,
        bestRankRecent: 12,
        hoursRecent: 2,
      },
      {
        sortId: "top-playing-now",
        firstSeenAt: new Date("2026-10-21T11:00:00Z"),
        lastSeenAt: new Date("2026-10-21T11:00:00Z"),
        bestRank: 30,
        bestRankRecent: 30,
        hoursRecent: 1,
      },
    ]);
    expect(view?.engagement).toEqual({
      firstAt: new Date("2026-10-19T00:00:00Z"),
      lastAt: new Date("2026-10-21T00:00:00Z"),
      firstVisits: 100_000,
      lastVisits: 196_000,
      firstFavorites: 5_000,
      lastFavorites: 5_480,
      ccuAverage: 1_000,
    });
  });

  // Windows are 24-hour days: in a Paris session, the 7 days before a time just after the switch back to winter time
  // (2026-10-25) would otherwise start an hour early and include the readings at 11:30.
  it("keeps its windows in a session time zone with daylight saving", async () => {
    const afterSwitch = new Date("2026-10-26T12:00:00Z");
    await upsertGameDetails(database.db, [gameDetail(2)], new Date("2026-10-19T00:00:00Z"));
    await writeGameObservations(database.db, [
      { universeId: 2, observedAt: new Date("2026-10-19T11:30:00Z"), ccu: 100, visits: 1_000, favorites: 10 },
      { universeId: 2, observedAt: new Date("2026-10-20T12:00:00Z"), ccu: 100, visits: 2_000, favorites: 20 },
    ]);
    await writeChartPlacements(database.db, [
      { sortId: "top-revisited", universeId: 2, observedAt: new Date("2026-10-19T11:30:00Z"), rank: 8, playerCount: 100, isSponsored: false },
      { sortId: "top-revisited", universeId: 2, observedAt: new Date("2026-10-25T12:00:00Z"), rank: 9, playerCount: 100, isSponsored: false },
    ]);
    const paris = createDatabase(database.url, { maxConnections: 1, applicationName: "radar-test", settings: { TimeZone: "Europe/Paris" } });
    try {
      const view = await readGameView(paris.db, 2, afterSwitch);
      expect(view?.engagement).toMatchObject({ firstAt: new Date("2026-10-20T12:00:00Z"), firstVisits: 2_000 });
      expect(view?.charts).toMatchObject([{ sortId: "top-revisited", hoursRecent: 1 }]);
    } finally {
      await paris.pool.end();
    }
  });
});
