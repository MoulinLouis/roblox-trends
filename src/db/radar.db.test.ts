import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RADAR_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { type RadarSort, type RisingGame, risingGames } from "./radar";
import { censusObservations, gameDailyLegacy, gameObservations, games, places } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
// as_of falls 30 minutes into an hour: the current window is the 24 whole hours before 12:00.
const asOf = new Date("2026-10-28T12:30:00Z");
const windowEnd = Date.parse("2026-10-28T12:00:00Z");
const week = 7 * 24;

describe.skipIf(!hasTestDatabase)("rising_games", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(gameObservations);
    await database.db.delete(censusObservations);
    await database.db.delete(gameDailyLegacy);
    await database.db.delete(places);
    await database.db.delete(games);
  });

  async function game(universeId: number, createdDaysBefore: number): Promise<void> {
    const created = new Date(asOf.getTime() - createdDaysBefore * dayMs);
    await upsertGameDetails(database.db, [gameDetail(universeId, { created })], new Date(created.getTime() + hourMs));
  }

  // One observation 10 minutes into each hour, from `from` down to `to` (exclusive) hours before the window end.
  async function hourly(universeId: number, from: number, to: number, ccu: number | ((hour: number) => number)) {
    const rows = [];
    for (let hour = from; hour > to; hour -= 1) {
      rows.push({
        universeId,
        observedAt: new Date(windowEnd - hour * hourMs + 10 * 60_000),
        ccu: typeof ccu === "number" ? ccu : ccu(hour),
        visits: 1_000,
        favorites: 10,
      });
    }
    await writeGameObservations(database.db, rows);
  }

  const current = (universeId: number, ccu: number | ((hour: number) => number)) => hourly(universeId, 24, 0, ccu);
  const previous = (universeId: number, ccu: number) => hourly(universeId, 48, 24, ccu);
  const weekAgo = (universeId: number, ccu: number) => hourly(universeId, week + 24, week, ccu);

  function query(sort: RadarSort, overrides: Partial<Parameters<typeof risingGames>[1]> = {}) {
    return risingGames(database.db, {
      asOf,
      maxAgeDays: 30,
      minimumCcu: 100,
      sort,
      limit: RADAR_CONFIG.pageSize,
      ...overrides,
    });
  }

  function byId(rows: RisingGame[]): Map<number, RisingGame> {
    return new Map(rows.map((row) => [row.universeId, row]));
  }

  // 1 is an old game that dominates the market; 2 is flat; 3 quadrupled its CCU; 4 is new; 5 was not tracked a week ago.
  async function market(): Promise<void> {
    await game(1, 200);
    await current(1, 10_000);
    await weekAgo(1, 10_000);
    await game(2, 20);
    await current(2, 1_000);
    await weekAgo(2, 1_000);
    await game(3, 20);
    await current(3, 2_000);
    await previous(3, 1_000);
    await weekAgo(3, 500);
    await game(4, 3);
    await current(4, 1_500);
    await game(5, 20);
    await current(5, 800);
  }

  it("ranks young games by weekday-safe growth, new games from zero, untracked ones last", async () => {
    await market();
    const rows = await query("growth");
    expect(rows.map((row) => row.universeId)).toEqual([4, 3, 2, 5]);
    const found = byId(rows);
    // Tracked CCU per hour: 15,300 now and 11,500 a week ago.
    expect(found.get(3)).toMatchObject({ ccuAverage: 2_000, samples: 24, previousSamples: 24, weekSamples: 24, dayGrowth: 2 });
    expect(found.get(3)?.weekGrowth).toBeCloseTo((2_000 / 15_300) / (500 / 11_500), 4);
    expect(found.get(3)?.weekGrowthScore).toBeCloseTo(Math.log(2_100 / ((500 / 11_500) * 15_300 + 100)), 4);
    expect(found.get(2)?.weekGrowth).toBeCloseTo(11_500 / 15_300, 4);
    expect(found.get(2)).toMatchObject({ dayGrowth: null, previousSamples: 0 });
    expect(found.get(4)).toMatchObject({ weekGrowth: null, weekSamples: 0 });
    expect(found.get(4)?.weekGrowthScore).toBeCloseTo(Math.log(1_600 / 100), 4);
    expect(found.get(5)).toMatchObject({ weekGrowth: null, weekGrowthScore: null });
  });

  it("sorts by acceleration, CCU or age, ending with the CCU then the universe id", async () => {
    await market();
    expect((await query("acceleration")).map((row) => row.universeId)).toEqual([3, 4, 2, 5]);
    expect((await query("ccu")).map((row) => row.universeId)).toEqual([3, 4, 2, 5]);
    // Games 2, 3 and 5 share their creation time: the CCU breaks the tie.
    expect((await query("age")).map((row) => row.universeId)).toEqual([4, 3, 2, 5]);
  });

  it("filters on the real age and on the average CCU of the window", async () => {
    await market();
    expect((await query("growth", { maxAgeDays: 14 })).map((row) => row.universeId)).toEqual([4]);
    expect((await query("growth", { minimumCcu: 1_600 })).map((row) => row.universeId)).toEqual([3]);
  });

  it("takes the freshest observation as the current CCU and never reads past as_of", async () => {
    await market();
    await writeGameObservations(database.db, [
      { universeId: 3, observedAt: new Date(windowEnd + 20 * 60_000), ccu: 2_500, visits: 1_000, favorites: 10 },
      { universeId: 3, observedAt: new Date(windowEnd + 40 * 60_000), ccu: 9_000, visits: 1_000, favorites: 10 },
    ]);
    expect(byId(await query("growth")).get(3)).toMatchObject({ ccuLast: 2_500, ccuPeak: 2_500 });
    // At the main window's start, the current window is the previous one of the main test, and the main window's
    // first observation (10 minutes later) is not read.
    const dayEarlier = byId(await query("growth", { asOf: new Date(windowEnd - dayMs) })).get(3);
    expect(dayEarlier).toMatchObject({ ccuAverage: 1_000, samples: 24, ccuLast: 1_000, ccuPeak: 1_000 });
  });

  it("counts the v1 daily peaks in the peak CCU", async () => {
    await market();
    await database.db.insert(gameDailyLegacy).values({
      universeId: 2,
      day: new Date(asOf.getTime() - 15 * dayMs),
      ccuAvg: 20_000,
      ccuPeak: 50_000,
      visits: 1,
      favorites: 1,
    });
    expect(byId(await query("growth")).get(2)?.ccuPeak).toBe(50_000);
  });

  it("flags an hourly peak far above the window's median as an event", async () => {
    await game(6, 10);
    await current(6, (hour) => (hour === 5 ? 4_000 : 1_000));
    await game(7, 10);
    await current(7, 1_000);
    // Too few hours to tell an event from noise.
    await game(8, 10);
    await hourly(8, 6, 0, (hour) => (hour === 3 ? 9_000 : 1_000));
    const rows = byId(await query("ccu"));
    expect(rows.get(6)).toMatchObject({ isEvent: true, windowPeak: 4_000, windowMedian: 1_000 });
    expect(rows.get(7)?.isEvent).toBe(false);
    expect(rows.get(8)?.isEvent).toBe(false);
  });

  it("measures velocity from the first reading below each threshold, census included", async () => {
    await game(9, 5);
    await savePlaceResolution(database.db, { placeId: 90, universeId: 9, resolvedAt: asOf, error: null });
    await writeCensusObservations(database.db, [
      { placeId: 90, observedAt: new Date(windowEnd - 60 * hourMs), ccu: 50 },
      { placeId: 90, observedAt: new Date(windowEnd - 58 * hourMs), ccu: 150 },
    ]);
    await hourly(9, 50, 49, 1_200);
    await hourly(9, 30, 29, 12_000);
    await current(9, 8_000);
    // First seen above the middle threshold: neither velocity is known.
    await game(10, 5);
    await current(10, 3_000);
    const rows = byId(await query("ccu"));
    expect(rows.get(9)).toMatchObject({ firstSeenCcu: 50, hoursToMiddle: 8, hoursToEnd: 20 });
    expect(rows.get(10)).toMatchObject({ firstSeenCcu: 3_000, hoursToMiddle: null, hoursToEnd: null });
  });
});
