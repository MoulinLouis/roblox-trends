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
      now: new Date("2026-09-01T12:20:00Z"),
      collectionIntervalMinutes: 60,
      actions,
      clock: () => new Date("2026-09-01T12:20:00Z"),
    });
    expect(first.completed).toHaveLength(5);
    expect(second.completed).toHaveLength(0);
    expect(second.skipped).toHaveLength(5);
    expect(calls).toEqual(["collect", "analyze", "brief", "report", "maintenance"]);
  });
});
