import * as nextEnvNamespace from "@next/env";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { errorMessage, logger } from "@/lib/logger";
import { normalizePostgresConnectionUrl } from "./connection-url";
import * as schema from "./schema";

const environmentNamespace = nextEnvNamespace as unknown as {
  default?: typeof import("@next/env");
  loadEnvConfig: typeof import("@next/env")["loadEnvConfig"];
};
(environmentNamespace.default ?? environmentNamespace).loadEnvConfig(process.cwd());

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  maxConnections?: number;
  // Shown in pg_stat_activity, to tell the dashboard, each job and analysis sessions apart.
  applicationName?: string;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: normalizePostgresConnectionUrl(connectionString),
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "radar",
  });
  // Idle clients report errors (for example a server restart) on the pool; unhandled, they crash the process.
  pool.on("error", (error) => logger.warn("Idle PostgreSQL client error", { error: errorMessage(error) }));
  return { db: drizzle(pool, { schema }), pool };
}

let shared: { db: Database; pool: Pool } | null = null;

export function getDatabase(applicationName = "radar"): Database {
  if (shared) return shared.db;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  shared = createDatabase(connectionString, { applicationName });
  return shared.db;
}

export async function closeDatabase(): Promise<void> {
  if (shared) await shared.pool.end();
  shared = null;
}
