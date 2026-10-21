import { between, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawFingerprint } from "@/lib/fingerprint";
import { gameDetail } from "@/test/fixtures";
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

  it("skips resolved places and recent failures, and finds unpromoted universes", async () => {
    const now = new Date("2026-10-20T15:00:00Z");
    await savePlaceResolution(database.db, { placeId: 500, universeId: 50, resolvedAt: now, error: null });
    await savePlaceResolution(database.db, { placeId: 600, universeId: null, resolvedAt: now, error: "404" });
    await savePlaceResolution(database.db, { placeId: 700, universeId: null, resolvedAt: new Date("2026-10-01T00:00:00Z"), error: "404" });
    expect(await placesToSkip(database.db, [500, 600, 700, 800], now, 7)).toEqual(new Set([500, 600]));
    expect(await unpromotedUniverses(database.db, [500, 1_000_001])).toEqual([50]);
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

  it("runs on a supported PostgreSQL version", async () => {
    await expect(assertSupportedPostgres(database.db)).resolves.toBeUndefined();
  });
});
