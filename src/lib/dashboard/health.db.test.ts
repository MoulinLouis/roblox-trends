import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { JOB_NAMES } from "@/lib/jobs/types";
import { readHealth } from "./health";

describe.skipIf(!hasTestDatabase)("readHealth", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("reports every job, the coverage, the totals and the system of an empty database", async () => {
    const health = await readHealth(database.db, new Date());
    expect(health.jobs.map((job) => job.job)).toEqual([...JOB_NAMES]);
    expect(health.jobs.every((job) => job.latest === null)).toBe(true);
    expect(health.coverage.slot).toBeNull();
    expect(health.totals).toEqual({ games: 0, pollObservations: 0, censusRows: 0 });
    expect(health.rateLimits).toEqual({ responses: 0, attempts: 0, runs: 0, recorded: false });
    expect(health.system.diskUsedShare).toBeGreaterThan(0);
    expect(health.system.policies).toBeGreaterThan(0);
    // Test databases pause every TimescaleDB policy, which the system check reports.
    expect(health.system.ok).toBe(false);
    expect(health.system.problems.some((problem) => problem.includes("is paused"))).toBe(true);
  });
});
