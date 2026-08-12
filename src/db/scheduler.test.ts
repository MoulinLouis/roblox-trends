import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory: string;
let repository: typeof import("./repository");
let closeDatabase: typeof import("./index").closeDatabase;
let scheduler: typeof import("@/lib/scheduler");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "roblox-trends-scheduler-"));
  process.env.DATABASE_URL = "";
  process.env.PGLITE_DATA_DIR = join(directory, "database");
  const databaseModule = await import("./index");
  const migrationModule = await import("./migrate");
  repository = await import("./repository");
  scheduler = await import("@/lib/scheduler");
  closeDatabase = databaseModule.closeDatabase;
  await migrationModule.migrateDatabase();
}, 60_000);

afterAll(async () => {
  await closeDatabase();
  await rm(directory, { recursive: true, force: true });
}, 30_000);

describe("scheduler persistence", () => {
  it("allows only one scheduler owner until the lease expires", async () => {
    const now = new Date("2026-08-12T10:00:00Z");
    expect(await repository.acquireSchedulerLock({
      name: "test-scheduler",
      owner: "first",
      now,
      leaseUntil: new Date("2026-08-12T10:10:00Z"),
    })).toBe(true);
    expect(await repository.acquireSchedulerLock({
      name: "test-scheduler",
      owner: "second",
      now: new Date("2026-08-12T10:05:00Z"),
      leaseUntil: new Date("2026-08-12T10:15:00Z"),
    })).toBe(false);
    expect(await repository.acquireSchedulerLock({
      name: "test-scheduler",
      owner: "second",
      now: new Date("2026-08-12T10:11:00Z"),
      leaseUntil: new Date("2026-08-12T10:21:00Z"),
    })).toBe(true);
    await repository.releaseSchedulerLock("test-scheduler", "second");
  });

  it("retries failed slots but never repeats successful slots", async () => {
    const slot = new Date("2026-08-12T10:00:00Z");
    const first = await repository.acquireScheduledJob({
      id: "first-attempt",
      jobName: "collect",
      scheduledFor: slot,
      owner: "first",
      now: new Date("2026-08-12T10:01:00Z"),
      leaseUntil: new Date("2026-08-12T10:11:00Z"),
    });
    expect(first?.attempt).toBe(1);
    expect(await repository.acquireScheduledJob({
      id: "overlap",
      jobName: "collect",
      scheduledFor: slot,
      owner: "second",
      now: new Date("2026-08-12T10:02:00Z"),
      leaseUntil: new Date("2026-08-12T10:12:00Z"),
    })).toBeNull();

    await repository.finishScheduledJob({
      id: first!.id,
      owner: "first",
      status: "failed",
      now: new Date("2026-08-12T10:03:00Z"),
      error: "temporary failure",
    });
    const retry = await repository.acquireScheduledJob({
      id: "retry",
      jobName: "collect",
      scheduledFor: slot,
      owner: "second",
      now: new Date("2026-08-12T10:04:00Z"),
      leaseUntil: new Date("2026-08-12T10:14:00Z"),
    });
    expect(retry?.attempt).toBe(2);
    await repository.finishScheduledJob({
      id: retry!.id,
      owner: "second",
      status: "success",
      now: new Date("2026-08-12T10:05:00Z"),
    });
    expect(await repository.acquireScheduledJob({
      id: "after-success",
      jobName: "collect",
      scheduledFor: slot,
      owner: "third",
      now: new Date("2026-08-12T11:00:00Z"),
      leaseUntil: new Date("2026-08-12T11:10:00Z"),
    })).toBeNull();
  });

  it("reconciles every due action once across repeated ticks", async () => {
    const calls: string[] = [];
    const actions = {
      frontier: async () => { calls.push("frontier"); },
      collect: async () => { calls.push("collect"); },
      analyze: async () => { calls.push("analyze"); },
      brief: async () => { calls.push("brief"); },
      report: async () => { calls.push("report"); },
      maintenance: async () => { calls.push("maintenance"); },
    };
    const now = new Date("2026-09-01T12:10:00Z");
    const first = await scheduler.runSchedulerTick({
      owner: "tick-one",
      now,
      collectionIntervalMinutes: 60,
      actions,
      clock: () => now,
    });
    const second = await scheduler.runSchedulerTick({
      owner: "tick-two",
      now: new Date("2026-09-01T12:14:00Z"),
      collectionIntervalMinutes: 60,
      actions,
      clock: () => new Date("2026-09-01T12:14:00Z"),
    });
    expect(first.completed).toHaveLength(6);
    expect(second.completed).toHaveLength(0);
    expect(second.skipped).toHaveLength(6);
    expect(calls).toEqual(["frontier", "collect", "analyze", "brief", "report", "maintenance"]);
  });

  it("persists rising signals and emits idempotent lifecycle events", async () => {
    const detectedAt = new Date("2026-09-01T13:00:00Z");
    const settings = await repository.getSettings();
    await repository.saveCollectedGames([{
      universeId: "rising-persistence-game",
      rootPlaceId: "9001",
      name: "Persistence Test",
      description: "Test fixture",
      creatorId: "creator",
      creatorName: "Creator",
      creatorType: "User",
      createdAt: new Date("2026-08-25T00:00:00Z"),
      updatedAt: detectedAt,
      ccu: 1_500,
      visits: 50_000,
      favorites: 2_000,
      upVotes: 1_000,
      downVotes: 50,
      isSponsored: false,
      thumbnailUrl: null,
      genre: null,
      chart: "Test",
      rank: 20,
      source: "test",
    }], detectedAt, settings);
    const candidate = {
      universeId: "rising-persistence-game",
      signalType: "launch_breakout" as const,
      score: 60,
      tier: "rising" as const,
      confidence: "early" as const,
      detectedAt,
      metrics: {
        currentCcu: 1_500,
        observedHours: 6,
        ageDays: 7,
        firstSeenHoursAgo: 6,
        strongestWindow: null,
        windows: {},
        priorPeakCcu: 900,
        historicalMedianCcu: 700,
        medianMultiple: 2.1,
        peakDrawdownPercent: 0,
        crossedMilestone: 1_000,
        newHighSinceTracking: false,
        enteredDiscoveryChart: true,
        chart: "Test",
      },
      reasons: ["Crossed 1,000 concurrent players"],
      risks: [],
    };

    expect(await repository.replaceRisingGameSignals([candidate], detectedAt)).toHaveLength(1);
    expect(await repository.replaceRisingGameSignals([candidate], detectedAt)).toHaveLength(0);
    expect(await repository.getActiveRisingGameSignals()).toHaveLength(1);

    const promoted = {
      ...candidate,
      score: 88,
      tier: "explosive" as const,
      metrics: { ...candidate.metrics, currentCcu: 5_200, crossedMilestone: 5_000 },
    };
    const promotionEvents = await repository.replaceRisingGameSignals([promoted], new Date("2026-09-01T14:00:00Z"));
    expect(promotionEvents).toHaveLength(1);
    expect(promotionEvents[0]?.eventType).toBe("tier_up");

    await repository.replaceRisingGameSignals([], new Date("2026-09-01T15:00:00Z"));
    expect(await repository.getActiveRisingGameSignals()).toHaveLength(0);
  });
});
