import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { discoverySources, games } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { gameDetail } from "@/test/fixtures";
import { PromotionApiError, promoteUniverses } from "./promotion";

const now = new Date("2026-10-20T14:00:00Z");

// Like the Games API, the fake silently omits the universes it does not know.
function gamesApi(known: number[]) {
  return {
    getGameDetails: vi.fn<RobloxApi["getGameDetails"]>(async (universeIds) =>
      universeIds.map(Number).filter((universeId) => known.includes(universeId)).map((universeId) => gameDetail(universeId)),
    ),
  };
}

describe.skipIf(!hasTestDatabase)("promoteUniverses", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    // Deleting games cascades to discovery_sources.
    await database.db.delete(games);
  });

  it("promotes an unknown universe and records how it was found", async () => {
    const result = await promoteUniverses(database.db, gamesApi([1]), [{ universeId: 1, source: "chart", detail: "top-trending" }], now);

    expect(result).toEqual({ promoted: 1, discoveries: 1 });
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1]);
    expect(await database.db.select().from(discoverySources)).toEqual([
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: now, lastSeenAt: now },
    ]);
  });

  it("does not record a known game by default", async () => {
    await upsertGameDetails(database.db, [gameDetail(1)], now);
    const api = gamesApi([1]);

    const result = await promoteUniverses(database.db, api, [{ universeId: 1, source: "chart", detail: "top-trending" }], now);

    expect(result).toEqual({ promoted: 0, discoveries: 0 });
    expect(api.getGameDetails).not.toHaveBeenCalled();
    expect(await database.db.select().from(discoverySources)).toEqual([]);
  });

  it("records a known game with recordKnown", async () => {
    await upsertGameDetails(database.db, [gameDetail(1)], now);

    const result = await promoteUniverses(database.db, gamesApi([1]), [{ universeId: 1, source: "search", detail: "obby" }], now, {
      recordKnown: true,
    });

    expect(result).toEqual({ promoted: 0, discoveries: 1 });
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 1, source: "search", detail: "obby" }),
    ]);
  });

  it("neither promotes nor records a universe the Games API omits", async () => {
    const candidates = [
      { universeId: 1, source: "rolimons" as const, detail: "" },
      { universeId: 2, source: "rolimons" as const, detail: "" },
    ];

    const result = await promoteUniverses(database.db, gamesApi([1]), candidates, now);

    expect(result).toEqual({ promoted: 1, discoveries: 1 });
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1]);
    expect((await database.db.select().from(discoverySources)).map((row) => row.universeId)).toEqual([1]);
  });

  it("throws a Games API error to the caller as a PromotionApiError", async () => {
    const apiError = new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games");
    const api = {
      getGameDetails: async () => {
        throw apiError;
      },
    };

    const failure = await promoteUniverses(database.db, api, [{ universeId: 1, source: "rolimons", detail: "" }], now).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PromotionApiError);
    expect(failure).toMatchObject({
      name: "PromotionApiError",
      message: "Game details request failed: 503 Service Unavailable for games.roblox.com",
      cause: apiError,
    });
    expect(await database.db.select().from(games)).toEqual([]);
  });

  it("records known games with recordKnown before the Games API call, so its failure loses only the unknown ones", async () => {
    await upsertGameDetails(database.db, [gameDetail(1)], now);
    const api = {
      getGameDetails: async () => {
        throw new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games");
      },
    };
    const candidates = [
      { universeId: 1, source: "search" as const, detail: "obby" },
      { universeId: 2, source: "search" as const, detail: "obby" },
    ];

    const failure = await promoteUniverses(database.db, api, candidates, now, { recordKnown: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PromotionApiError);
    // The caller can still report what was recorded.
    expect(failure).toMatchObject({ recordedDiscoveries: 1 });
    expect(await database.db.select().from(discoverySources)).toEqual([
      { universeId: 1, source: "search", detail: "obby", firstSeenAt: now, lastSeenAt: now },
    ]);
  });

  it("records only known games and leaves the Games API alone with skipApi", async () => {
    await upsertGameDetails(database.db, [gameDetail(1)], now);
    const api = gamesApi([1, 2]);
    const candidates = [
      { universeId: 1, source: "search" as const, detail: "obby" },
      { universeId: 2, source: "search" as const, detail: "obby" },
    ];

    const result = await promoteUniverses(database.db, api, candidates, now, { recordKnown: true, skipApi: true });

    expect(result).toEqual({ promoted: 0, discoveries: 1 });
    expect(api.getGameDetails).not.toHaveBeenCalled();
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1]);
    expect((await database.db.select().from(discoverySources)).map((row) => row.universeId)).toEqual([1]);
  });

  it("records known and promoted games together with recordKnown", async () => {
    await upsertGameDetails(database.db, [gameDetail(1)], now);
    const candidates = [
      { universeId: 1, source: "search" as const, detail: "obby" },
      { universeId: 2, source: "search" as const, detail: "obby" },
      { universeId: 3, source: "search" as const, detail: "obby" },
    ];

    const result = await promoteUniverses(database.db, gamesApi([1, 2]), candidates, now, { recordKnown: true });

    expect(result).toEqual({ promoted: 1, discoveries: 2 });
    expect((await database.db.select().from(discoverySources)).map((row) => row.universeId).sort()).toEqual([1, 2]);
  });
});
