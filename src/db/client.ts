import * as nextEnvNamespace from "@next/env";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { normalizePostgresConnectionUrl } from "./connection-url";
import * as schema from "./schema";

const environmentNamespace = nextEnvNamespace as unknown as {
  default?: typeof import("@next/env");
  loadEnvConfig: typeof import("@next/env")["loadEnvConfig"];
};
(environmentNamespace.default ?? environmentNamespace).loadEnvConfig(process.cwd());

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(connectionString: string, maxConnections = 5): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: normalizePostgresConnectionUrl(connectionString), max: maxConnections });
  return { db: drizzle(pool, { schema }), pool };
}

let shared: { db: Database; pool: Pool } | null = null;

export function getDatabase(): Database {
  if (shared) return shared.db;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  shared = createDatabase(connectionString);
  return shared.db;
}

export async function closeDatabase(): Promise<void> {
  if (shared) await shared.pool.end();
  shared = null;
}
