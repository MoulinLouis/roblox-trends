import { sql } from "drizzle-orm";
import type { Database } from "./client";

// v1 and v2 both read DATABASE_URL; nothing v2 may run against the v1 production schema.
export async function assertNotLegacyDatabase(db: Database): Promise<void> {
  const legacy = await db.execute<{ found: string | null }>(sql`select to_regclass('public.snapshots')::text as found`);
  if (legacy.rows[0]?.found) {
    throw new Error("Refusing to run: this database still holds v1 radar tables");
  }
}
