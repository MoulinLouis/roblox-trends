import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finishJobRun, startJobRun } from "@/db/job-runs";
import { censusObservations, discoverySources, games, jobRuns, places } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { JOB_CONFIG } from "@/lib/config";
import type { JobStatus } from "@/lib/jobs/types";
import { gameDetail } from "@/test/fixtures";
import { createCensusJob, type CensusDependencies } from "./census";
import { executeJob } from "./runner";

const config = JOB_CONFIG.census;
const now = new Date("2026-10-20T14:13:00Z");
const hourMs = 60 * 60 * 1000;
const universesUrl = "https://apis.roblox.com/universes/v1/places";

function place(placeId: number, ccu: number): RolimonsGame {
  return { placeId: String(placeId), name: `Place ${placeId}`, ccu, thumbnailUrl: "" };
}

// Places below the promotion threshold: they bring the list to its minimum length and are never resolved.
function filler(count = config.minimumListed): RolimonsGame[] {
  return Array.from({ length: count }, (_, index) => place(100_000 + index, 10));
}

const roblox: CensusDependencies["roblox"] = {
  resolveUniverseId: async (placeId) => String(Number(placeId) + 1_000),
  getGameDetails: async (universeIds) => universeIds.map((universeId) => gameDetail(Number(universeId))),
};

function censusJob(listed: RolimonsGame[], overrides: Partial<CensusDependencies> = {}) {
  return createCensusJob({ fetchGames: async () => ({ games: listed, rejected: 0 }), roblox, ...overrides });
}

describe.skipIf(!hasTestDatabase)("census job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(jobRuns);
    await database.db.delete(censusObservations);
    await database.db.delete(places);
    // Deleting games cascades to discovery_sources and game_versions.
    await database.db.delete(games);
  });

  // A finished census run, started at a wall-clock time like the runner records it.
  async function recordRun(
    status: Exclude<JobStatus, "running">,
    stats: { listed: number; listQuality: "success" | "degraded" },
    startedAt: Date,
  ): Promise<void> {
    const id = randomUUID();
    await startJobRun(database.db, { id, job: "census", slot: startedAt, startedAt });
    await finishJobRun(database.db, id, { status, finishedAt: startedAt, durationMs: 0, stats });
  }

  function hoursAgo(hours: number): Date {
    return new Date(Date.now() - hours * hourMs);
  }

  async function lastRunStats(): Promise<Record<string, unknown>> {
    const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
    return run.stats;
  }

  async function placeRow(placeId: number) {
    const [row] = await database.db.select().from(places).where(eq(places.placeId, placeId));
    return row;
  }

  it("stores the list, resolves eligible places and promotes their universes", async () => {
    const listed = [place(1, 500), place(2, 50), place(404, 300), place(400, 200), ...filler()];
    const job = createCensusJob({
      fetchGames: async () => ({ games: listed, rejected: 2 }),
      roblox: {
        ...roblox,
        resolveUniverseId: async (placeId) => {
          if (placeId === "404") return null;
          if (placeId === "400") throw new HttpError(400, "Bad Request", universesUrl);
          return String(Number(placeId) + 1_000);
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("success");

    expect(await database.db.select().from(censusObservations)).toHaveLength(listed.length);
    expect((await placeRow(1)).universeId).toBe(1_001);
    expect(await placeRow(404)).toMatchObject({ universeId: null, error: "no universe" });
    expect(await placeRow(400)).toMatchObject({ universeId: null, error: expect.stringContaining("400") });
    expect(await placeRow(2)).toBeUndefined();
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1_001]);
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 1_001, source: "rolimons", detail: "" }),
    ]);
    expect(await lastRunStats()).toEqual({
      listed: listed.length,
      rejected: 2,
      listQuality: "success",
      eligible: 3,
      resolved: 1,
      unresolvable: 2,
      resolutionFailures: 0,
      deferred: 0,
      promotionRequested: 1,
      promoted: 1,
    });
  });

  it("degrades a list that shrinks sharply against a recent good list", async () => {
    await recordRun("success", { listed: config.minimumListed * 2, listQuality: "success" }, hoursAgo(1));

    expect(await executeJob(censusJob(filler()), database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "degraded" });
  });

  it("ignores a good list older than the baseline window", async () => {
    await recordRun("success", { listed: config.minimumListed * 2, listQuality: "success" }, hoursAgo(config.baselineMaxAgeHours + 1));

    expect(await executeJob(censusJob(filler()), database.db, now)).toBe("success");
  });

  it("takes the good list of a run degraded for another reason as the baseline", async () => {
    await recordRun("degraded", { listed: config.minimumListed * 2, listQuality: "success" }, hoursAgo(1));

    expect(await executeJob(censusJob(filler()), database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "degraded" });
  });

  it.each(["degraded list", "failed run"] as const)("never takes a %s as the baseline", async (kind) => {
    await recordRun("success", { listed: config.minimumListed, listQuality: "success" }, hoursAgo(2));
    const doubled = config.minimumListed * 2;
    if (kind === "degraded list") await recordRun("degraded", { listed: doubled, listQuality: "degraded" }, hoursAgo(1));
    else await recordRun("failed", { listed: doubled, listQuality: "success" }, hoursAgo(1));

    expect(await executeJob(censusJob(filler()), database.db, now)).toBe("success");
  });

  it("defers the remaining places when the resolution budget runs out", async () => {
    // Each reading advances by two thirds of the budget, so only the first place fits in it.
    let elapsedMs = 0;
    const job = censusJob([place(1, 500), place(2, 400), place(3, 300), ...filler()], {
      clock: () => (elapsedMs += (config.resolutionBudgetMs * 2) / 3),
    });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await lastRunStats()).toMatchObject({ resolved: 1, deferred: 2 });
    expect(await placeRow(2)).toBeUndefined();
  });

  it("retries a place whose resolution failed without failing the run", async () => {
    const job = censusJob([place(1, 500), place(503, 400), ...filler()], {
      roblox: {
        ...roblox,
        resolveUniverseId: async (placeId) => {
          if (placeId === "503") throw new HttpError(503, "Service Unavailable", universesUrl);
          return String(Number(placeId) + 1_000);
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await placeRow(503)).toBeUndefined();
    expect(await lastRunStats()).toMatchObject({ resolved: 1, resolutionFailures: 1 });
  });

  const failingRoblox: CensusDependencies["roblox"] = {
    ...roblox,
    resolveUniverseId: async () => {
      throw new Error("socket hang up");
    },
  };

  it("keeps the run successful when a single place keeps failing", async () => {
    const job = censusJob([place(1, 500), ...filler()], { roblox: failingRoblox });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await lastRunStats()).toMatchObject({ resolved: 0, resolutionFailures: 1 });
  });

  it("degrades the run when several attempted resolutions fail and none succeeds", async () => {
    const failing = Array.from({ length: config.stalledResolutionFailures }, (_, index) => place(index + 1, 500));
    const job = censusJob([...failing, ...filler()], { roblox: failingRoblox });

    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({
      listQuality: "success",
      resolved: 0,
      resolutionFailures: config.stalledResolutionFailures,
    });
  });

  it("stops resolving for the run on a terminal rate limit", async () => {
    const requested: string[] = [];
    const job = censusJob([place(1, 500), place(2, 400), place(3, 300), ...filler()], {
      roblox: {
        ...roblox,
        resolveUniverseId: async (placeId) => {
          requested.push(placeId);
          if (placeId === "2") throw new HttpError(429, "Too Many Requests", universesUrl);
          return String(Number(placeId) + 1_000);
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(requested).toEqual(["1", "2"]);
    expect(await lastRunStats()).toMatchObject({ resolved: 1, resolutionFailures: 1, deferred: 1 });
  });

  it("keeps the census and reports the error when promotion fails", async () => {
    const job = censusJob([place(1, 500), ...filler()], {
      roblox: {
        ...roblox,
        getGameDetails: async () => {
          throw new HttpError(503, "Service Unavailable", "https://games.roblox.com/v1/games");
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await database.db.select().from(censusObservations)).toHaveLength(config.minimumListed + 1);
    expect((await placeRow(1)).universeId).toBe(1_001);
    expect(await database.db.select().from(games)).toEqual([]);
    expect(await lastRunStats()).toMatchObject({
      listQuality: "success",
      promotionRequested: 1,
      promoted: 0,
      promotionError: expect.stringContaining("503"),
    });
  });
});
