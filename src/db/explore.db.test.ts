import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { lastSearchedTerms, selectExplorationSeeds, type ExplorationSeedOptions } from "./explore";
import { upsertGameDetails } from "./games";
import { finishJobRun, startJobRun } from "./job-runs";
import { writeGameObservations } from "./observations";
import { jobRuns } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const options: ExplorationSeedOptions = { count: 20, maximumAgeDays: 60, windowHours: 6, minimumCcu: 50 };

describe.skipIf(!hasTestDatabase)("selectExplorationSeeds", () => {
  let database: TestDatabase;
  // The window holds the hourly buckets after 08:35 up to 14:35.
  const now = new Date("2026-10-20T14:35:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    const young = new Date("2026-10-01T00:00:00Z");
    await upsertGameDetails(database.db, [
      gameDetail(1, { name: "Small Riser", created: young }),
      gameDetail(2, { name: "Big Game", created: young }),
      gameDetail(3, { name: "Falling", created: young }),
      gameDetail(4, { name: "Old Hit", created: new Date("2025-01-01T00:00:00Z") }),
      gameDetail(5, { name: "Below Minimum", created: young }),
      gameDetail(9, { name: "Future Only", created: young }),
      gameDetail(10, { name: "Quiet Now", created: young }),
      gameDetail(12, { name: "Two Hours", created: young }),
      gameDetail(13, { name: "Seven Weeks Old", created: new Date("2026-09-01T00:00:00Z") }),
    ], new Date("2026-10-18T14:00:00Z"));
    // Found this morning: a seed like any other, with no history before.
    await upsertGameDetails(database.db, [gameDetail(8, { name: "Just Found", created: young })], new Date("2026-10-20T10:00:00Z"));
    const at = (iso: string, universeId: number, ccu: number) => ({ universeId, observedAt: new Date(iso), ccu, visits: 1, favorites: 1 });
    await writeGameObservations(database.db, [
      at("2026-10-20T13:00:00Z", 1, 2_000),
      at("2026-10-20T13:00:00Z", 2, 12_000),
      // Falling games are seeds too: their neighbours may be rising.
      at("2026-10-19T13:00:00Z", 3, 1_000),
      at("2026-10-20T13:00:00Z", 3, 200),
      at("2026-10-20T13:00:00Z", 4, 10_000),
      at("2026-10-20T13:00:00Z", 5, 40),
      at("2026-10-20T13:00:00Z", 8, 3_000),
      // After `now`: a replay of an earlier hour must not see it.
      at("2026-10-20T15:10:00Z", 9, 5_000),
      // The 08:00 bucket ends before the window.
      at("2026-10-20T08:20:00Z", 10, 9_000),
      // Two hours of the window average to 1,000.
      at("2026-10-20T10:00:00Z", 12, 800),
      at("2026-10-20T11:00:00Z", 12, 1_200),
      at("2026-10-20T12:00:00Z", 13, 800),
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("lists the young games read in the window at or above the minimum CCU, busiest first", async () => {
    expect(await selectExplorationSeeds(database.db, now, options)).toEqual([
      { universeId: 2, name: "Big Game", ccu: 12_000 },
      { universeId: 8, name: "Just Found", ccu: 3_000 },
      { universeId: 1, name: "Small Riser", ccu: 2_000 },
      { universeId: 12, name: "Two Hours", ccu: 1_000 },
      { universeId: 13, name: "Seven Weeks Old", ccu: 800 },
      { universeId: 3, name: "Falling", ccu: 200 },
    ]);
  });

  it("keeps the busiest seeds within the count, the age limit and the minimum CCU", async () => {
    const seeds = async (overrides: Partial<ExplorationSeedOptions>) =>
      (await selectExplorationSeeds(database.db, now, { ...options, ...overrides })).map((seed) => seed.universeId);
    expect(await seeds({ count: 2 })).toEqual([2, 8]);
    // Game 13 is 49 days old.
    expect(await seeds({ maximumAgeDays: 30 })).toEqual([2, 8, 1, 12, 3]);
    expect(await seeds({ minimumCcu: 500 })).toEqual([2, 8, 1, 12, 13]);
  });
});

describe.skipIf(!hasTestDatabase)("lastSearchedTerms", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-22T18:26:30Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(jobRuns);
  });

  async function exploreRun(slot: string, stats: Record<string, unknown>, job: "explore" | "charts" = "explore") {
    const id = randomUUID();
    await startJobRun(database.db, { id, job, slot: new Date(slot), startedAt: new Date(slot) });
    await finishJobRun(database.db, id, { status: "success", finishedAt: new Date(slot), durationMs: 1, stats });
  }

  it("returns the latest slot that searched each term, within the window", async () => {
    await exploreRun("2026-10-22T16:00:00Z", { terms: ["egg", "+1"] });
    await exploreRun("2026-10-22T17:00:00Z", { terms: ["egg"] });
    // Before the window, after `now`, another job, or a run without terms: none counts.
    await exploreRun("2026-10-21T17:00:00Z", { terms: ["chop"] });
    await exploreRun("2026-10-22T19:00:00Z", { terms: ["plane"] });
    await exploreRun("2026-10-22T17:00:00Z", { terms: ["steal"] }, "charts");
    await exploreRun("2026-10-22T15:00:00Z", { error: "x" });
    expect(await lastSearchedTerms(database.db, new Date("2026-10-21T18:26:30Z"), now)).toEqual(
      new Map([
        ["egg", new Date("2026-10-22T17:00:00Z")],
        ["+1", new Date("2026-10-22T16:00:00Z")],
      ]),
    );
  });
});
