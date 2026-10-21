import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { selectRisingSeeds } from "./explore";
import { upsertGameDetails } from "./games";
import { writeGameObservations } from "./observations";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("selectRisingSeeds", () => {
  let database: TestDatabase;
  // The current window holds the hourly buckets after 08:35 today; the previous one, those after 08:35 yesterday up
  // to 14:35 yesterday.
  const now = new Date("2026-10-20T14:35:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    const young = new Date("2026-10-01T00:00:00Z");
    await upsertGameDetails(database.db, [
      gameDetail(1, { name: "Rising", created: young }),
      gameDetail(2, { name: "Brand New", created: young }),
      gameDetail(3, { name: "Falling", created: young }),
      gameDetail(4, { name: "Old Hit", created: new Date("2025-01-01T00:00:00Z") }),
      gameDetail(5, { name: "Quiet Now", created: young }),
      gameDetail(6, { name: "Before Yesterday's Window", created: young }),
      gameDetail(7, { name: "After Yesterday's Window", created: young }),
      gameDetail(8, { name: "Seven Weeks Old", created: new Date("2026-09-01T00:00:00Z") }),
    ], now);
    const at = (iso: string, universeId: number, ccu: number) => ({ universeId, observedAt: new Date(iso), ccu, visits: 1, favorites: 1 });
    await writeGameObservations(database.db, [
      at("2026-10-19T12:00:00Z", 1, 100),
      at("2026-10-20T13:00:00Z", 1, 5_000),
      // No data a day ago: the game rises from zero. Its two hours average to 400.
      at("2026-10-20T10:00:00Z", 2, 300),
      at("2026-10-20T14:30:00Z", 2, 500),
      at("2026-10-19T13:00:00Z", 3, 1_000),
      at("2026-10-20T13:00:00Z", 3, 200),
      at("2026-10-20T13:00:00Z", 4, 10_000),
      // The 08:00 bucket ends before the current window.
      at("2026-10-20T08:20:00Z", 5, 9_000),
      // Buckets just outside the previous window do not count against the gain.
      at("2026-10-19T08:20:00Z", 6, 3_000),
      at("2026-10-20T12:00:00Z", 6, 2_000),
      at("2026-10-19T15:00:00Z", 7, 4_000),
      at("2026-10-20T11:00:00Z", 7, 1_000),
      at("2026-10-20T12:00:00Z", 8, 800),
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("selects young games by their CCU gain over the last day", async () => {
    expect(await selectRisingSeeds(database.db, now, 10, 60)).toEqual([
      { universeId: 1, name: "Rising", gain: 4_900 },
      { universeId: 6, name: "Before Yesterday's Window", gain: 2_000 },
      { universeId: 7, name: "After Yesterday's Window", gain: 1_000 },
      { universeId: 8, name: "Seven Weeks Old", gain: 800 },
      { universeId: 2, name: "Brand New", gain: 400 },
    ]);
  });

  it("keeps the largest gains and honours the maximum age", async () => {
    expect((await selectRisingSeeds(database.db, now, 2, 60)).map((seed) => seed.universeId)).toEqual([1, 6]);
    expect((await selectRisingSeeds(database.db, now, 10, 30)).map((seed) => seed.universeId)).toEqual([1, 6, 7, 2]);
  });
});
