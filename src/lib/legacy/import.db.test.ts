import { asc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@/db/client";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations, writeVoteObservations } from "@/db/observations";
import { chartPlacements, discoverySources, gameObservations, games, gameVersions, jobRuns, voteObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { importLegacyHistory } from "./import";

// Minimal copy of the v1 tables the importer reads, created in a disposable test database.
const LEGACY_SCHEMA = `
  create table games (universe_id text primary key, root_place_id text not null, name text not null, description text not null default '',
    creator_id text not null, creator_name text not null, creator_type text not null, created_at timestamptz not null, updated_at timestamptz not null,
    first_seen_at timestamptz not null, last_seen_at timestamptz not null, thumbnail_url text, genre text);
  create table game_metadata_history (id integer generated always as identity primary key, universe_id text not null, fingerprint text not null,
    name text not null, normalized_title text not null, description text not null, game_updated_at timestamptz not null, observed_at timestamptz not null);
  create table snapshots (id integer generated always as identity primary key, universe_id text not null, collected_at timestamptz not null,
    bucket_at timestamptz not null, ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer,
    is_sponsored boolean, chart text not null, rank integer, source text not null);
  create unique index snapshots_idempotency_idx on snapshots (universe_id, bucket_at, source, chart);
  create table daily_snapshots (id integer generated always as identity primary key, universe_id text not null, day_at timestamptz not null,
    average_ccu integer not null, peak_ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer, best_rank integer);
`;

// Two hourly buckets on two UTC days: the first has players and a chart placement, the second is an empty reading.
const LEGACY_ROWS = `
  insert into games values ('10765298801', '115530770000806', '+1 Stone Skipping', 'Skip stones', '1', 'Meow Labs', 'Group',
    '2026-09-04T22:00:00Z', '2026-10-01T00:00:00Z', '2026-09-28T22:00:00Z', '2026-10-01T10:00:00Z', 'https://tr.rbxcdn.com/icon', 'Simulation');
  insert into game_metadata_history (universe_id, fingerprint, name, normalized_title, description, game_updated_at, observed_at)
    values ('10765298801', 'v1', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones', '2026-10-01T00:00:00Z', '2026-09-29T15:09:16Z');
  insert into snapshots (universe_id, collected_at, bucket_at, ccu, visits, favorites, up_votes, down_votes, is_sponsored, chart, rank, source) values
    ('10765298801', '2026-09-29T20:02:00Z', '2026-09-29T20:00:00Z', 13000, 5000000, 9000, 900, 100, false, 'Top Trending', 4, 'roblox-charts'),
    ('10765298801', '2026-09-29T20:03:00Z', '2026-09-29T20:00:00Z', 13473, 5000100, 9001, 900, 100, null, 'Direct tracking', null, 'roblox-tracked'),
    ('10765298801', '2026-09-29T20:04:00Z', '2026-09-29T20:00:00Z', 13100, 5000050, 9000, null, null, false, 'Search: Stone', 2, 'roblox-search'),
    ('10765298801', '2026-09-30T05:01:00Z', '2026-09-30T05:00:00Z', 0, 5000200, 9002, 901, 100, null, 'Direct tracking', null, 'roblox-tracked');
  insert into daily_snapshots (universe_id, day_at, average_ccu, peak_ccu, visits, favorites)
    values ('10765298801', '2026-09-01T00:00:00Z', 800, 1200, 100000, 100);
`;

const UNIVERSE_ID = 10765298801;

// Fixed clock: the import skips raw rows older than the retention window, so the real date would age the fixtures out.
const FIXTURE_NOW = new Date("2026-10-21T00:00:00Z");

// Counts the rows a refresh wrote, leaving out the real-time half that the view adds above its watermark.
async function materializedRows(db: Database, view: "game_hourly" | "game_daily"): Promise<string[]> {
  const located = await db.execute<{ name: string }>(sql`
    select format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) as name
    from timescaledb_information.continuous_aggregates where view_name = ${view}
  `);
  const rows = await db.execute<{ bucket: Date }>(sql.raw(`select bucket from ${located.rows[0].name} order by bucket`));
  return rows.rows.map((row) => new Date(row.bucket).toISOString());
}

async function observedTimes(db: Database): Promise<string[]> {
  const rows = await db.select({ observedAt: gameObservations.observedAt }).from(gameObservations).orderBy(asc(gameObservations.observedAt));
  return rows.map((row) => row.observedAt.toISOString());
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
    const stats = await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(stats).toEqual({
      games: 1,
      versions: 1,
      observations: 2,
      votes: 2,
      placements: 1,
      discoveries: 2,
      dailyRows: 1,
      from: "2026-09-29T20:00:00.000Z",
      to: "2026-09-30T05:00:00.000Z",
    });

    const [game] = await target.db.select().from(games);
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
      { ccu: 13473, visits: 5000100, favorites: 9001, source: "legacy" },
      { ccu: 0, visits: 5000200, favorites: 9002, source: "legacy" },
    ]);
    expect(await target.db.select().from(voteObservations).orderBy(asc(voteObservations.observedAt))).toMatchObject([
      { upVotes: 900, downVotes: 100 },
      { upVotes: 901, downVotes: 100 },
    ]);
    expect(await target.db.select().from(chartPlacements)).toEqual([
      expect.objectContaining({ sortId: "top-trending", rank: 4, playerCount: 13000, isSponsored: false }),
    ]);
    expect((await target.db.select().from(discoverySources)).map((row) => [row.source, row.detail]).sort()).toEqual([
      ["chart", "top-trending"],
      ["search", "Stone"],
    ]);
    expect(await target.db.select().from(gameVersions).where(eq(gameVersions.universeId, UNIVERSE_ID))).toHaveLength(1);

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
    const stats = await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(stats).toMatchObject({ games: 1, versions: 0, observations: 0, votes: 0, placements: 0, dailyRows: 0 });
    expect(await target.db.select().from(gameObservations)).toHaveLength(2);
    expect(await target.db.select().from(voteObservations)).toHaveLength(2);
    expect(await target.db.select().from(chartPlacements)).toHaveLength(1);
    expect(await target.db.select().from(discoverySources)).toHaveLength(2);
    expect(await target.db.select().from(gameVersions)).toHaveLength(1);
    expect(await target.db.select().from(games)).toHaveLength(1);
  });

  it("imports no v1 chart placement into a slot v2 already collected", async () => {
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

  it("never overwrites data collected by v2", async () => {
    await withFreshTarget(async (db) => {
      await upsertGameDetails(db, [gameDetail(UNIVERSE_ID, { name: "Stone Skipping", playing: 77 })], new Date("2026-10-05T00:00:00Z"));
      await writeGameObservations(db, [
        { universeId: UNIVERSE_ID, observedAt: new Date("2026-09-29T20:00:00Z"), ccu: 99_999, visits: 1, favorites: 1 },
      ]);
      await writeVoteObservations(db, [{ universeId: UNIVERSE_ID, observedAt: new Date("2026-09-29T20:00:00Z"), upVotes: 5, downVotes: 6 }]);

      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW });
      expect(stats).toMatchObject({ observations: 1, votes: 1 });

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
    await withFreshTarget(async (db) => {
      await importLegacyHistory(db, legacyPool, { now: new Date("2026-09-30T05:30:00Z") });
      expect(await materializedRows(db, "game_hourly")).toEqual(["2026-09-29T20:00:00.000Z"]);
      expect(await materializedRows(db, "game_daily")).toEqual(["2026-09-29T00:00:00.000Z"]);
      const hourly = await db.execute<{ buckets: number }>(sql`select count(*)::int as buckets from game_hourly`);
      expect(hourly.rows[0].buckets).toBe(2);
    });
  });

  it("imports only the windows from --since onwards", async () => {
    await withFreshTarget(async (db) => {
      const stats = await importLegacyHistory(db, legacyPool, { now: FIXTURE_NOW, since: new Date("2026-09-30T00:00:00Z") });
      expect(stats).toMatchObject({ observations: 1, votes: 1, placements: 0, from: "2026-09-30T05:00:00.000Z" });
      expect(await observedTimes(db)).toEqual(["2026-09-30T05:00:00.000Z"]);
    });
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
});
