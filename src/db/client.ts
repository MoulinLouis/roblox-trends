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
  // Sent as session settings when the connection opens, so a stuck query cannot outlive its job.
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: normalizePostgresConnectionUrl(connectionString),
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "radar",
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.lockTimeoutMs,
  });
  // Idle clients report errors (for example a server restart) on the pool; unhandled, they crash the process.
  pool.on("error", (error) => logger.warn("Idle PostgreSQL client error", { error: errorMessage(error) }));
  return { db: drizzle(pool, { schema }), pool };
}

let shared: { db: Database; pool: Pool; options: DatabaseOptions } | null = null;

// The instance is shared by the whole process, so its options are fixed by the first call. A later call that
// asks for different options throws rather than silently receiving a pool configured for another caller.
export function getDatabase(applicationName = "radar", options: Omit<DatabaseOptions, "applicationName"> = {}): Database {
  const requested: DatabaseOptions = { ...options, applicationName };
  if (shared) {
    if (!sameOptions(shared.options, requested)) {
      throw new Error(
        `The shared database was created with ${JSON.stringify(shared.options)}, not ${JSON.stringify(requested)}`,
      );
    }
    return shared.db;
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  shared = { ...createDatabase(connectionString, requested), options: requested };
  return shared.db;
}

function sameOptions(left: DatabaseOptions, right: DatabaseOptions): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof DatabaseOptions>;
  return [...keys].every((key) => left[key] === right[key]);
}

export async function closeDatabase(): Promise<void> {
  if (shared) await shared.pool.end();
  shared = null;
}
