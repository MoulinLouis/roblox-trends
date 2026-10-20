import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("executeJob", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("records a successful run with its slot and stats", async () => {
    const status = await executeJob(
      { name: "poll", intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "success", stats: { games: 3 } }) },
      database.db,
      new Date("2026-10-20T14:07:00Z"),
    );
    expect(status).toBe("success");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "poll"));
    expect(run.status).toBe("success");
    expect(run.slot.toISOString()).toBe("2026-10-20T14:05:00.000Z");
    expect(run.stats).toEqual({ games: 3 });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failed run with its error", async () => {
    const status = await executeJob(
      { name: "votes", intervalMinutes: 60, timeoutMs: 1_000, run: async () => { throw new Error("boom"); } },
      database.db,
    );
    expect(status).toBe("failed");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "votes"));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
  });

  it("fails a run that exceeds its timeout", async () => {
    const status = await executeJob(
      {
        name: "charts",
        intervalMinutes: 60,
        timeoutMs: 20,
        run: () => new Promise((resolve) => setTimeout(() => resolve({ status: "success", stats: {} }), 500)),
      },
      database.db,
    );
    expect(status).toBe("failed");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "charts"));
    expect(run.error).toMatch(/exceeded/);
  });
});
