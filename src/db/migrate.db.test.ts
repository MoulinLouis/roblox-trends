import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as {
  entries: { tag: string }[];
};

// Every deployment runs `npm run db:migrate`, so a database that is already up to date must come out unchanged.
describe.skipIf(!hasTestDatabase)("migration runs", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function appliedMigrations() {
    const result = await database.db.execute<{ id: number; hash: string; created_at: string }>(
      sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`,
    );
    return result.rows;
  }

  // The columns of every table and view, and the TimescaleDB policies: a migration applied twice would add jobs.
  async function schemaObjects() {
    const columns = await database.db.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' order by table_name, column_name
    `);
    const jobs = await database.db.execute<{ proc_name: string; hypertable_name: string | null }>(sql`
      select proc_name, hypertable_name from timescaledb_information.jobs
      where job_id >= 1000 order by proc_name, hypertable_name
    `);
    return { columns: columns.rows, jobs: jobs.rows };
  }

  it("applies every migration once and changes nothing when run again", async () => {
    await migrateDatabase(database.db);
    const applied = await appliedMigrations();
    expect(applied).toHaveLength(journal.entries.length);
    const schema = await schemaObjects();

    await expect(migrateDatabase(database.db)).resolves.toBeUndefined();

    expect(await appliedMigrations()).toEqual(applied);
    expect(await schemaObjects()).toEqual(schema);
  });
});
