import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { selectRisingSeeds, type RisingSeedOptions } from "./explore";
import { upsertGameDetails } from "./games";
import { writeGameObservations } from "./observations";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const options: RisingSeedOptions = {
  count: 20,
  maximumAgeDays: 60,
  currentWindowHours: 6,
  previousWindowOffsetHours: 24,
  smoothingCcu: 100,
  minimumCurrentCcu: 150,
};

describe.skipIf(!hasTestDatabase)("selectRisingSeeds", () => {
  let database: TestDatabase;
  // The current window holds the hourly buckets after 08:35 up to 14:35 today; the previous one, the same buckets
  // yesterday.
  const now = new Date("2026-10-20T14:35:00Z");
  const growth = (current: number, previous: number) => expect.closeTo(Math.log((current + 100) / (previous + 100)), 9);

  beforeAll(async () => {
    database = await createTestDatabase();
    const young = new Date("2026-10-01T00:00:00Z");
    // Tracked since two days ago, so a missing value a day ago means the game had no players then.
    await upsertGameDetails(database.db, [
      gameDetail(1, { name: "Small Riser", created: young }),
      gameDetail(2, { name: "Big Riser", created: young }),
      gameDetail(3, { name: "Falling", created: young }),
      gameDetail(4, { name: "Old Hit", created: new Date("2025-01-01T00:00:00Z") }),
      gameDetail(5, { name: "Below Minimum", created: young }),
      gameDetail(6, { name: "Tracked Without Players", created: young }),
      gameDetail(9, { name: "Future Only", created: young }),
      gameDetail(10, { name: "Quiet Now", created: young }),
      gameDetail(11, { name: "Before Yesterday's Window", created: young }),
      gameDetail(12, { name: "After Yesterday's Window", created: young }),
      gameDetail(13, { name: "Seven Weeks Old", created: new Date("2026-09-01T00:00:00Z") }),
    ], new Date("2026-10-18T14:00:00Z"));
    // Game 7 did not exist a day ago. Game 8 has existed for weeks but was found only this morning: its CCU a day
    // ago is unknown.
    await upsertGameDetails(database.db, [
      gameDetail(7, { name: "Just Created", created: new Date("2026-10-20T00:00:00Z") }),
      gameDetail(8, { name: "Unknown Baseline", created: young }),
    ], new Date("2026-10-20T10:00:00Z"));
    const at = (iso: string, universeId: number, ccu: number) => ({ universeId, observedAt: new Date(iso), ccu, visits: 1, favorites: 1 });
    await writeGameObservations(database.db, [
      at("2026-10-19T12:00:00Z", 1, 200),
      at("2026-10-20T13:00:00Z", 1, 2_000),
      at("2026-10-19T12:00:00Z", 2, 10_000),
      at("2026-10-20T13:00:00Z", 2, 12_000),
      at("2026-10-19T13:00:00Z", 3, 1_000),
      at("2026-10-20T13:00:00Z", 3, 200),
      at("2026-10-20T13:00:00Z", 4, 10_000),
      at("2026-10-20T13:00:00Z", 5, 140),
      at("2026-10-20T13:00:00Z", 6, 500),
      at("2026-10-20T13:00:00Z", 7, 400),
      at("2026-10-20T13:00:00Z", 8, 3_000),
      // After `now`: a replay of an earlier hour must not see it.
      at("2026-10-20T15:10:00Z", 9, 5_000),
      // The 08:00 bucket ends before the current window.
      at("2026-10-20T08:20:00Z", 10, 9_000),
      // Buckets just outside the previous window do not count against the growth.
      at("2026-10-19T08:20:00Z", 11, 3_000),
      at("2026-10-20T12:00:00Z", 11, 2_000),
      at("2026-10-19T15:00:00Z", 12, 4_000),
      // Two hours of the current window average to 1,000.
      at("2026-10-20T10:00:00Z", 12, 800),
      at("2026-10-20T11:00:00Z", 12, 1_200),
      at("2026-10-20T12:00:00Z", 13, 800),
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("ranks growing young games by their smoothed CCU growth over the last day", async () => {
    expect(await selectRisingSeeds(database.db, now, options)).toEqual([
      { universeId: 11, name: "Before Yesterday's Window", currentCcu: 2_000, previousCcu: 0, growth: growth(2_000, 0) },
      { universeId: 12, name: "After Yesterday's Window", currentCcu: 1_000, previousCcu: 0, growth: growth(1_000, 0) },
      { universeId: 13, name: "Seven Weeks Old", currentCcu: 800, previousCcu: 0, growth: growth(800, 0) },
      { universeId: 1, name: "Small Riser", currentCcu: 2_000, previousCcu: 200, growth: growth(2_000, 200) },
      { universeId: 6, name: "Tracked Without Players", currentCcu: 500, previousCcu: 0, growth: growth(500, 0) },
      { universeId: 7, name: "Just Created", currentCcu: 400, previousCcu: 0, growth: growth(400, 0) },
      { universeId: 2, name: "Big Riser", currentCcu: 12_000, previousCcu: 10_000, growth: growth(12_000, 10_000) },
    ]);
  });

  it("ranks a small game that grew tenfold above a large one that grew a fifth", async () => {
    const ranked = (await selectRisingSeeds(database.db, now, options)).map((seed) => seed.universeId);
    expect(ranked.indexOf(1)).toBeLessThan(ranked.indexOf(2));
  });

  it("counts a missing value a day ago as zero only for a game tracked or not yet created then", async () => {
    const ranked = (await selectRisingSeeds(database.db, now, options)).map((seed) => seed.universeId);
    expect(ranked).toEqual(expect.arrayContaining([6, 7]));
    expect(ranked).not.toContain(8);
  });

  it("ignores falling games, quiet games, old games and observations after now", async () => {
    const ranked = (await selectRisingSeeds(database.db, now, options)).map((seed) => seed.universeId);
    for (const universeId of [3, 4, 5, 9, 10]) expect(ranked).not.toContain(universeId);
  });

  it("keeps the largest growth and honours the maximum age", async () => {
    expect((await selectRisingSeeds(database.db, now, { ...options, count: 2 })).map((seed) => seed.universeId)).toEqual([11, 12]);
    expect((await selectRisingSeeds(database.db, now, { ...options, maximumAgeDays: 30 })).map((seed) => seed.universeId)).toEqual([
      11, 12, 1, 6, 7, 2,
    ]);
  });
});
