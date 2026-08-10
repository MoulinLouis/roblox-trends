import * as nextEnvNamespace from "@next/env";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
import { normalizePostgresConnectionUrl } from "./connection-url";

const environmentNamespace = nextEnvNamespace as unknown as {
  default?: typeof import("@next/env");
  loadEnvConfig: typeof import("@next/env")["loadEnvConfig"];
};
const environmentLoader = environmentNamespace.default ?? environmentNamespace;
environmentLoader.loadEnvConfig(process.cwd());

export type AppDatabase = PgliteDatabase<typeof schema>;

let database: AppDatabase | null = null;
let pgliteClient: PGlite | null = null;
let pgPool: Pool | null = null;

export function getDatabase(): AppDatabase {
  if (database) return database;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    pgPool = new Pool({ connectionString: normalizePostgresConnectionUrl(databaseUrl), max: 5 });
    database = drizzlePg(pgPool, { schema }) as unknown as AppDatabase;
  } else {
    const dataDirectory = process.env.PGLITE_DATA_DIR || ".data/roblox-trends";
    mkdirSync(dirname(resolve(/* turbopackIgnore: true */ dataDirectory)), { recursive: true });
    pgliteClient = new PGlite(dataDirectory);
    database = drizzlePglite(pgliteClient, { schema });
  }
  return database;
}

export function isRemoteDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export async function closeDatabase(): Promise<void> {
  if (pgliteClient) await pgliteClient.close();
  if (pgPool) await pgPool.end();
  database = null;
  pgliteClient = null;
  pgPool = null;
}
