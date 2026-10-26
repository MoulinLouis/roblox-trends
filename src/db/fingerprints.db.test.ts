import { and, eq, gte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_FINGERPRINT_VERSION } from "@/lib/fingerprint";
import { gameDetail } from "@/test/fixtures";
import { refreshContentFingerprints } from "./fingerprints";
import { upsertGameDetails } from "./games";
import { games, gameVersions } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("content fingerprint refresh", () => {
  let database: TestDatabase;
  const observedAt = new Date("2026-10-20T14:00:00Z");
  const stale = { contentFingerprint: "stale", contentFingerprintVersion: CONTENT_FINGERPRINT_VERSION - 1 };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("brings content fingerprints of an earlier version up to the current one", async () => {
    await upsertGameDetails(
      database.db,
      [gameDetail(1, { name: "[🎃] +1 Stone Skipping", description: "Skip stones" }), gameDetail(2)],
      observedAt,
    );
    await database.db
      .insert(gameVersions)
      .values({ universeId: 1, kind: "thumbnail", rawFingerprint: "media:1", thumbnailUrl: "https://tr.rbxcdn.com/a", observedAt });
    // As an earlier version of the algorithm stored them.
    await database.db.update(games).set(stale).where(eq(games.universeId, 1));
    await database.db
      .update(gameVersions)
      .set(stale)
      .where(and(eq(gameVersions.universeId, 1), eq(gameVersions.kind, "metadata")));

    expect(await refreshContentFingerprints(database.db)).toEqual({ games: 1, versions: 1 });

    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.contentFingerprint).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
    expect(game.contentFingerprintVersion).toBe(CONTENT_FINGERPRINT_VERSION);
    const versions = await database.db
      .select({ kind: gameVersions.kind, contentFingerprint: gameVersions.contentFingerprint })
      .from(gameVersions)
      .where(eq(gameVersions.universeId, 1))
      .orderBy(gameVersions.kind);
    expect(versions).toEqual([
      { kind: "metadata", contentFingerprint: "f52b742d46d5d0fdd4da1893313c9c03a6210d47" },
      { kind: "thumbnail", contentFingerprint: null },
    ]);
    const [metadata] = await database.db
      .select({ contentFingerprintVersion: gameVersions.contentFingerprintVersion })
      .from(gameVersions)
      .where(and(eq(gameVersions.universeId, 1), eq(gameVersions.kind, "metadata")));
    expect(metadata.contentFingerprintVersion).toBe(CONTENT_FINGERPRINT_VERSION);
  });

  it("changes nothing when every content fingerprint is current", async () => {
    expect(await refreshContentFingerprints(database.db)).toEqual({ games: 0, versions: 0 });
  });

  // A release older than the version column rewrites a game's fingerprint and leaves the version it finds.
  it("rewrites a game fingerprint that another algorithm wrote under the current version", async () => {
    await database.db.update(games).set({ contentFingerprint: "stale" }).where(eq(games.universeId, 1));

    expect(await refreshContentFingerprints(database.db)).toEqual({ games: 1, versions: 0 });

    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.contentFingerprint).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
  });

  it("refreshes a backlog larger than one batch", async () => {
    const details = Array.from({ length: 2_501 }, (_, index) => gameDetail(10_000 + index));
    await upsertGameDetails(database.db, details, observedAt);
    await database.db.update(games).set(stale).where(gte(games.universeId, 10_000));
    await database.db.update(gameVersions).set(stale).where(gte(gameVersions.universeId, 10_000));

    expect(await refreshContentFingerprints(database.db)).toEqual({ games: 2_501, versions: 2_501 });

    const [remaining] = await database.db
      .select({ games: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.contentFingerprint, "stale"));
    expect(remaining.games).toBe(0);
    const [remainingVersions] = await database.db
      .select({ versions: sql<number>`count(*)::int` })
      .from(gameVersions)
      .where(eq(gameVersions.contentFingerprint, "stale"));
    expect(remainingVersions.versions).toBe(0);
  });
});
