import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

// v1 and v2 both read DATABASE_URL; nothing v2 may run against the v1 production schema.
export async function assertNotLegacyDatabase(db: Database): Promise<void> {
  const legacy = await db.execute<{ found: string | null }>(sql`select to_regclass('public.snapshots')::text as found`);
  if (legacy.rows[0]?.found) {
    throw new Error("Refusing to run: this database still holds v1 radar tables");
  }
}

export async function migrateDatabase(db: Database): Promise<void> {
  await assertNotLegacyDatabase(db);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
