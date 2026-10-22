import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finishJobRun, startJobRun } from "@/db/job-runs";
import { censusObservations, discoverySources, games, jobRuns, places } from "@/db/schema";
import { censusCoverage } from "@/db/status";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { JOB_CONFIG } from "@/lib/config";
import type { JobStatus } from "@/lib/jobs/types";
import { hasStat, WATCHED_STATS } from "@/lib/status-report";
import { gameDetail } from "@/test/fixtures";
import { censusListFingerprint, createCensusJob, type CensusDependencies } from "./census";
import { executeJob } from "./runner";

const config = JOB_CONFIG.census;
const now = new Date("2026-10-20T14:13:00Z");
const hourMs = 60 * 60 * 1000;
const universesUrl = "https://apis.roblox.com/universes/v1/places";
const rolimonsUrl = "https://api.rolimons.com/games/v1/gamelist";

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

const failingRoblox: CensusDependencies["roblox"] = {
  ...roblox,
  resolveUniverseId: async () => {
    throw new Error("socket hang up");
  },
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

  function minutesLater(minutes: number): Date {
    return new Date(now.getTime() + minutes * 60_000);
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
    const stats = await lastRunStats();
    expect(stats).toEqual({
      listed: listed.length,
      rejected: 2,
      listFingerprint: censusListFingerprint(listed),
      listQuality: "success",
      eligible: 3,
      resolved: 1,
      unresolvable: 2,
      resolutionFailures: 0,
      deferred: 0,
      rateLimited: false,
      promotionRequested: 1,
      promoted: 1,
      http: { attempts: 0, retries: 0, rateLimitedResponses: 0, endpointIntervalMs: {} },
    });
    // `npm run status` prints these paths: a renamed stat must fail here rather than print a dash.
    expect(WATCHED_STATS.census?.values.filter((path) => !hasStat(stats, path))).toEqual([]);
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

  it("keeps the run successful when a single place keeps failing", async () => {
    const job = censusJob([place(1, 500), ...filler()], { roblox: failingRoblox });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await lastRunStats()).toMatchObject({ resolved: 0, resolutionFailures: 1 });
  });

  it("stops resolving and degrades the run after repeated failures with no answer", async () => {
    const requested: string[] = [];
    const failing = Array.from({ length: config.stalledResolutionFailures + 2 }, (_, index) => place(index + 1, 500 - index));
    const job = censusJob([...failing, ...filler()], {
      roblox: {
        ...roblox,
        resolveUniverseId: async (placeId) => {
          requested.push(placeId);
          throw new Error("socket hang up");
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(requested).toHaveLength(config.stalledResolutionFailures);
    expect(await lastRunStats()).toMatchObject({
      listQuality: "success",
      resolved: 0,
      resolutionFailures: config.stalledResolutionFailures,
      deferred: 2,
    });
  });

  it("keeps resolving after an answer even when the next places fail", async () => {
    const candidates = Array.from({ length: config.stalledResolutionFailures + 2 }, (_, index) => place(index + 1, 500 - index));
    const job = censusJob([...candidates, ...filler()], {
      roblox: {
        ...roblox,
        resolveUniverseId: async (placeId) => {
          if (placeId !== "1") throw new Error("socket hang up");
          return "1001";
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await lastRunStats()).toMatchObject({ resolved: 1, resolutionFailures: candidates.length - 1, deferred: 0 });
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
    expect(await lastRunStats()).toMatchObject({ resolved: 1, resolutionFailures: 1, deferred: 1, rateLimited: true });
  });

  it("degrades the run when a rate limit stops resolution before any answer", async () => {
    const job = censusJob([place(1, 500), place(2, 400), place(3, 300), ...filler()], {
      roblox: {
        ...roblox,
        resolveUniverseId: async () => {
          throw new HttpError(429, "Too Many Requests", universesUrl);
        },
      },
    });

    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ resolved: 0, resolutionFailures: 1, deferred: 2, rateLimited: true });
  });

  it("degrades the run when the budget runs out before any answer", async () => {
    let elapsedMs = 0;
    const job = censusJob([place(1, 500), place(2, 400), place(3, 300), ...filler()], {
      roblox: failingRoblox,
      clock: () => (elapsedMs += (config.resolutionBudgetMs * 2) / 3),
    });

    expect(await executeJob(job, database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ resolved: 0, resolutionFailures: 1, deferred: 2, rateLimited: false });
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
    const stats = await lastRunStats();
    expect(stats).toMatchObject({
      listQuality: "success",
      promotionRequested: 1,
      promoted: 0,
      promotionError: expect.stringMatching(/^Game details request failed: 503/),
    });
    expect(WATCHED_STATS.census?.messages).toContain("promotionError");
  });

  it("degrades the run on a Rolimon's outage and keeps the last good list as the reference", async () => {
    const goodListAt = hoursAgo(1);
    await recordRun("success", { listed: config.minimumListed * 2, listQuality: "success" }, goodListAt);
    const outage = censusJob([], {
      fetchGames: async () => {
        throw new HttpError(503, "Service Unavailable", rolimonsUrl);
      },
    });

    expect(await executeJob(outage, database.db, now)).toBe("degraded");
    expect(await database.db.select().from(censusObservations)).toEqual([]);
    const stats = await lastRunStats();
    expect(stats).toEqual({
      listed: null,
      rejected: null,
      listFingerprint: null,
      listQuality: "failed",
      eligible: 0,
      resolved: 0,
      unresolvable: 0,
      resolutionFailures: 0,
      deferred: 0,
      rateLimited: false,
      promotionRequested: 0,
      promoted: 0,
      http: { attempts: 0, retries: 0, rateLimitedResponses: 0, endpointIntervalMs: {} },
      listError: "503 Service Unavailable for api.rolimons.com",
    });
    expect(WATCHED_STATS.census?.values.filter((path) => !hasStat(stats, path))).toEqual([]);
    expect(WATCHED_STATS.census?.messages).toContain("listError");
    // Status coverage and the next run's size check still use the good list, not the run that has none.
    const coverage = await censusCoverage(database.db, new Date(), { minimumCcu: 100, withinMinutes: 15, listWithinHours: 24 });
    expect(coverage.slot).toEqual(goodListAt);
    expect(await executeJob(censusJob(filler()), database.db, now)).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listed: config.minimumListed, listQuality: "degraded" });
  });

  it("does not store a list identical to the previous run's and degrades the run", async () => {
    const listed = [place(1, 500), ...filler()];
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    // A frozen list stays repeated run after run.
    for (const minutes of [10, 20]) {
      expect(await executeJob(censusJob(listed), database.db, minutesLater(minutes))).toBe("degraded");
      expect(await lastRunStats()).toMatchObject({ listQuality: "repeated", listed: listed.length });
    }
    // Only the first slot holds rows: the repeated list is not a new sample, and coverage keeps measuring that slot.
    const rows = await database.db.select({ observedAt: censusObservations.observedAt }).from(censusObservations);
    expect(rows).toHaveLength(listed.length);
    expect(new Set(rows.map((row) => row.observedAt.toISOString()))).toEqual(new Set(["2026-10-20T14:10:00.000Z"]));
    const coverage = await censusCoverage(database.db, new Date(), { minimumCcu: 100, withinMinutes: 15, listWithinHours: 24 });
    expect(coverage.slot).toEqual(new Date("2026-10-20T14:10:00.000Z"));
    // A list that changed is stored again.
    expect(await executeJob(censusJob([place(1, 501), ...filler()]), database.db, minutesLater(30))).toBe("success");
    const changedAt = new Date("2026-10-20T14:40:00.000Z");
    const changed = await database.db.select().from(censusObservations).where(eq(censusObservations.observedAt, changedAt));
    expect(changed).toHaveLength(listed.length);
  });

  it("compares a rerun with the earlier slots, not with the run of its own slot", async () => {
    const listed = [place(1, 500), ...filler()];
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    // A manual rerun in the same slot reads the same list: it rewrites the slot's rows with the same CCU.
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    expect(await database.db.select().from(censusObservations)).toHaveLength(listed.length);
    // A rerun of a slot whose list was repeated is repeated too, and still stores nothing.
    expect(await executeJob(censusJob(listed), database.db, minutesLater(10))).toBe("degraded");
    expect(await executeJob(censusJob(listed), database.db, minutesLater(10))).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "repeated" });
    expect(await database.db.select().from(censusObservations)).toHaveLength(listed.length);
  });

  it("compares with the latest list read, across a failed request", async () => {
    const listed = [place(1, 500), ...filler()];
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    const outage = censusJob([], {
      fetchGames: async () => {
        throw new HttpError(503, "Service Unavailable", rolimonsUrl);
      },
    });
    expect(await executeJob(outage, database.db, minutesLater(10))).toBe("degraded");
    expect(await executeJob(censusJob(listed), database.db, minutesLater(20))).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "repeated" });
  });

  it("fails the run when the database fails during promotion", async () => {
    // Recording the discovery is the last step of promotion, after the Games API answered.
    await database.db.execute(sql`alter table discovery_sources rename to discovery_sources_hidden`);
    try {
      expect(await executeJob(censusJob([place(1, 500), ...filler()]), database.db, now)).toBe("failed");
    } finally {
      await database.db.execute(sql`alter table discovery_sources_hidden rename to discovery_sources`);
    }
    const [run] = await database.db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
    expect(run.error).toContain("discovery_sources");
  });
});
