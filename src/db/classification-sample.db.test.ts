import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClassificationInput } from "@/lib/classify/types";
import { gameDetail } from "@/test/fixtures";
import { readClassificationSample, type SampleOptions } from "./classification-sample";
import { upsertGameDetails } from "./games";
import { writeGameObservations } from "./observations";
import { games } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

function universeIds(sample: ClassificationInput[], stratum: string): number[] {
  return sample.filter((input) => input.stratum === stratum).map((input) => input.universeId);
}

function ascending(ids: number[]): number[] {
  return [...ids].sort((left, right) => left - right);
}

describe.skipIf(!hasTestDatabase)("readClassificationSample", () => {
  let database: TestDatabase;
  // Young games were created after 2026-08-21, sixty days before now.
  const now = new Date("2026-10-20T00:00:00Z");
  const youngCreated = new Date("2026-10-01T00:00:00Z");
  const otherPlusOneIds = [2, 3, 4];
  const options: SampleOptions = {
    now,
    seed: "test-seed",
    requiredUniverseIds: [1],
    quotas: {
      "plus-one": 2,
      "verb-for-reward": 1,
      steal: 1,
      eggs: 1,
      fart: 1,
      "young-under-100": 1,
      "young-100-1k": 1,
      "young-1k-10k": 1,
      "young-10k-plus": 1,
      established: 1,
    },
    excludeUniverseIds: [],
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(
      database.db,
      [
        gameDetail(1, { name: "+1 Stone Skipping", description: "Skip stones across the lake.", created: new Date("2026-09-05T00:00:00Z") }),
        gameDetail(2, { name: "+1 Speed Keyboard Escape", created: youngCreated }),
        gameDetail(3, { name: "+1 Karate Evolution", created: youngCreated }),
        gameDetail(4, { name: "Every Second +1 Jump", created: youngCreated }),
        gameDetail(5, { name: "Bike For Egg!", created: youngCreated }),
        gameDetail(6, { name: "Steal An Egg", created: youngCreated }),
        gameDetail(7, { name: "Calm Fishing", created: youngCreated }),
        gameDetail(8, { name: "Tower Defense Rush", created: youngCreated }),
        gameDetail(9, { name: "Classic Hangout", created: new Date("2024-01-01T00:00:00Z") }),
      ],
      new Date("2026-10-01T00:00:00Z"),
    );
    await database.db.update(games).set({ thumbnailUrl: "https://tr.rbxcdn.com/stone-skipping" }).where(eq(games.universeId, 1));
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-09-20T18:00:00Z"), ccu: 160_000, visits: 5_000_000, favorites: 20_000 },
      { universeId: 7, observedAt: new Date("2026-10-10T18:00:00Z"), ccu: 50, visits: 1_000, favorites: 10 },
      // The peak is the highest day, not the latest one.
      { universeId: 8, observedAt: new Date("2026-10-10T18:00:00Z"), ccu: 5_000, visits: 100_000, favorites: 500 },
      { universeId: 8, observedAt: new Date("2026-10-18T18:00:00Z"), ccu: 800, visits: 150_000, favorites: 600 },
      // An old game is established whatever its peak.
      { universeId: 9, observedAt: new Date("2026-10-18T18:00:00Z"), ccu: 20_000, visits: 9_000_000, favorites: 40_000 },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("draws each stratum up to its quota, ordered by stratum", async () => {
    const sample = await readClassificationSample(database.db, options);

    // The required game matches the +1 pattern but stays required, outside the plus-one quota.
    expect(sample.map((input) => input.stratum)).toEqual([
      "required",
      "plus-one",
      "plus-one",
      "verb-for-reward",
      "steal",
      "young-under-100",
      "young-1k-10k",
      "established",
    ]);
    expect(sample[0]).toEqual({
      universeId: 1,
      name: "+1 Stone Skipping",
      description: "Skip stones across the lake.",
      genre: "Simulation",
      thumbnailUrl: "https://tr.rbxcdn.com/stone-skipping",
      robloxCreatedAt: "2026-09-05T00:00:00.000Z",
      peakCcu: 160_000,
      stratum: "required",
    });
    const plusOne = universeIds(sample, "plus-one");
    expect(new Set(plusOne).size).toBe(2);
    expect(otherPlusOneIds).toEqual(expect.arrayContaining(plusOne));
  });

  it("puts each game in the first stratum that applies", async () => {
    const sample = await readClassificationSample(database.db, options);
    const byId = new Map(sample.map((input) => [input.universeId, input]));

    expect(byId.get(5)).toMatchObject({ name: "Bike For Egg!", stratum: "verb-for-reward", peakCcu: 0, thumbnailUrl: null });
    expect(byId.get(6)).toMatchObject({ name: "Steal An Egg", stratum: "steal" });
    expect(byId.get(7)).toMatchObject({ stratum: "young-under-100", peakCcu: 50 });
    expect(byId.get(8)).toMatchObject({ stratum: "young-1k-10k", peakCcu: 5_000 });
    expect(byId.get(9)).toMatchObject({ stratum: "established", peakCcu: 20_000, robloxCreatedAt: "2024-01-01T00:00:00.000Z" });
  });

  it("draws the same games with the same seed", async () => {
    const first = await readClassificationSample(database.db, options);
    const second = await readClassificationSample(database.db, options);

    expect(second).toEqual(first);
  });

  it("draws the next game of a stratum in place of an excluded one", async () => {
    const drawn = universeIds(await readClassificationSample(database.db, options), "plus-one");
    const third = otherPlusOneIds.filter((id) => !drawn.includes(id));

    const sample = await readClassificationSample(database.db, { ...options, excludeUniverseIds: [drawn[0]] });

    expect(ascending(universeIds(sample, "plus-one"))).toEqual(ascending([drawn[1], ...third]));
    expect(sample.map((input) => input.universeId)).not.toContain(drawn[0]);
  });

  it("rejects a quota for a stratum that does not exist", async () => {
    await expect(readClassificationSample(database.db, { ...options, quotas: { ...options.quotas, "plus-two": 1 } })).rejects.toThrow(
      "plus-two",
    );
  });
});
