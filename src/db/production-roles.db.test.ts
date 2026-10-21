import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";
import { hasTestDatabase, runAdminQuery, withDatabaseName } from "./test-database";

const roles = readFileSync(new URL("../../ops/postgresql/roles.sql", import.meta.url), "utf8");
const grants = readFileSync(new URL("../../ops/postgresql/database.sql", import.meta.url), "utf8");
// Production authenticates both roles by peer on the local socket; the CI server only accepts passwords over TCP.
const password = "radar-production-roles-test";

function asRole(database: string, role: string): string {
  const url = new URL(withDatabaseName(process.env.TEST_DATABASE_URL ?? "", database));
  url.username = role;
  url.password = password;
  return url.toString();
}

// The production order: roles, an empty database owned by radar with the extension and grants, then the migrations
// run by the non-superuser owner.
describe.skipIf(!hasTestDatabase)("production roles", () => {
  const name = `radar_roles_${randomUUID().replaceAll("-", "")}`;
  let owner: { db: Database; pool: Pool };
  let analysis: { db: Database; pool: Pool };

  beforeAll(async () => {
    await runAdminQuery(roles);
    await runAdminQuery(`ALTER ROLE radar PASSWORD '${password}'; ALTER ROLE radar_analysis PASSWORD '${password}'`);
    await runAdminQuery(`CREATE DATABASE "${name}" OWNER radar TEMPLATE template0`);
    await runAdminQuery(grants, name);
    owner = createDatabase(asRole(name, "radar"), { maxConnections: 1, applicationName: "radar-test" });
    await migrateDatabase(owner.db);
    analysis = createDatabase(asRole(name, "radar_analysis"), { maxConnections: 1, applicationName: "radar-test" });
  });

  afterAll(async () => {
    await owner?.pool.end();
    await analysis?.pool.end();
    await runAdminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  it("migrates as the non-superuser owner", async () => {
    const result = await owner.db.execute<{ owner: string }>(
      sql`select tableowner as owner from pg_tables where schemaname = 'public' and tablename = 'game_observations'`,
    );
    expect(result.rows).toEqual([{ owner: "radar" }]);
  });

  it("lets the analysis role read tables, views and continuous aggregates created by the migrations", async () => {
    for (const relation of ["games", "game_observations", "job_runs", "game_hourly", "game_daily", "census_hourly", "game_daily_all"]) {
      const result = await analysis.db.execute<{ rows: number }>(sql.raw(`select count(*)::int as rows from ${relation}`));
      expect(result.rows[0]?.rows, relation).toBe(0);
    }
  });

  it("keeps the analysis role read-only", async () => {
    const setting = await analysis.db.execute<{ value: string }>(sql`select current_setting('default_transaction_read_only') as value`);
    expect(setting.rows[0]?.value).toBe("on");
    // Drizzle wraps the driver error in a "Failed query" error: the server's message is on its cause.
    await expect(
      analysis.db.execute(sql`insert into job_runs (id, job, slot, status, started_at) values (gen_random_uuid(), 'poll', now(), 'running', now())`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/read-only transaction/) } });
  });
});
