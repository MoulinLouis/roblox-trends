import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { games, gameVersions, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { selectGamesNeedingThumbnails } from "@/db/thumbnails";
import type { GameThumbnail, GameThumbnailAnswer } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createThumbnailsJob, type ThumbnailsDependencies } from "./thumbnails";

type Roblox = ThumbnailsDependencies["roblox"];

const { batchSize, deadlineMs, maximumConsecutiveFailedBatches } = JOB_CONFIG.thumbnails;

const iconsFor: Roblox["getThumbnails"] = async (ids) => new Map(ids.map((id) => [id, `https://tr.rbxcdn.com/icon-${id}`]));
const noIcons: Roblox["getThumbnails"] = async () => new Map();

function image(name: string, mediaId: number): GameThumbnail {
  return { imageUrl: `https://tr.rbxcdn.com/${name}/Image`, mediaId };
}

function answersFrom(thumbnails: Record<string, GameThumbnailAnswer>, ids: string[]): Map<string, GameThumbnailAnswer> {
  return new Map(ids.filter((id) => id in thumbnails).map((id) => [id, thumbnails[id]]));
}

function job(thumbnails: Record<string, GameThumbnailAnswer>, getThumbnails = iconsFor) {
  return createThumbnailsJob({ roblox: { getGameThumbnails: async (ids) => answersFrom(thumbnails, ids), getThumbnails } });
}

describe.skipIf(!hasTestDatabase)("thumbnails job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  // Each run follows a poll of games 1 to 4, as in production: a checked game is refreshed only while its CCU is recent.
  async function polledRun(at: string, definition: ReturnType<typeof job>) {
    const now = new Date(at);
    await upsertGameDetails(database.db, [1, 2, 3, 4].map((id) => gameDetail(id)), now);
    return executeJob(definition, database.db, now);
  }

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
    const status = await polledRun("2026-10-20T14:45:00Z", job({ "1": image("a", 101), "2": null, "4": "pending" }));
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
      attempted: 4,
      answered: 3,
      withThumbnail: 1,
      withoutThumbnail: 1,
      pending: 1,
      errored: 0,
      icons: 4,
      changed: 1,
      failedBatches: 0,
      skipped: 0,
      stoppedBy: null,
      http: { attempts: 0, retries: 0, rateLimitedResponses: 0 },
    });
  });

  it("keys versions on the media id: a new URL for the same image is not a new version", async () => {
    const status = await polledRun("2026-10-21T16:00:00Z", job({ "1": image("b", 101), "2": null, "3": null, "4": "pending" }));
    expect(status).toBe("success"); // every game answered, one of them pending
    expect((await game(1)).thumbnailUrl).toBe("https://tr.rbxcdn.com/b/Image");
    expect(await thumbnailVersions(1)).toHaveLength(1);
  });

  it("records a version when the image changes", async () => {
    await polledRun("2026-10-22T17:00:00Z", job({ "1": image("c", 202) }));
    expect((await game(1)).thumbnailKey).toBe("media:202");
    expect(await thumbnailVersions(1)).toHaveLength(2);
  });

  it("keeps the previous thumbnail and icon on empty answers and keeps a pending game due", async () => {
    const status = await polledRun("2026-10-23T18:00:00Z", job({ "1": null, "2": "pending", "3": null, "4": "pending" }, noIcons));
    expect(status).toBe("success");
    expect(await game(1)).toMatchObject({
      thumbnailUrl: "https://tr.rbxcdn.com/c/Image",
      thumbnailKey: "media:202",
      iconUrl: "https://tr.rbxcdn.com/icon-1",
      thumbnailsCheckedAt: new Date("2026-10-23T18:00:00Z"),
    });
    expect(await thumbnailVersions(1)).toHaveLength(2);
    // Game 2 was last checked by the second run; a pending answer leaves it due for the next one.
    expect((await game(2)).thumbnailsCheckedAt).toEqual(new Date("2026-10-21T16:00:00Z"));
  });

  it("fails when Roblox answers for no game at all", async () => {
    expect(await polledRun("2026-10-24T19:00:00Z", job({}))).toBe("failed");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.status, "failed"));
    expect(run.error).toContain("answered for none of 4 games");
  });

  it("records an image change once when two runs overlap", async () => {
    const answers = { "1": image("d", 303) };
    // The outer run selects its games, then the inner run saves the same change before the outer run saves it.
    const outer = createThumbnailsJob({
      roblox: {
        getGameThumbnails: async (ids) => {
          await executeJob(job(answers), database.db, new Date("2026-10-25T20:01:00Z"));
          return answersFrom(answers, ids);
        },
        getThumbnails: iconsFor,
      },
    });
    await polledRun("2026-10-25T20:00:00Z", outer);
    expect((await game(1)).thumbnailKey).toBe("media:303");
    expect(await thumbnailVersions(1)).toMatchObject([
      { rawFingerprint: "media:101" },
      { rawFingerprint: "media:202" },
      { rawFingerprint: "media:303", observedAt: new Date("2026-10-25T20:01:00Z") },
    ]);
  });
});

describe.skipIf(!hasTestDatabase)("thumbnails job batches and game selection", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:45:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    // Deleting games cascades to game_versions.
    await database.db.delete(games);
    await database.db.delete(jobRuns);
  });

  // Never checked and busiest first, so the first batch holds the lowest universe ids.
  async function insertGames(count: number, observedAt = now): Promise<number[]> {
    const universeIds = Array.from({ length: count }, (_, index) => index + 1);
    await upsertGameDetails(database.db, universeIds.map((id) => gameDetail(id, { playing: 10_000 - id })), observedAt);
    return universeIds;
  }

  function allAnswered(universeIds: number[]): Record<string, GameThumbnailAnswer> {
    return Object.fromEntries(universeIds.map((id) => [String(id), image(String(id), id)]));
  }

  async function keyedGames(): Promise<number[]> {
    const rows = await database.db.select({ universeId: games.universeId }).from(games).where(isNotNull(games.thumbnailKey));
    return rows.map((row) => row.universeId).sort((left, right) => left - right);
  }

  async function runStats() {
    const [run] = await database.db.select().from(jobRuns);
    return run.stats;
  }

  function due() {
    const config = JOB_CONFIG.thumbnails;
    return selectGamesNeedingThumbnails(database.db, now, {
      refreshHours: config.refreshHours,
      refreshMinimumCcu: config.refreshMinimumCcu,
      refreshMaximumCcuAgeHours: config.refreshMaximumCcuAgeHours,
      limit: config.maximumGamesPerRun,
    });
  }

  it("saves every batch", async () => {
    const universeIds = await insertGames(3 * batchSize);
    expect(await executeJob(job(allAnswered(universeIds)), database.db, now)).toBe("success");
    expect(await keyedGames()).toEqual(universeIds);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.kind, "thumbnail"))).toHaveLength(universeIds.length);
  });

  it("stops after repeated unanswered batches and keeps the batch it saved", async () => {
    // One answered batch, then one unanswered batch more than the stop allows: the stop skips the last batch.
    const universeIds = await insertGames((maximumConsecutiveFailedBatches + 2) * batchSize);
    const firstBatch = universeIds.slice(0, batchSize);
    let thumbnailCalls = 0;
    let iconCalls = 0;
    const definition = createThumbnailsJob({
      roblox: {
        getGameThumbnails: async (ids) => {
          thumbnailCalls += 1;
          return thumbnailCalls === 1 ? answersFrom(allAnswered(universeIds), ids) : new Map();
        },
        getThumbnails: async (ids) => {
          iconCalls += 1;
          return iconsFor(ids);
        },
      },
    });
    expect(await executeJob(definition, database.db, now)).toBe("degraded");
    expect(await keyedGames()).toEqual(firstBatch);
    expect(thumbnailCalls).toBe(1 + maximumConsecutiveFailedBatches);
    expect(iconCalls).toBe(1); // an unanswered batch fails before its icons are requested
    expect(await runStats()).toMatchObject({
      requested: universeIds.length,
      attempted: (1 + maximumConsecutiveFailedBatches) * batchSize,
      answered: batchSize,
      icons: batchSize,
      failedBatches: maximumConsecutiveFailedBatches,
      skipped: batchSize,
      stoppedBy: "repeatedFailures",
    });
  });

  it("stops at the deadline and keeps the batch it saved", async () => {
    const universeIds = await insertGames(2 * batchSize);
    let time = 0;
    const definition = createThumbnailsJob({
      clock: () => time,
      roblox: {
        getGameThumbnails: async (ids) => {
          time += deadlineMs + 1;
          return answersFrom(allAnswered(universeIds), ids);
        },
        getThumbnails: iconsFor,
      },
    });
    expect(await executeJob(definition, database.db, now)).toBe("degraded");
    expect(await keyedGames()).toEqual(universeIds.slice(0, batchSize));
    expect(await runStats()).toMatchObject({ attempted: batchSize, answered: batchSize, skipped: batchSize, stoppedBy: "deadline" });
  });

  it("counts errors as answers and keeps the erroring games due", async () => {
    await insertGames(2);
    expect(await executeJob(job({ "1": "error", "2": "error" }), database.db, now)).toBe("success");
    expect(await runStats()).toMatchObject({ requested: 2, answered: 2, errored: 2, withThumbnail: 0 });
    expect(await due()).toEqual([1, 2]);
  });

  it("does not refresh a busy game whose CCU is stale", async () => {
    // Game 1 has not been polled for weeks: Roblox may have stopped returning it.
    await upsertGameDetails(database.db, [gameDetail(1, { playing: 5_000 })], new Date("2026-10-01T00:00:00Z"));
    await upsertGameDetails(database.db, [gameDetail(2)], new Date("2026-10-20T14:00:00Z"));
    await database.db.update(games).set({ thumbnailsCheckedAt: new Date("2026-10-02T00:00:00Z") });
    expect(await due()).toEqual([2]);
  });

  it("selects a never-checked game without a CCU time", async () => {
    await insertGames(1);
    await database.db.update(games).set({ lastCcuAt: null });
    expect(await due()).toEqual([1]);
  });
});
