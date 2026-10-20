import { randomUUID } from "node:crypto";
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
  await runAdminQuery(`CREATE DATABASE "${name}"`);
  const url = withDatabaseName(adminUrl, name);
  const { db, pool } = createDatabase(url, { maxConnections: 3, applicationName: "radar-test" });
  if (options.migrate !== false) await migrateDatabase(db);
  return {
    db,
    url,
    async drop() {
      await pool.end();
      await runAdminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
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
