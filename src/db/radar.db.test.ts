import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RADAR_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { createDatabase, type Database } from "./client";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { type RadarSort, type RisingGame, risingGames } from "./radar";
import { censusObservations, gameDailyLegacy, gameObservations, games, places } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
// In the past, so refreshes can materialize the fixtures. as_of falls 30 minutes into an hour: the current window is
// the 24 whole hours before 12:00. Paris moved to summer time on 2026-03-29, between the week-ago window and this one.
const asOf = new Date("2026-04-01T12:30:00Z");
const windowEnd = Date.parse("2026-04-01T12:00:00Z");
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
    // A refresh leaves materialized buckets and a watermark that no later refresh moves back, which would hide the
    // next test's fixtures from real-time reads. TRUNCATE empties a continuous aggregate and resets its watermark.
    await database.db.execute(sql`truncate game_hourly, census_hourly`);
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

  function query(sort: RadarSort, overrides: Partial<Parameters<typeof risingGames>[1]> = {}, db: Database = database.db) {
    return risingGames(db, {
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

  // refresh_continuous_aggregate refuses a transaction block: a statement without parameters goes through the simple
  // query protocol on its own.
  async function refreshAggregates(): Promise<void> {
    for (const view of ["game_hourly", "census_hourly"]) {
      await database.db.execute(sql.raw(`call refresh_continuous_aggregate('${view}', null, null)`));
    }
  }

  // The buckets a refresh wrote, leaving out the real-time half that the view adds above its watermark.
  async function materializedBuckets(view: string): Promise<number> {
    const located = await database.db.execute<{ name: string }>(sql`
      select format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) as name
      from timescaledb_information.continuous_aggregates where view_name = ${view}
    `);
    const result = await database.db.execute<{ buckets: number }>(
      sql.raw(`select count(*)::int as buckets from ${located.rows[0].name}`),
    );
    return result.rows[0].buckets;
  }

  // Every hour of both windows is read. 1 is an old game that dominates the market; 2 is flat; 3 quadrupled its CCU;
  // 4 is new; 5 was not read a week ago, so it had fewer players than the active-set minimum.
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

  it("ranks young games by weekday-safe growth, new and untracked games from zero", async () => {
    await market();
    const rows = await query("growth");
    expect(rows.map((row) => row.universeId)).toEqual([4, 5, 3, 2]);
    const found = byId(rows);
    // Games 1, 2 and 3, read in both hours, total 13,000 CCU per hour now and 11,500 a week ago.
    expect(found.get(3)).toMatchObject({
      ccuAverage: 2_000,
      samples: 24,
      previousSamples: 24,
      weekSamples: 24,
      weekBaseline: "tracked",
      dayGrowth: 2,
    });
    expect(found.get(3)?.weekGrowth).toBeCloseTo((2_000 / 13_000) / (500 / 11_500), 4);
    expect(found.get(3)?.weekGrowthScore).toBeCloseTo(Math.log(2_100 / ((500 * 13_000) / 11_500 + 100)), 4);
    expect(found.get(2)?.weekGrowth).toBeCloseTo(11_500 / 13_000, 4);
    expect(found.get(2)).toMatchObject({ dayGrowth: null, previousSamples: 0, weekBaseline: "tracked" });
    expect(found.get(4)).toMatchObject({ weekBaseline: "new", weekGrowth: null, weekSamples: 0 });
    expect(found.get(4)?.weekGrowthScore).toBeCloseTo(Math.log(1_600 / 100), 4);
    expect(found.get(5)).toMatchObject({ weekBaseline: "untracked", weekGrowth: null, weekSamples: 0 });
    expect(found.get(5)?.weekGrowthScore).toBeCloseTo(Math.log(900 / 100), 4);
    // The limit keeps the first rows of the same order.
    expect(await query("growth", { limit: 2 })).toEqual(rows.slice(0, 2));

    // Production reads mostly materialized buckets: the rows do not change once the fixtures are.
    await refreshAggregates();
    expect(await materializedBuckets("game_hourly")).toBeGreaterThan(0);
    expect(await query("growth")).toEqual(rows);
  });

  it("pairs each hour with the same hour a week earlier when the week-ago samples are sparse", async () => {
    // A week ago, only 6 hours were read (v1 read 6–7 hours a day): hours 20 to 15 of the current window, a week
    // earlier. Game 3 doubles its CCU outside those hours, which must not count as growth.
    await game(1, 200);
    await current(1, 10_000);
    await hourly(1, week + 20, week + 14, 10_000);
    await game(2, 20);
    await current(2, 1_000);
    await hourly(2, week + 20, week + 14, 1_000);
    await game(3, 20);
    await current(3, (hour) => (hour <= 20 && hour > 14 ? 2_000 : 4_000));
    await hourly(3, week + 20, week + 14, 500);
    await game(5, 20);
    await current(5, 800);
    const rows = await query("growth");
    // Game 5 was not read a week ago, but neither was any game in most hours: its baseline is unknown.
    expect(rows.map((row) => row.universeId)).toEqual([3, 2, 5]);
    const found = byId(rows);
    expect(found.get(3)).toMatchObject({ ccuAverage: 3_500, weekSamples: 6, weekBaseline: "tracked" });
    expect(found.get(3)?.weekGrowth).toBeCloseTo((2_000 / 13_000) / (500 / 11_500), 4);
    expect(found.get(5)).toMatchObject({ weekBaseline: "unknown", weekGrowth: null, weekGrowthScore: null, weekSamples: 0 });
  });

  it("scores a game tracked at 0 CCU a week ago from its smoothing", async () => {
    await game(1, 200);
    await current(1, 10_000);
    await weekAgo(1, 10_000);
    await game(13, 20);
    await current(13, 500);
    await weekAgo(13, 0);
    const found = byId(await query("growth")).get(13);
    // 500 of 10,500 CCU now, 0 of 10,000 a week ago.
    expect(found).toMatchObject({ weekBaseline: "tracked", weekGrowth: null, weekSamples: 24 });
    expect(found?.weekGrowthScore).toBeCloseTo(Math.log(600 / 100), 4);
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

  // Every interval is in hours: a session whose time zone moved to summer time between the two windows gets the same
  // rows.
  it("returns the same rows in a session time zone with daylight saving", async () => {
    await market();
    const paris = createDatabase(database.url, { maxConnections: 1, applicationName: "radar-test", settings: { TimeZone: "Europe/Paris" } });
    try {
      const zone = await paris.db.execute<{ zone: string }>(sql`select current_setting('TimeZone') as zone`);
      expect(zone.rows[0]?.zone).toBe("Europe/Paris");
      expect(await query("growth", {}, paris.db)).toEqual(await query("growth"));
    } finally {
      await paris.pool.end();
    }
  });

  it("takes the freshest observation as the current CCU and never reads past as_of", async () => {
    await market();
    await writeGameObservations(database.db, [
      { universeId: 3, observedAt: new Date(windowEnd + 20 * 60_000), ccu: 2_500, visits: 1_000, favorites: 10 },
      { universeId: 3, observedAt: new Date(windowEnd + 40 * 60_000), ccu: 9_000, visits: 1_000, favorites: 10 },
    ]);
    expect(byId(await query("growth")).get(3)).toMatchObject({
      ccuLast: 2_500,
      ccuLastAt: new Date(windowEnd + 20 * 60_000),
      ccuPeak: 2_500,
    });
    // At the main window's start, the current window is the previous one of the main test, and the main window's
    // first observation (10 minutes later) is not read.
    const dayEarlier = byId(await query("growth", { asOf: new Date(windowEnd - dayMs) })).get(3);
    expect(dayEarlier).toMatchObject({
      ccuAverage: 1_000,
      samples: 24,
      ccuLast: 1_000,
      ccuLastAt: new Date(windowEnd - dayMs - 50 * 60_000),
      ccuPeak: 1_000,
    });
  });

  it("counts the v1 daily peaks of the days that ended by as_of in the peak CCU", async () => {
    await market();
    await database.db.insert(gameDailyLegacy).values([
      { universeId: 2, day: new Date(asOf.getTime() - 15 * dayMs), ccuAvg: 20_000, ccuPeak: 50_000, visits: 1, favorites: 1 },
      // The day that holds as_of has not ended.
      { universeId: 2, day: new Date("2026-04-01T00:00:00Z"), ccuAvg: 20_000, ccuPeak: 99_999, visits: 1, favorites: 1 },
    ]);
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

  it("dates each threshold crossing only when the reading before it is recent, census included", async () => {
    // Read every hour from 50 CCU (census) up: 150 at hour 59, 1,200 at hour 51, 12,000 at hour 31.
    await game(9, 5);
    await savePlaceResolution(database.db, { placeId: 90, universeId: 9, resolvedAt: asOf, error: null });
    await writeCensusObservations(database.db, [
      { placeId: 90, observedAt: new Date(windowEnd - 60 * hourMs), ccu: 50 },
      { placeId: 90, observedAt: new Date(windowEnd - 59 * hourMs), ccu: 150 },
    ]);
    await hourly(9, 58, 51, 600);
    await hourly(9, 51, 50, 1_200);
    await hourly(9, 50, 31, 5_000);
    await hourly(9, 31, 30, 12_000);
    await current(9, 8_000);
    // First seen above the middle threshold: neither velocity is known.
    await game(10, 5);
    await current(10, 3_000);
    // Crosses the start and middle thresholds after 10 hours without a reading.
    await game(11, 5);
    await hourly(11, 40, 39, 50);
    await hourly(11, 30, 29, 2_000);
    await current(11, 3_000);
    // First seen above the start threshold, then read every hour.
    await game(12, 5);
    await hourly(12, 40, 39, 500);
    await hourly(12, 39, 31, 1_200);
    await hourly(12, 31, 30, 12_000);
    await current(12, 8_000);
    const rows = byId(await query("ccu"));
    expect(rows.get(9)).toMatchObject({ firstSeenCcu: 50, hoursToMiddle: 8, hoursToEnd: 20 });
    expect(rows.get(10)).toMatchObject({ firstSeenCcu: 3_000, hoursToMiddle: null, hoursToEnd: null });
    expect(rows.get(11)).toMatchObject({ firstSeenCcu: 50, hoursToMiddle: null, hoursToEnd: null });
    expect(rows.get(12)).toMatchObject({ firstSeenCcu: 500, hoursToMiddle: null, hoursToEnd: 8 });
  });
});
