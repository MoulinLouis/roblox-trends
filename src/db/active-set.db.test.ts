import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { selectActiveUniverses } from "./active-set";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("selectActiveUniverses", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:00:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    const old = new Date("2025-01-01T00:00:00Z");
    await upsertGameDetails(database.db, [
      gameDetail(1, { playing: 5_000, created: old }),
      gameDetail(2, { playing: 0, created: old }),
      gameDetail(3, { playing: 0, created: old }),
      gameDetail(4, { playing: 10, created: new Date("2026-10-10T00:00:00Z") }),
      gameDetail(5, { playing: 0, created: old }),
      gameDetail(6, { playing: 0, created: old }),
      gameDetail(10, { playing: 0, created: old }),
    ], now);
    // Game 7 was busy when last returned, two days ago: Roblox has not returned it since (deleted, or malformed).
    await upsertGameDetails(database.db, [gameDetail(7, { playing: 3_000, created: old })], new Date("2026-10-18T14:00:00Z"));
    // Games 8 and 9 are young and empty now. Game 9 had players two days ago; game 8 had none for eight days.
    const young = new Date("2026-09-15T00:00:00Z");
    await upsertGameDetails(database.db, [gameDetail(8, { playing: 20, created: young })], new Date("2026-10-12T14:00:00Z"));
    await upsertGameDetails(database.db, [gameDetail(9, { playing: 20, created: young })], new Date("2026-10-18T14:00:00Z"));
    await upsertGameDetails(database.db, [gameDetail(8, { playing: 0, created: young }), gameDetail(9, { playing: 0, created: young })], now);
    // Game 2 peaked earlier today; game 3 only appears in the census; game 5 is quiet and its census count is too old;
    // game 6 peaked two days ago; game 10 peaked 23.5 hours ago, in the hour that straddles the window's start.
    await writeGameObservations(database.db, [
      { universeId: 2, observedAt: new Date("2026-10-20T09:00:00Z"), ccu: 800, visits: 1, favorites: 1 },
      { universeId: 6, observedAt: new Date("2026-10-18T09:00:00Z"), ccu: 900, visits: 1, favorites: 1 },
      { universeId: 10, observedAt: new Date("2026-10-19T14:30:00Z"), ccu: 300, visits: 1, favorites: 1 },
    ]);
    await savePlaceResolution(database.db, { placeId: 333, universeId: 3, resolvedAt: now, error: null });
    await savePlaceResolution(database.db, { placeId: 555, universeId: 5, resolvedAt: now, error: null });
    await writeCensusObservations(database.db, [
      { placeId: 333, observedAt: new Date("2026-10-20T13:50:00Z"), ccu: 120 },
      { placeId: 555, observedAt: new Date("2026-10-20T13:00:00Z"), ccu: 500 },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("selects busy, recently busy, census-visible and young active games by priority", async () => {
    const active = await selectActiveUniverses(database.db, now);
    expect(active).toEqual([
      { universeId: 1, priority: 5_000 },
      { universeId: 2, priority: 800 },
      { universeId: 10, priority: 300 },
      { universeId: 3, priority: 120 },
      { universeId: 4, priority: 10 },
      { universeId: 9, priority: 0 },
    ]);
  });
});
