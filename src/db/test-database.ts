import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";

const adminUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";

// A missing variable in CI must fail loudly instead of silently skipping every database suite.
if (process.env.CI && !adminUrl) {
  throw new Error("TEST_DATABASE_URL must be set in CI");
}

// Database suites run only against a disposable PostgreSQL + TimescaleDB server.
export const hasTestDatabase = adminUrl.length > 0;

export interface TestDatabase {
  db: Database;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `radar_test_${randomUUID().replaceAll("-", "")}`;
  // template0 has no TimescaleDB, so the migration's CREATE EXTENSION path is exercised as in production.
  await runAdminQuery(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const url = withDatabaseName(adminUrl, name);
  const { db, pool } = createDatabase(url, { maxConnections: 3, applicationName: "radar-test" });
  const drop = async () => {
    try {
      await pool.end();
    } finally {
      await runAdminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  };
  try {
    if (options.migrate !== false) {
      await migrateDatabase(db);
      await pauseBackgroundJobs(db);
    }
  } catch (error) {
    await drop();
    throw error;
  }
  return { db, url, drop };
}

// Policies would otherwise materialize, compress or drop fixture rows while tests run.
// Tests that need materialized aggregates call refresh_continuous_aggregate explicitly.
async function pauseBackgroundJobs(db: Database): Promise<void> {
  await db.execute(sql`select alter_job(job_id, scheduled => false) from timescaledb_information.jobs where job_id >= 1000`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.execute<{ running: number }>(
      sql`select count(*)::int as running from timescaledb_information.job_stats where job_id >= 1000 and job_status = 'Running'`,
    );
    if (!result.rows[0]?.running) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TimescaleDB background jobs did not stop");
}

async function runAdminQuery(statement: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
