import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

export async function migrateDatabase(db: Database): Promise<void> {
  const legacy = await db.execute<{ found: string | null }>(sql`select to_regclass('public.snapshots')::text as found`);
  if (legacy.rows[0]?.found) {
    throw new Error("Refusing to migrate: this database still holds v1 radar tables");
  }
  await migrate(db, { migrationsFolder: "drizzle" });
}
