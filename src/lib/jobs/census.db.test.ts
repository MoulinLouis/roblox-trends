import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { censusObservations, discoverySources, games, places } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { createCensusJob } from "./census";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("census job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("stores the list, resolves eligible places and promotes their universes", async () => {
    const job = createCensusJob({
      fetchGames: async () => ({
        games: [
          { placeId: "1", name: "Big", ccu: 500, thumbnailUrl: "" },
          { placeId: "2", name: "Small", ccu: 50, thumbnailUrl: "" },
          { placeId: "404", name: "Gone", ccu: 300, thumbnailUrl: "" },
        ],
        rejected: 0,
      }),
      roblox: {
        resolveUniverseId: async (placeId) => {
          if (placeId === "404") return null;
          return String(Number(placeId) + 1_000);
        },
        getGameDetails: async (universeIds) => universeIds.map((universeId) => gameDetail(Number(universeId))),
      },
    });

    const status = await executeJob(job, database.db, new Date("2026-10-20T14:13:00Z"));

    expect(status).toBe("success");
    expect(await database.db.select().from(censusObservations)).toHaveLength(3);
    const [resolved] = await database.db.select().from(places).where(eq(places.placeId, 1));
    expect(resolved.universeId).toBe(1_001);
    const [unresolvable] = await database.db.select().from(places).where(eq(places.placeId, 404));
    expect(unresolvable).toMatchObject({ universeId: null, error: "no universe" });
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1_001]);
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 1_001, source: "rolimons", detail: "" }),
    ]);
  });

  it("marks a run degraded when the list shrinks sharply against the last successful run", async () => {
    const job = createCensusJob({
      fetchGames: async () => ({ games: [{ placeId: "1", name: "Big", ccu: 500, thumbnailUrl: "" }], rejected: 0 }),
      roblox: {
        resolveUniverseId: async (placeId) => String(Number(placeId) + 1_000),
        getGameDetails: async (universeIds) => universeIds.map((universeId) => gameDetail(Number(universeId))),
      },
    });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:23:00Z"))).toBe("degraded");
  });
});
