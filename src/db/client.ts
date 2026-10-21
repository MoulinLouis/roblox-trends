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
  // Other session settings, sent the same way (as `-c name=value` startup options).
  settings?: Readonly<Record<string, string>>;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: normalizePostgresConnectionUrl(connectionString),
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "radar",
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.lockTimeoutMs,
    options: options.settings ? startupOptions(options.settings) : undefined,
  });
  // Idle clients report errors (for example a server restart) on the pool; unhandled, they crash the process.
  pool.on("error", (error) => logger.warn("Idle PostgreSQL client error", { error: errorMessage(error) }));
  return { db: drizzle(pool, { schema }), pool };
}

// Names are plain (possibly dotted) identifiers; spaces and backslashes in values are escaped as libpq expects.
function startupOptions(settings: Readonly<Record<string, string>>): string {
  return Object.entries(settings)
    .map(([name, value]) => {
      if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(name)) throw new Error(`Invalid session setting name: ${name}`);
      return `-c ${name}=${value.replace(/[\\ ]/g, "\\$&")}`;
    })
    .join(" ");
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
  return [...keys].every((key) =>
    key === "settings" ? sameSettings(left.settings, right.settings) : left[key] === right[key],
  );
}

function sameSettings(left: DatabaseOptions["settings"] = {}, right: DatabaseOptions["settings"] = {}): boolean {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].every((name) => left[name] === right[name]);
}

export async function closeDatabase(): Promise<void> {
  if (shared) await shared.pool.end();
  shared = null;
}

// For scripts that exit right after: a query left running by a timed-out job keeps its client checked out, and
// closing the pool waits for it. The timer stays referenced while closing is pending: if closing never settles and
// nothing else keeps the event loop alive, Node would otherwise exit with code 13 (unsettled top-level await) before
// the script reaches process.exit. Resolves to false when the pool was still closing after timeoutMs.
export async function closeDatabaseWithin(timeoutMs: number, details: Record<string, unknown> = {}): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    closeDatabase().then(
      () => true,
      (error: unknown) => {
        logger.warn("Could not close the database", { ...details, error: errorMessage(error) });
        return true;
      },
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) logger.warn(`Database connections did not close within ${timeoutMs / 1_000} s`, details);
  return closed;
}
