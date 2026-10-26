import { and, between, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_FINGERPRINT_VERSION, rawFingerprint } from "@/lib/fingerprint";
import { gameDetail } from "@/test/fixtures";
import { createDatabase } from "./client";
import { recordDiscoveries } from "./discovery";
import { knownUniverseIds, upsertGameDetails } from "./games";
import { assertSupportedPostgres } from "./legacy-guard";
import { placesToSkip, savePlaceResolution, unpromotedUniverses } from "./places";
import { discoverySources, games, gameVersions, places } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("game repositories", () => {
  let database: TestDatabase;
  const first = new Date("2026-10-20T14:00:00Z");
  const second = new Date("2026-10-20T14:05:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function versionCount(universeIds: number[]): Promise<number> {
    const [row] = await database.db
      .select({ versions: sql<number>`count(*)::int` })
      .from(gameVersions)
      .where(inArray(gameVersions.universeId, universeIds));
    return row.versions;
  }

  it("inserts a new game with its first metadata version and place mapping", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping", playing: 900 })], first);
    expect(result).toEqual({ inserted: [1], metadataChanged: [] });
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.lastCcu).toBe(900);
    expect(game.firstObservedAt.toISOString()).toBe(first.toISOString());
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(1);
    const [place] = await database.db.select().from(places).where(eq(places.placeId, 1_000_001));
    expect(place.universeId).toBe(1);
  });

  it("updates live fields without a new version when metadata is unchanged", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping", playing: 1_200 })], second);
    expect(result).toEqual({ inserted: [], metadataChanged: [] });
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.lastCcu).toBe(1_200);
    expect(game.firstObservedAt.toISOString()).toBe(first.toISOString());
    expect(game.lastObservedAt.toISOString()).toBe(second.toISOString());
  });

  it("records a version when the title changes", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "[🎃] +1 Stone Skipping" })], second);
    expect(result.metadataChanged).toEqual([1]);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(2);
  });

  it("stores the content fingerprint and its version with the game and its first version", async () => {
    await upsertGameDetails(database.db, [gameDetail(70, { name: "[🎃] +1 Stone Skipping", description: "Skip stones" })], first);
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 70));
    const [version] = await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 70));
    for (const row of [game, version]) {
      expect(row.contentFingerprint).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
      expect(row.contentFingerprintVersion).toBe(CONTENT_FINGERPRINT_VERSION);
    }
  });

  it("rewrites a content fingerprint of an earlier version without recording a version", async () => {
    await database.db
      .update(games)
      .set({ contentFingerprint: "stale", contentFingerprintVersion: CONTENT_FINGERPRINT_VERSION - 1 })
      .where(eq(games.universeId, 70));
    await upsertGameDetails(database.db, [gameDetail(70, { name: "[🎃] +1 Stone Skipping", description: "Skip stones" })], second);
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 70));
    expect(game.contentFingerprint).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
    expect(game.contentFingerprintVersion).toBe(CONTENT_FINGERPRINT_VERSION);
    expect(await versionCount([70])).toBe(1);
  });

  it("records a revert to an earlier title", async () => {
    const third = new Date("2026-10-20T14:10:00Z");
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping" })], third);
    expect(result.metadataChanged).toEqual([1]);
    const versions = await database.db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.universeId, 1))
      .orderBy(gameVersions.observedAt);
    expect(versions.map((version) => version.name)).toEqual(["+1 Stone Skipping", "[🎃] +1 Stone Skipping", "+1 Stone Skipping"]);
  });

  it("does not duplicate a version when the same slot is retried", async () => {
    const third = new Date("2026-10-20T14:10:00Z");
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping" })], third);
    expect(result.metadataChanged).toEqual([]);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(3);
  });

  it("deduplicates repeated details within one call", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(2), gameDetail(2)], first);
    expect(result.inserted).toEqual([2]);
  });

  it("lists known universes", async () => {
    expect(await knownUniverseIds(database.db, [1, 2, 3])).toEqual(new Set([1, 2]));
  });

  it("records versions only for new and changed games in a mixed batch", async () => {
    await upsertGameDetails(database.db, [gameDetail(10), gameDetail(11)], first);
    const result = await upsertGameDetails(
      database.db,
      [gameDetail(10), gameDetail(11, { name: "Game 11 [UPDATE]" }), gameDetail(12)],
      second,
    );
    expect(result).toEqual({ inserted: [12], metadataChanged: [11] });
    const versions = await database.db
      .select({ universeId: gameVersions.universeId, name: gameVersions.name })
      .from(gameVersions)
      .where(inArray(gameVersions.universeId, [10, 11, 12]))
      .orderBy(gameVersions.universeId, gameVersions.observedAt);
    expect(versions).toEqual([
      { universeId: 10, name: "Game 10" },
      { universeId: 11, name: "Game 11" },
      { universeId: 11, name: "Game 11 [UPDATE]" },
      { universeId: 12, name: "Game 12" },
    ]);
    const stored = await database.db
      .select({ universeId: games.universeId, name: games.name })
      .from(games)
      .where(inArray(games.universeId, [10, 11]))
      .orderBy(games.universeId);
    expect(stored).toEqual([
      { universeId: 10, name: "Game 10" },
      { universeId: 11, name: "Game 11 [UPDATE]" },
    ]);
  });

  it("inserts every game of a batch that spans several chunks", async () => {
    const details = Array.from({ length: 1_201 }, (_, index) => gameDetail(100_000 + index));
    const result = await upsertGameDetails(database.db, details, first);
    expect(result.inserted).toHaveLength(1_201);
    const [stored] = await database.db
      .select({ games: sql<number>`count(*)::int` })
      .from(games)
      .where(between(games.universeId, 100_000, 101_200));
    expect(stored.games).toBe(1_201);
    expect(await versionCount(details.map((detail) => detail.id))).toBe(1_201);
  });

  it("keeps the stored fingerprint when the version insert fails, so a retry records the version", async () => {
    await upsertGameDetails(database.db, [gameDetail(20)], first);
    const renamed = gameDetail(20, { name: "Game 20 [UPDATE]" });
    await database.db.execute(
      sql`create function fail_version_insert() returns trigger language plpgsql as $$ begin raise exception 'version insert failed'; end $$`,
    );
    await database.db.execute(
      sql`create trigger fail_version_insert before insert on game_versions for each row execute function fail_version_insert()`,
    );
    try {
      await expect(upsertGameDetails(database.db, [renamed], second)).rejects.toMatchObject({
        cause: { message: "version insert failed" },
      });
    } finally {
      await database.db.execute(sql`drop trigger fail_version_insert on game_versions`);
      await database.db.execute(sql`drop function fail_version_insert()`);
    }
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 20));
    expect(game.metadataFingerprint).toBe(rawFingerprint("Game 20", ""));
    expect(game.name).toBe("Game 20");

    const retry = await upsertGameDetails(database.db, [renamed], second);
    expect(retry.metadataChanged).toEqual([20]);
    expect(await versionCount([20])).toBe(2);
  });

  it("upserts the same new games from two connections in different orders without deadlocking", async () => {
    const details = Array.from({ length: 1_000 }, (_, index) => gameDetail(200_000 + index));
    // The second connection receives a scrambled order. Fully reversed, the first 500-row chunks would not
    // overlap; scrambled, both transactions would wait on each other unless rows are locked in one order.
    const scrambled = details.map((_, index) => details[(index * 7_919 + 500) % details.length]);
    const left = createDatabase(database.url, { maxConnections: 1, applicationName: "radar-test-left" });
    const right = createDatabase(database.url, { maxConnections: 1, applicationName: "radar-test-right" });
    // Each row waits 1 ms, so the two inserts overlap on the server instead of running back to back.
    await database.db.execute(
      sql`create function slow_game_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.001); return new; end $$`,
    );
    await database.db.execute(
      sql`create trigger slow_game_insert before insert on games for each row execute function slow_game_insert()`,
    );
    try {
      await Promise.all([left.db.execute(sql`select 1`), right.db.execute(sql`select 1`)]);
      const results = await Promise.all([
        upsertGameDetails(left.db, details, first),
        upsertGameDetails(right.db, scrambled, first),
      ]);
      expect(results[0].inserted.length + results[1].inserted.length).toBe(1_000);
      expect(results.flatMap((result) => result.metadataChanged)).toEqual([]);
      expect(await versionCount(details.map((detail) => detail.id))).toBe(1_000);
    } finally {
      await Promise.all([left.pool.end(), right.pool.end()]);
      await database.db.execute(sql`drop trigger slow_game_insert on games`);
      await database.db.execute(sql`drop function slow_game_insert()`);
    }
  });

  it("ignores a game detail older than the stored observation, except for an earlier first observation", async () => {
    const third = new Date("2026-10-20T14:10:00Z");
    // Game 40 was first stored by a job that started after the stale one; game 41 was observed before the stale detail.
    await upsertGameDetails(database.db, [gameDetail(41, { playing: 300 })], first);
    await upsertGameDetails(database.db, [gameDetail(40, { playing: 700 }), gameDetail(41, { playing: 400 })], third);
    const stored = () =>
      database.db.select().from(games).where(inArray(games.universeId, [40, 41])).orderBy(games.universeId);
    const [game40, game41] = await stored();

    const result = await upsertGameDetails(
      database.db,
      [40, 41].map((id) => gameDetail(id, { name: `Game ${id} (stale)`, playing: 5 })),
      second,
    );

    expect(result).toEqual({ inserted: [], metadataChanged: [] });
    expect(await stored()).toEqual([{ ...game40, firstObservedAt: second }, game41]);
    expect(game40).toMatchObject({ name: "Game 40", lastCcu: 700, firstObservedAt: third, lastObservedAt: third });
    expect(await versionCount([40, 41])).toBe(2);
  });

  it("tracks the last observation with players", async () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 14, minutes));
    async function lastActiveAt(universeId: number): Promise<Date | null> {
      const [game] = await database.db.select({ lastActiveAt: games.lastActiveAt }).from(games).where(eq(games.universeId, universeId));
      return game.lastActiveAt;
    }
    await upsertGameDetails(database.db, [gameDetail(60, { playing: 0 }), gameDetail(61, { playing: 5 })], at(0));
    expect(await lastActiveAt(60)).toBeNull();
    expect(await lastActiveAt(61)).toEqual(at(0));
    await upsertGameDetails(database.db, [gameDetail(60, { playing: 12 })], at(5));
    expect(await lastActiveAt(60)).toEqual(at(5));
    await upsertGameDetails(database.db, [gameDetail(60, { playing: 0 })], at(10));
    expect(await lastActiveAt(60)).toEqual(at(5));
    // A late retry is older than the stored observation, so the stale-write guard ignores it, players or not.
    await upsertGameDetails(database.db, [gameDetail(60, { playing: 30 })], at(7));
    expect(await lastActiveAt(60)).toEqual(at(5));
    await upsertGameDetails(database.db, [gameDetail(60, { playing: 3 })], at(15));
    expect(await lastActiveAt(60)).toEqual(at(15));
  });

  it("skips resolved places and recent failures, and finds unpromoted universes", async () => {
    const now = new Date("2026-10-20T15:00:00Z");
    await savePlaceResolution(database.db, { placeId: 500, universeId: 50, resolvedAt: now, error: null });
    await savePlaceResolution(database.db, { placeId: 600, universeId: null, resolvedAt: now, error: "404" });
    await savePlaceResolution(database.db, { placeId: 700, universeId: null, resolvedAt: new Date("2026-10-01T00:00:00Z"), error: "404" });
    expect(await placesToSkip(database.db, [500, 600, 700, 800], now, 7)).toEqual(new Set([500, 600]));
    expect(await unpromotedUniverses(database.db, [500, 1_000_001])).toEqual([50]);
  });

  it("keeps a known place mapping when a later resolution fails", async () => {
    await savePlaceResolution(database.db, { placeId: 900, universeId: 90, resolvedAt: first, error: null });
    await savePlaceResolution(database.db, { placeId: 900, universeId: null, resolvedAt: second, error: "404" });
    const [place] = await database.db.select().from(places).where(eq(places.placeId, 900));
    expect(place).toEqual({ placeId: 900, universeId: 90, resolvedAt: first, error: null });
  });

  it("fills failed place resolutions from game details without overwriting known mappings", async () => {
    await savePlaceResolution(database.db, { placeId: 1_000_030, universeId: null, resolvedAt: first, error: "404" });
    await savePlaceResolution(database.db, { placeId: 1_000_031, universeId: 99, resolvedAt: first, error: null });
    await upsertGameDetails(database.db, [gameDetail(30), gameDetail(31)], second);
    const stored = await database.db
      .select()
      .from(places)
      .where(inArray(places.placeId, [1_000_030, 1_000_031]))
      .orderBy(places.placeId);
    expect(stored).toEqual([
      { placeId: 1_000_030, universeId: 30, resolvedAt: second, error: null },
      { placeId: 1_000_031, universeId: 99, resolvedAt: first, error: null },
    ]);
  });

  it("records discoveries and widens their seen window", async () => {
    await recordDiscoveries(database.db, [
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: second, lastSeenAt: second },
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: second, lastSeenAt: second },
    ]);
    await recordDiscoveries(database.db, [
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: first, lastSeenAt: first },
    ]);
    const [row] = await database.db.select().from(discoverySources).where(eq(discoverySources.universeId, 1));
    expect(row.firstSeenAt.toISOString()).toBe(first.toISOString());
    expect(row.lastSeenAt.toISOString()).toBe(second.toISOString());
  });

  it("merges duplicate discoveries within one call", async () => {
    const recorded = await recordDiscoveries(database.db, [
      { universeId: 1, source: "search", detail: "stone", firstSeenAt: second, lastSeenAt: second },
      { universeId: 1, source: "search", detail: "stone", firstSeenAt: first, lastSeenAt: first },
    ]);
    expect(recorded).toBe(1);
    const [row] = await database.db
      .select()
      .from(discoverySources)
      .where(and(eq(discoverySources.universeId, 1), eq(discoverySources.source, "search")));
    expect(row).toMatchObject({ firstSeenAt: first, lastSeenAt: second });
  });

  it("runs on a supported PostgreSQL version", async () => {
    await expect(assertSupportedPostgres(database.db)).resolves.toBeUndefined();
  });
});
