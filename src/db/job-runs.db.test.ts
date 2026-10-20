import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import { latestSuccessfulRun } from "./job-runs";
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

  describe("latestSuccessfulRun", () => {
    const since = new Date("2026-10-20T00:00:00Z");

    it("returns the most recently started successful run", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listed: 1 } });
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T12:00:00Z", stats: { listed: 2 } });
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T11:00:00Z", stats: { listed: 3 } });
      expect(await latestSuccessfulRun(database.db, "census", since)).toEqual({
        slot: new Date("2026-10-20T12:00:00Z"),
        stats: { listed: 2 },
      });
    });

    it("ignores running, failed and degraded runs and runs of other jobs", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listed: 1 } });
      for (const status of ["running", "failed", "degraded"] as const) {
        await insertRun({ job: "census", status, startedAt: "2026-10-20T13:00:00Z", stats: { listed: 9 } });
      }
      await insertRun({ job: "poll", status: "success", startedAt: "2026-10-20T14:00:00Z", stats: { games: 9 } });
      expect(await latestSuccessfulRun(database.db, "census", since)).toEqual({
        slot: new Date("2026-10-20T10:00:00Z"),
        stats: { listed: 1 },
      });
    });

    it("only considers runs started at or after the cutoff", async () => {
      await insertRun({ job: "census", status: "success", startedAt: "2026-10-20T10:00:00Z", stats: { listed: 1 } });
      expect(await latestSuccessfulRun(database.db, "census", new Date("2026-10-20T10:00:00Z"))).not.toBeNull();
      expect(await latestSuccessfulRun(database.db, "census", new Date("2026-10-20T10:00:01Z"))).toBeNull();
    });

    it("returns null when the job has no successful run", async () => {
      await insertRun({ job: "census", status: "degraded", startedAt: "2026-10-20T10:00:00Z" });
      expect(await latestSuccessfulRun(database.db, "census", since)).toBeNull();
    });
  });
});
