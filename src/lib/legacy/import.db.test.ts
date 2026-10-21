import { asc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "@/db/client";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations, writeVoteObservations } from "@/db/observations";
import {
  chartPlacements,
  discoverySources,
  gameDailyLegacy,
  gameObservations,
  games,
  gameVersions,
  jobRuns,
  voteObservations,
} from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { importLegacyHistory, LEGACY_IMPORT_SESSION_SETTINGS } from "./import";

// Minimal copy of the v1 tables the importer reads, created in a disposable test database.
const LEGACY_SCHEMA = `
  create table games (universe_id text primary key, root_place_id text not null, name text not null, description text not null default '',
    creator_id text not null, creator_name text not null, creator_type text not null, created_at timestamptz not null, updated_at timestamptz not null,
    first_seen_at timestamptz not null, last_seen_at timestamptz not null, thumbnail_url text, genre text);
  create table game_metadata_history (id integer generated always as identity primary key, universe_id text not null, fingerprint text not null,
    name text not null, normalized_title text not null, description text not null, game_updated_at timestamptz not null, observed_at timestamptz not null);
  create unique index game_metadata_history_version_idx on game_metadata_history (universe_id, fingerprint);
  create index game_metadata_history_game_time_idx on game_metadata_history (universe_id, observed_at);
  create table snapshots (id integer generated always as identity primary key, universe_id text not null, collected_at timestamptz not null,
    bucket_at timestamptz not null, ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer,
    is_sponsored boolean, chart text not null, rank integer, source text not null);
  create unique index snapshots_idempotency_idx on snapshots (universe_id, bucket_at, source, chart);
  create table daily_snapshots (id integer generated always as identity primary key, universe_id text not null, day_at timestamptz not null,
    average_ccu integer not null, peak_ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer, best_rank integer);
`;

// One game with two hourly buckets on two UTC days (players and a chart placement, then an empty reading), plus:
// - a game whose creator id is not a number, with rows in every table, none of which may be imported;
// - four history rows: A, A again (only a publish: v1's fingerprint included the update time), B, then A back;
// - a placement on a chart label v2 does not know;
// - a reading whose visits v2 cannot store.
const LEGACY_ROWS = `
  insert into games values
    ('10765298801', '115530770000806', '+1 Stone Skipping', 'Skip stones', '1', 'Meow Labs', 'Group',
      '2026-09-04T22:00:00Z', '2026-10-01T00:00:00Z', '2026-09-28T22:00:00Z', '2026-10-01T10:00:00Z', 'https://tr.rbxcdn.com/icon', 'Simulation'),
    ('20000000002', '20000000003', 'Broken', '', 'n/a', 'Nobody', 'User',
      '2026-09-04T22:00:00Z', '2026-10-01T00:00:00Z', '2026-09-28T22:00:00Z', '2026-10-01T10:00:00Z', null, null);
  insert into game_metadata_history (universe_id, fingerprint, name, normalized_title, description, game_updated_at, observed_at) values
    ('10765298801', 'v1', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones', '2026-09-29T12:00:00Z', '2026-09-29T15:09:16Z'),
    ('10765298801', 'v2', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones', '2026-09-30T09:00:00Z', '2026-09-30T10:00:00Z'),
    ('10765298801', 'v3', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones faster', '2026-09-30T19:00:00Z', '2026-09-30T20:00:00Z'),
    ('10765298801', 'v4', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones', '2026-10-01T00:00:00Z', '2026-10-01T09:00:00Z'),
    ('20000000002', 'b1', 'Broken', 'Broken', '', '2026-09-29T12:00:00Z', '2026-09-29T15:00:00Z');
  insert into snapshots (universe_id, collected_at, bucket_at, ccu, visits, favorites, up_votes, down_votes, is_sponsored, chart, rank, source) values
    ('10765298801', '2026-09-29T20:02:00Z', '2026-09-29T20:00:00Z', 13000, 5000000, 9000, 900, 100, false, 'Top Trending', 4, 'roblox-charts'),
    ('10765298801', '2026-09-29T20:03:00Z', '2026-09-29T20:00:00Z', 13473, 5000100, 9001, 900, 100, null, 'Direct tracking', null, 'roblox-tracked'),
    ('10765298801', '2026-09-29T20:04:00Z', '2026-09-29T20:00:00Z', 13100, 5000050, 9000, null, null, false, 'Search: Stone', 2, 'roblox-search'),
    ('10765298801', '2026-09-29T20:05:00Z', '2026-09-29T20:00:00Z', 12000, 5000000, 9000, null, null, false, 'Top Secret Picks', 7, 'roblox-charts'),
    ('10765298801', '2026-09-30T05:01:00Z', '2026-09-30T05:00:00Z', 0, 5000200, 9002, 901, 100, null, 'Direct tracking', null, 'roblox-tracked'),
    ('10765298801', '2026-09-30T06:01:00Z', '2026-09-30T06:00:00Z', 5, 'Infinity', 9002, null, null, null, 'Direct tracking', null, 'roblox-tracked'),
    ('20000000002', '2026-09-29T20:06:00Z', '2026-09-29T20:00:00Z', 50, 1000, 10, 5, 1, false, 'Top Trending', 9, 'roblox-charts');
  insert into daily_snapshots (universe_id, day_at, average_ccu, peak_ccu, visits, favorites, up_votes, down_votes, best_rank) values
    ('10765298801', '2026-09-01T00:00:00Z', 800, 1200, 100000, 100, 50, 5, 3),
    ('20000000002', '2026-09-01T00:00:00Z', 10, 20, 1000, 10, null, null, null);
`;

const UNIVERSE_ID = 10765298801;

// Fixed clock: the import skips raw rows older than the retention window, so the real date would age the fixtures out.
const FIXTURE_NOW = new Date("2026-10-21T00:00:00Z");

// The buckets a refresh wrote, leaving out the real-time half that the view adds above its watermark.
async function materializedRows(db: Database, view: "game_hourly" | "game_daily"): Promise<string[]> {
  const located = await db.execute<{ name: string }>(sql`
    select format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) as name
    from timescaledb_information.continuous_aggregates where view_name = ${view}
  `);
  const rows = await db.execute<{ bucket: Date }>(sql.raw(`select bucket from ${located.rows[0].name} order by bucket`));
  return rows.rows.map((row) => new Date(row.bucket).toISOString());
}

async function refresh(db: Database, view: "game_hourly" | "game_daily", from: string, to: string): Promise<void> {
  await db.execute(sql.raw(`CALL refresh_continuous_aggregate('${view}', '${from}'::timestamptz, '${to}'::timestamptz)`));
}

async function observedTimes(db: Database): Promise<string[]> {
  const rows = await db.select({ observedAt: gameObservations.observedAt }).from(gameObservations).orderBy(asc(gameObservations.observedAt));
  return rows.map((row) => row.observedAt.toISOString());
}

// The logger writes warnings as JSON lines through console.warn.
function captureWarnings(): () => string {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mock.calls.map((call) => String(call[0])).join("\n");
}

describe.skipIf(!hasTestDatabase)("importLegacyHistory", () => {
  let target: TestDatabase;
  let legacy: TestDatabase;
  let legacyPool: Pool;

  beforeAll(async () => {
    target = await createTestDatabase();
    legacy = await createTestDatabase({ migrate: false });
    legacyPool = new Pool({ connectionString: legacy.url, max: 2 });
    await legacyPool.query(LEGACY_SCHEMA);
    await legacyPool.query(LEGACY_ROWS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await legacyPool?.end();
    await legacy?.drop();
    await target?.drop();
  });

  // Gives `run` a fresh, migrated v2 database and drops it afterwards.
  async function withFreshTarget(run: (db: Database) => Promise<void>): Promise<void> {
    const fresh = await createTestDatabase();
    try {
      await run(fresh.db);
    } finally {
      await fresh.drop();
    }
  }

  it("imports games, versions, deduplicated observations, placements, votes, discoveries and daily rows", async () => {
    const warnings = captureWarnings();
    const stats = await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(stats).toEqual({
      games: 1,
      versions: 3,
      observations: 2,
      votes: 2,
      placements: 1,
      discoveries: 2,
      dailyRows: 1,
      unmappedLabels: 1,
      invalidRows: 1,
      from: "2026-09-29T20:00:00.000Z",
      to: "2026-09-30T06:00:00.000Z",
    });
    expect(warnings()).toContain("roblox-charts: Top Secret Picks");
    expect(warnings()).toContain("Skipped legacy games with invalid ids");

    const [game, ...otherGames] = await target.db.select().from(games);
    expect(otherGames).toEqual([]);
    expect(game).toMatchObject({
      universeId: UNIVERSE_ID,
      rootPlaceId: 115530770000806,
      name: "+1 Stone Skipping",
      iconUrl: "https://tr.rbxcdn.com/icon",
      thumbnailUrl: null,
      // The latest reading, and separately the latest reading with players.
      lastCcu: 0,
    });
    expect(game.firstObservedAt.toISOString()).toBe("2026-09-28T22:00:00.000Z");
    expect(game.lastObservedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(game.lastCcuAt?.toISOString()).toBe("2026-09-30T05:00:00.000Z");
    expect(game.lastActiveAt?.toISOString()).toBe("2026-09-29T20:00:00.000Z");

    const observations = await target.db.select().from(gameObservations).orderBy(asc(gameObservations.observedAt));
    expect(observations).toMatchObject([
      { universeId: UNIVERSE_ID, ccu: 13473, visits: 5000100, favorites: 9001, source: "legacy" },
      { universeId: UNIVERSE_ID, ccu: 0, visits: 5000200, favorites: 9002, source: "legacy" },
    ]);
    expect(await target.db.select().from(voteObservations).orderBy(asc(voteObservations.observedAt))).toMatchObject([
      { universeId: UNIVERSE_ID, upVotes: 900, downVotes: 100 },
      { universeId: UNIVERSE_ID, upVotes: 901, downVotes: 100 },
    ]);
    expect(await target.db.select().from(chartPlacements)).toEqual([
      expect.objectContaining({ sortId: "top-trending", universeId: UNIVERSE_ID, rank: 4, playerCount: 13000, isSponsored: false }),
    ]);
    expect((await target.db.select().from(discoverySources)).map((row) => [row.source, row.detail]).sort()).toEqual([
      ["chart", "top-trending"],
      ["search", "Stone"],
    ]);
    const versions = await target.db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.universeId, UNIVERSE_ID))
      .orderBy(asc(gameVersions.observedAt));
    // The publish is dropped; the revert to A is a version of its own.
    expect(versions.map((version) => [version.description, version.observedAt.toISOString()])).toEqual([
      ["Skip stones", "2026-09-29T15:09:16.000Z"],
      ["Skip stones faster", "2026-09-30T20:00:00.000Z"],
      ["Skip stones", "2026-10-01T09:00:00.000Z"],
    ]);

    expect(await target.db.select().from(gameDailyLegacy)).toEqual([
      expect.objectContaining({ universeId: UNIVERSE_ID, ccuAvg: 800, ccuPeak: 1200, upVotes: 50, downVotes: 5, bestRank: 3 }),
    ]);
    const daily = await target.db.execute<{ day: Date; origin: string }>(sql`select day, origin from game_daily_all order by day`);
    expect(daily.rows.map((row) => [new Date(row.day).toISOString(), row.origin])).toEqual([
      ["2026-09-01T00:00:00.000Z", "legacy"],
      ["2026-09-29T00:00:00.000Z", "observed"],
      ["2026-09-30T00:00:00.000Z", "observed"],
    ]);
    // Older than the refresh policies reach: only the import's own refresh materializes these buckets.
    expect(await materializedRows(target.db, "game_hourly")).toEqual(["2026-09-29T20:00:00.000Z", "2026-09-30T05:00:00.000Z"]);
    expect(await materializedRows(target.db, "game_daily")).toEqual(["2026-09-29T00:00:00.000Z", "2026-09-30T00:00:00.000Z"]);
  });

  it("is idempotent", async () => {
    captureWarnings();
    const stats = await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(stats).toMatchObject({ games: 1, versions: 0, observations: 0, votes: 0, placements: 0, dailyRows: 0 });
    expect(await target.db.select().from(gameObservations)).toHaveLength(2);
    expect(await target.db.select().from(voteObservations)).toHaveLength(2);
    expect(await target.db.select().from(chartPlacements)).toHaveLength(1);
    expect(await target.db.select().from(discoverySources)).toHaveLength(2);
    expect(await target.db.select().from(gameVersions)).toHaveLength(3);
    expect(await target.db.select().from(gameDailyLegacy)).toHaveLength(1);
    expect(await target.db.select().from(games)).toHaveLength(1);
  });

  it("imports no v1 chart placement into a slot v2 already collected", async () => {
    captureWarnings();
    await withFreshTarget(async (db) => {
      await db.insert(jobRuns).values({
        id: "00000000-0000-4000-8000-000000000001",
        job: "charts",
        slot: new Date("2026-09-29T20:00:00Z"),
        status: "failed",
        startedAt: new Date("2026-09-29T20:02:00Z"),
        stats: {},
      });
      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW });
      expect(stats.placements).toBe(0);
      expect(stats.observations).toBe(2);
    });
  });

  it("never overwrites data collected by v2, and warns that poll already ran", async () => {
    const warnings = captureWarnings();
    await withFreshTarget(async (db) => {
      await db.insert(jobRuns).values({
        id: "00000000-0000-4000-8000-000000000002",
        job: "poll",
        slot: new Date("2026-10-05T00:00:00Z"),
        status: "success",
        startedAt: new Date("2026-10-05T00:00:01Z"),
        stats: {},
      });
      await upsertGameDetails(db, [gameDetail(UNIVERSE_ID, { name: "Stone Skipping", playing: 77 })], new Date("2026-10-05T00:00:00Z"));
      await writeGameObservations(db, [
        { universeId: UNIVERSE_ID, observedAt: new Date("2026-09-29T20:00:00Z"), ccu: 99_999, visits: 1, favorites: 1 },
      ]);
      await writeVoteObservations(db, [{ universeId: UNIVERSE_ID, observedAt: new Date("2026-09-29T20:00:00Z"), upVotes: 5, downVotes: 6 }]);

      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW });
      expect(stats).toMatchObject({ observations: 1, votes: 1 });
      expect(warnings()).toContain("before enabling the timers");

      const [observation] = await db.select().from(gameObservations).orderBy(asc(gameObservations.observedAt));
      expect(observation).toMatchObject({ ccu: 99_999, source: "poll" });
      const [vote] = await db.select().from(voteObservations).orderBy(asc(voteObservations.observedAt));
      expect(vote).toMatchObject({ upVotes: 5, downVotes: 6 });
      const [game] = await db.select().from(games);
      expect(game).toMatchObject({ name: "Stone Skipping", lastCcu: 77, iconUrl: null });
      expect(game.lastCcuAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
      expect(game.lastActiveAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
      // v1 saw the game first, v2 saw it last.
      expect(game.firstObservedAt.toISOString()).toBe("2026-09-28T22:00:00.000Z");
      expect(game.lastObservedAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    });
  });

  it("skips raw observations older than the retention window but keeps permanent tables", async () => {
    captureWarnings();
    await withFreshTarget(async (db) => {
      // 364 days later: the retention window (365 days, minus a day of margin) now starts at 2026-09-30.
      const stats = await importLegacyHistory(db, legacyPool, { now: new Date("2027-09-29T00:00:00Z") });
      expect(stats).toMatchObject({ games: 1, observations: 1, votes: 2, placements: 1, dailyRows: 1 });
      expect(await observedTimes(db)).toEqual(["2026-09-30T05:00:00.000Z"]);
      // The day the retention window cut is not recomputed from what is left of it.
      expect(await materializedRows(db, "game_daily")).toEqual(["2026-09-30T00:00:00.000Z"]);
    });
  });

  it("leaves buckets that are still filling to real-time aggregation", async () => {
    captureWarnings();
    await withFreshTarget(async (db) => {
      await importLegacyHistory(db, legacyPool, { now: new Date("2026-09-30T05:30:00Z") });
      expect(await materializedRows(db, "game_hourly")).toEqual(["2026-09-29T20:00:00.000Z"]);
      expect(await materializedRows(db, "game_daily")).toEqual(["2026-09-29T00:00:00.000Z"]);
      const hourly = await db.execute<{ buckets: number }>(sql`select count(*)::int as buckets from game_hourly`);
      expect(hourly.rows[0].buckets).toBe(2);
    });
  });

  it("imports only the windows from --since onwards", async () => {
    captureWarnings();
    await withFreshTarget(async (db) => {
      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW, since: new Date("2026-09-30T00:00:00Z") });
      expect(stats).toMatchObject({ observations: 1, votes: 1, placements: 0, invalidRows: 1, from: "2026-09-30T05:00:00.000Z" });
      expect(await observedTimes(db)).toEqual(["2026-09-30T05:00:00.000Z"]);
    });
  });

  it("completes a window that a failed run wrote but did not refresh", async () => {
    captureWarnings();
    await withFreshTarget(async (db) => {
      // What a run that failed in its second window leaves: both windows written, only the first one refreshed.
      await writeGameObservations(
        db,
        [
          { universeId: UNIVERSE_ID, observedAt: new Date("2026-09-29T20:00:00Z"), ccu: 13473, visits: 5000100, favorites: 9001, source: "legacy" },
          { universeId: UNIVERSE_ID, observedAt: new Date("2026-09-30T05:00:00Z"), ccu: 0, visits: 5000200, favorites: 9002, source: "legacy" },
        ],
        "keep",
      );
      await refresh(db, "game_hourly", "2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z");
      await refresh(db, "game_daily", "2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z");

      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW, since: new Date("2026-09-30T00:00:00Z") });
      // Nothing left to write, but the window is refreshed all the same.
      expect(stats.observations).toBe(0);
      expect(await materializedRows(db, "game_hourly")).toEqual(["2026-09-29T20:00:00.000Z", "2026-09-30T05:00:00.000Z"]);
      expect(await materializedRows(db, "game_daily")).toEqual(["2026-09-29T00:00:00.000Z", "2026-09-30T00:00:00.000Z"]);
      // The activity backfill covers the windows of the failed run too, not only those from --since.
      const [game] = await db.select().from(games);
      expect(game.lastCcuAt?.toISOString()).toBe("2026-09-30T05:00:00.000Z");
      expect(game.lastActiveAt?.toISOString()).toBe("2026-09-29T20:00:00.000Z");
    });
  });

  it("lifts TimescaleDB's decompression limit on the import's connections", async () => {
    const { db, pool } = createDatabase(target.url, { maxConnections: 1, settings: LEGACY_IMPORT_SESSION_SETTINGS });
    try {
      const result = await db.execute<{ limit: string }>(
        sql`select current_setting('timescaledb.max_tuples_decompressed_per_dml_transaction') as limit`,
      );
      expect(result.rows[0].limit).toBe("0");
    } finally {
      await pool.end();
    }
  });

  it("refuses a source that does not hold the v1 tables", async () => {
    const notLegacy = new Pool({ connectionString: target.url, max: 1 });
    try {
      await expect(importLegacyHistory(target.db, notLegacy, { now: FIXTURE_NOW })).rejects.toThrow(/does not hold the v1 radar tables/);
    } finally {
      await notLegacy.end();
    }
  });

  it("refuses to import a database into itself", async () => {
    const self = createDatabase(legacy.url, { maxConnections: 1 });
    try {
      await expect(importLegacyHistory(self.db, legacyPool, { now: FIXTURE_NOW })).rejects.toThrow(/same database/);
    } finally {
      await self.pool.end();
    }
  });

  it("refuses a target that holds v1 tables", async () => {
    const other = await createTestDatabase({ migrate: false });
    try {
      await other.db.execute(sql`create table snapshots (id integer)`);
      await expect(importLegacyHistory(other.db, legacyPool, { now: FIXTURE_NOW })).rejects.toThrow(/still holds v1 radar tables/);
    } finally {
      await other.drop();
    }
  });
});
