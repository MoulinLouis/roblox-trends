import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { games, gameVersions, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import type { GameThumbnailAnswer } from "@/lib/api/roblox";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createThumbnailsJob } from "./thumbnails";

const getThumbnails = async (ids: string[]) => new Map(ids.map((id) => [id, `https://tr.rbxcdn.com/icon-${id}`]));

function answersFrom(thumbnails: Record<string, GameThumbnailAnswer>, ids: string[]): Map<string, GameThumbnailAnswer> {
  return new Map(ids.filter((id) => id in thumbnails).map((id) => [id, thumbnails[id]]));
}

function job(thumbnails: Record<string, GameThumbnailAnswer>) {
  return createThumbnailsJob({ roblox: { getGameThumbnails: async (ids) => answersFrom(thumbnails, ids), getThumbnails } });
}

describe.skipIf(!hasTestDatabase)("thumbnails job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1), gameDetail(2), gameDetail(3), gameDetail(4)], new Date("2026-10-20T13:00:00Z"));
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function game(universeId: number) {
    const [row] = await database.db.select().from(games).where(eq(games.universeId, universeId));
    return row;
  }

  async function thumbnailVersions(universeId: number) {
    const rows = await database.db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.universeId, universeId))
      .orderBy(gameVersions.observedAt);
    return rows.filter((version) => version.kind === "thumbnail");
  }

  it("stores a custom thumbnail, marks a game without one as checked, and retries pending and unknown games", async () => {
    const status = await executeJob(
      job({ "1": { imageUrl: "https://tr.rbxcdn.com/a/Image", mediaId: 101 }, "2": null, "4": "pending" }),
      database.db,
      new Date("2026-10-20T14:45:00Z"),
    );
    expect(status).toBe("degraded"); // game 3 is unknown: 3 of 4 answered (pending counts as an answer)
    expect(await game(1)).toMatchObject({ thumbnailUrl: "https://tr.rbxcdn.com/a/Image", thumbnailKey: "media:101", iconUrl: "https://tr.rbxcdn.com/icon-1" });
    expect((await game(1)).thumbnailsCheckedAt).toEqual(new Date("2026-10-20T14:45:00Z"));
    expect(await game(2)).toMatchObject({ thumbnailUrl: null, thumbnailKey: null });
    expect((await game(2)).thumbnailsCheckedAt).not.toBeNull();
    expect((await game(3)).thumbnailsCheckedAt).toBeNull();
    expect((await game(3)).iconUrl).toBe("https://tr.rbxcdn.com/icon-3");
    expect((await game(4)).thumbnailsCheckedAt).toBeNull();
    expect(await thumbnailVersions(1)).toMatchObject([
      { rawFingerprint: "media:101", thumbnailUrl: "https://tr.rbxcdn.com/a/Image", observedAt: new Date("2026-10-20T14:45:00Z") },
    ]);
    const [run] = await database.db.select().from(jobRuns);
    expect(run.stats).toMatchObject({
      requested: 4,
      answered: 3,
      withThumbnail: 1,
      withoutThumbnail: 1,
      pending: 1,
      icons: 4,
      changed: 1,
      http: { attempts: 0, retries: 0, rateLimitedResponses: 0 },
    });
  });

  it("keys versions on the media id: a new URL for the same image is not a new version", async () => {
    const status = await executeJob(
      job({ "1": { imageUrl: "https://tr.rbxcdn.com/b/Image", mediaId: 101 }, "2": null, "3": null, "4": "pending" }),
      database.db,
      new Date("2026-10-21T16:00:00Z"),
    );
    expect(status).toBe("success"); // every game answered, one of them pending
    expect((await game(1)).thumbnailUrl).toBe("https://tr.rbxcdn.com/b/Image");
    expect(await thumbnailVersions(1)).toHaveLength(1);
  });

  it("records a version when the image changes", async () => {
    await executeJob(job({ "1": { imageUrl: "https://tr.rbxcdn.com/c/Image", mediaId: 202 } }), database.db, new Date("2026-10-22T17:00:00Z"));
    expect((await game(1)).thumbnailKey).toBe("media:202");
    expect(await thumbnailVersions(1)).toHaveLength(2);
  });

  it("keeps the previous thumbnail on an empty answer and keeps a pending game due", async () => {
    const status = await executeJob(
      job({ "1": null, "2": "pending", "3": null, "4": "pending" }),
      database.db,
      new Date("2026-10-23T18:00:00Z"),
    );
    expect(status).toBe("success");
    expect(await game(1)).toMatchObject({
      thumbnailUrl: "https://tr.rbxcdn.com/c/Image",
      thumbnailKey: "media:202",
      thumbnailsCheckedAt: new Date("2026-10-23T18:00:00Z"),
    });
    expect(await thumbnailVersions(1)).toHaveLength(2);
    // Game 2 was last checked by the second run; a pending answer leaves it due for the next one.
    expect((await game(2)).thumbnailsCheckedAt).toEqual(new Date("2026-10-21T16:00:00Z"));
  });

  it("fails when Roblox answers for no game at all", async () => {
    expect(await executeJob(job({}), database.db, new Date("2026-10-24T19:00:00Z"))).toBe("failed");
  });

  it("records an image change once when two runs overlap", async () => {
    const answers = { "1": { imageUrl: "https://tr.rbxcdn.com/d/Image", mediaId: 303 } };
    // The outer run selects its games, then the inner run saves the same change before the outer run saves it.
    const outer = createThumbnailsJob({
      roblox: {
        getGameThumbnails: async (ids) => {
          await executeJob(job(answers), database.db, new Date("2026-10-25T20:01:00Z"));
          return answersFrom(answers, ids);
        },
        getThumbnails,
      },
    });
    await executeJob(outer, database.db, new Date("2026-10-25T20:00:00Z"));
    expect((await game(1)).thumbnailKey).toBe("media:303");
    expect(await thumbnailVersions(1)).toMatchObject([
      { rawFingerprint: "media:101" },
      { rawFingerprint: "media:202" },
      { rawFingerprint: "media:303", observedAt: new Date("2026-10-25T20:01:00Z") },
    ]);
  });
});

describe.skipIf(!hasTestDatabase)("thumbnails job with more games than one transaction", () => {
  let database: TestDatabase;
  const universeIds = Array.from({ length: 1_200 }, (_, index) => index + 1);

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, universeIds.map((id) => gameDetail(id)), new Date("2026-10-20T13:00:00Z"));
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("saves every game and its version", async () => {
    const answers = Object.fromEntries(universeIds.map((id) => [String(id), { imageUrl: `https://tr.rbxcdn.com/${id}/Image`, mediaId: id }]));
    expect(await executeJob(job(answers), database.db, new Date("2026-10-20T14:45:00Z"))).toBe("success");
    const checked = await database.db.select({ universeId: games.universeId }).from(games).where(isNotNull(games.thumbnailKey));
    expect(checked).toHaveLength(universeIds.length);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.kind, "thumbnail"))).toHaveLength(universeIds.length);
  });
});
