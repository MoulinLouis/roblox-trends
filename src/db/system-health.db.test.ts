import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArchiver, readTimescaleJobs } from "./system-health";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("system health queries", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  // The policies of a continuous aggregate (its refresh and the compression of its materialized hypertable) are named
  // after the aggregate: timescaledb_information.jobs reports COALESCE(user_view_name, table_name).
  it("lists every policy the migrations add, under the name of its table or aggregate", async () => {
    const jobs = await readTimescaleJobs(database.db);
    const policies = jobs.map((job) => `${job.procName}:${job.hypertableName}`).sort();
    expect(policies).toEqual(
      [
        "policy_compression:census_hourly",
        "policy_compression:census_observations",
        "policy_compression:chart_placements",
        "policy_compression:game_hourly",
        "policy_compression:game_observations",
        "policy_compression:vote_observations",
        "policy_refresh_continuous_aggregate:census_hourly",
        "policy_refresh_continuous_aggregate:game_daily",
        "policy_refresh_continuous_aggregate:game_hourly",
        "policy_retention:census_observations",
        "policy_retention:game_observations",
      ].sort(),
    );
    // The test database pauses its jobs right after migrating.
    expect(jobs.every((job) => !job.scheduled && job.initialStart instanceof Date && job.scheduleIntervalSeconds > 0)).toBe(true);
    expect(jobs.find((job) => job.procName === "policy_refresh_continuous_aggregate" && job.hypertableName === "game_hourly"))
      .toMatchObject({ scheduleIntervalSeconds: 900 });
  });

  it("reads a policy that never ran as never succeeded, although TimescaleDB stores -infinity", async () => {
    const stored = await database.db.execute<{ last_successful_finish: string | null }>(
      sql`select last_successful_finish::text from timescaledb_information.job_stats where job_id >= 1000`,
    );
    const jobs = await readTimescaleJobs(database.db);
    expect(stored.rows.map((row) => row.last_successful_finish)).toEqual(jobs.map(() => "-infinity"));
    for (const job of jobs) {
      expect(job, `job ${job.jobId}`).toMatchObject({ lastSuccessfulFinish: null, lastRunStatus: null });
    }
  });

  it("reads the archiver, which CI runs without archiving", async () => {
    await expect(readArchiver(database.db)).resolves.toEqual({ archiveMode: "off", lastArchivedAt: null, lastFailedAt: null });
  });
});
