import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { enqueueCandidates, selectPromotionCandidates, settleCandidates } from "./candidates";
import { recordDiscoveries } from "./discovery";
import { upsertGameDetails } from "./games";
import { discoveryCandidates, discoverySources, games } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("discovery candidates", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-22T18:30:00Z");
  const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const limits = { limit: 10, maximumAgeHours: 24, retryHours: 6 };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(discoveryCandidates);
    // Deleting games cascades to discovery_sources.
    await database.db.delete(games);
  });

  async function queued() {
    const rows = await database.db.select().from(discoveryCandidates).orderBy(discoveryCandidates.universeId, discoveryCandidates.detail);
    return rows.map((row) => [row.universeId, row.source, row.detail, row.playerCount, row.firstSeenAt, row.lastSeenAt, row.attemptedAt]);
  }

  it("widens the window of a queued sighting and keeps the CCU of its latest sighting", async () => {
    await enqueueCandidates(database.db, [
      { universeId: 7, source: "search", detail: "+1", playerCount: 800, seenAt: hoursBefore(2) },
      // Twice in one call, as two pages of one search can list a game: the higher CCU wins a tie.
      { universeId: 7, source: "search", detail: "+1", playerCount: 900, seenAt: hoursBefore(2) },
    ]);
    await enqueueCandidates(database.db, [{ universeId: 7, source: "search", detail: "+1", playerCount: 1_200, seenAt: hoursBefore(1) }]);
    // A late writer with an older sighting keeps the window but not its CCU.
    await enqueueCandidates(database.db, [{ universeId: 7, source: "search", detail: "+1", playerCount: 50, seenAt: hoursBefore(3) }]);
    expect(await queued()).toEqual([[7, "search", "+1", 1_200, hoursBefore(3), hoursBefore(1), null]]);
  });

  it("selects the busiest untracked candidates listed within the age limit, and retries unanswered ones later", async () => {
    await upsertGameDetails(database.db, [gameDetail(4)], now);
    await enqueueCandidates(database.db, [
      { universeId: 1, source: "search", detail: "steal", playerCount: 2_400, seenAt: hoursBefore(1) },
      // One universe from two sources counts once, with its highest CCU.
      { universeId: 2, source: "search", detail: "paper", playerCount: 300, seenAt: hoursBefore(1) },
      { universeId: 2, source: "chart", detail: "up-and-coming:us", playerCount: 4_300, seenAt: hoursBefore(1) },
      { universeId: 3, source: "recommendation", detail: "11", playerCount: 380, seenAt: hoursBefore(1) },
      // Tracked since: poll must not request it as a candidate.
      { universeId: 4, source: "search", detail: "egg", playerCount: 9_000, seenAt: hoursBefore(1) },
      // Not listed again for a day.
      { universeId: 5, source: "search", detail: "egg", playerCount: 8_000, seenAt: hoursBefore(25) },
    ]);
    expect(await selectPromotionCandidates(database.db, now, limits)).toEqual([
      { universeId: 2, playerCount: 4_300 },
      { universeId: 1, playerCount: 2_400 },
      { universeId: 3, playerCount: 380 },
    ]);
    expect(await selectPromotionCandidates(database.db, now, { ...limits, limit: 1 })).toEqual([{ universeId: 2, playerCount: 4_300 }]);

    // Roblox did not answer universe 1: it waits six hours.
    await settleCandidates(database.db, hoursBefore(5), [1], { maximumAgeHours: 24 });
    expect((await selectPromotionCandidates(database.db, now, limits)).map((candidate) => candidate.universeId)).toEqual([2, 3]);
    await settleCandidates(database.db, hoursBefore(7), [1], { maximumAgeHours: 24 });
    expect((await selectPromotionCandidates(database.db, now, limits)).map((candidate) => candidate.universeId)).toEqual([2, 1, 3]);
  });

  it("moves the sightings of tracked games to their discovery rows and dates their first observation from them", async () => {
    await enqueueCandidates(database.db, [
      { universeId: 1, source: "search", detail: "steal", playerCount: 2_400, seenAt: hoursBefore(3) },
      { universeId: 1, source: "chart", detail: "up-and-coming:us", playerCount: 2_400, seenAt: hoursBefore(2) },
      { universeId: 2, source: "search", detail: "chop", playerCount: 380, seenAt: hoursBefore(2) },
      { universeId: 3, source: "search", detail: "egg", playerCount: 100, seenAt: hoursBefore(30) },
    ]);
    // Poll promoted game 1 now; census promoted game 2 earlier than explore saw it, and saw it itself.
    await upsertGameDetails(database.db, [gameDetail(1)], now);
    await upsertGameDetails(database.db, [gameDetail(2)], hoursBefore(4));
    await recordDiscoveries(database.db, [{ universeId: 2, source: "rolimons", detail: "", firstSeenAt: hoursBefore(4), lastSeenAt: hoursBefore(4) }]);

    expect(await settleCandidates(database.db, now, [], { maximumAgeHours: 24 })).toBe(2);

    const sources = await database.db.select().from(discoverySources).orderBy(discoverySources.universeId, discoverySources.source);
    expect(sources.map((row) => [row.universeId, row.source, row.detail, row.firstSeenAt])).toEqual([
      [1, "chart", "up-and-coming:us", hoursBefore(2)],
      [1, "search", "steal", hoursBefore(3)],
      [2, "rolimons", "", hoursBefore(4)],
      [2, "search", "chop", hoursBefore(2)],
    ]);
    const firstObserved = async (universeId: number) =>
      (await database.db.select({ at: games.firstObservedAt }).from(games).where(eq(games.universeId, universeId)))[0].at;
    // The discovery path of game 1 is the search that saw it first; game 2 keeps its earlier census sighting.
    expect(await firstObserved(1)).toEqual(hoursBefore(3));
    expect(await firstObserved(2)).toEqual(hoursBefore(4));
    // Game 3 was not listed for more than a day: it is dropped.
    expect(await queued()).toEqual([]);
  });
});
