import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import { abandonStaleRuns, latestRunWithStat } from "./job-runs";
import { jobRuns } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("job runs", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(jobRuns);
  });

  async function insertRun(run: { job: JobName; status: JobStatus; startedAt: string; stats?: Record<string, unknown> }) {
    const id = randomUUID();
    const startedAt = new Date(run.startedAt);
    await database.db.insert(jobRuns).values({ id, job: run.job, status: run.status, slot: startedAt, startedAt, stats: run.stats ?? {} });
    return id;
  }

  describe("latestRunWithStat", () => {
    const since = new Date("2026-10-20T00:00:00Z");

    it("returns the most recently started successful or degraded run whose stat matches", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listQuality: "success", listed: 1 } });
      await insertRun({ job: "census", status: "degraded", startedAt: "2026-10-20T11:00:00Z", stats: { listQuality: "success", listed: 2 } });
      expect(await latestRunWithStat(database.db, "census", since, "listQuality", { value: "success" })).toEqual({
        slot: new Date("2026-10-20T11:00:00Z"),
        stats: { listQuality: "success", listed: 2 },
      });
    });

    it("ignores other values, a missing stat, running and failed runs and runs of other jobs", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listQuality: "success", listed: 1 } });
      await insertRun({ job: "census", status: "degraded", startedAt: "2026-10-20T13:00:00Z", stats: { listQuality: "degraded", listed: 9 } });
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T13:00:00Z", stats: { listed: 9 } });
      for (const status of ["running", "failed"] as const) {
        await insertRun({ job: "census", status, startedAt: "2026-10-20T13:00:00Z", stats: { listQuality: "success", listed: 9 } });
      }
      await insertRun({ job: "poll", status: "success", startedAt: "2026-10-20T14:00:00Z", stats: { listQuality: "success" } });
      expect(await latestRunWithStat(database.db, "census", since, "listQuality", { value: "success" })).toEqual({
        slot: new Date("2026-10-20T10:00:00Z"),
        stats: { listQuality: "success", listed: 1 },
      });
    });

    it("only considers runs started at or after the cutoff", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listQuality: "success" } });
      expect(await latestRunWithStat(database.db, "census", new Date("2026-10-20T10:00:00Z"), "listQuality", { value: "success" })).not.toBeNull();
      expect(await latestRunWithStat(database.db, "census", new Date("2026-10-20T10:00:01Z"), "listQuality", { value: "success" })).toBeNull();
    });

    it("only considers runs of slots before the bound", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listQuality: "success", listed: 1 } });
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:10:00Z", stats: { listQuality: "success", listed: 2 } });
      const slotBefore = new Date("2026-10-20T10:10:00Z");
      expect(await latestRunWithStat(database.db, "census", since, "listQuality", { value: "success", slotBefore })).toEqual({
        slot: new Date("2026-10-20T10:00:00Z"),
        stats: { listQuality: "success", listed: 1 },
      });
    });
  });

  describe("abandonStaleRuns", () => {
    it("fails only the running rows of the job that started before the cutoff", async () => {
      const stale = await insertRun({ job: "poll", status: "running", startedAt: "2026-10-20T10:00:00Z" });
      const recent = await insertRun({ job: "poll", status: "running", startedAt: "2026-10-20T12:30:00Z" });
      const finished = await insertRun({ job: "poll", status: "success", startedAt: "2026-10-20T09:00:00Z" });
      const otherJob = await insertRun({ job: "votes", status: "running", startedAt: "2026-10-20T10:00:00Z" });

      expect(await abandonStaleRuns(database.db, "poll", new Date("2026-10-20T12:00:00Z"))).toBe(1);

      const runs = new Map((await database.db.select().from(jobRuns)).map((run) => [run.id, run]));
      expect(runs.get(stale)).toMatchObject({ status: "failed", error: "abandoned" });
      expect(runs.get(stale)?.finishedAt).toBeInstanceOf(Date);
      expect(runs.get(recent)).toMatchObject({ status: "running", error: null, finishedAt: null });
      expect(runs.get(finished)).toMatchObject({ status: "success", error: null, finishedAt: null });
      expect(runs.get(otherJob)).toMatchObject({ status: "running", error: null, finishedAt: null });
    });
  });
});
