import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";
import { assertNotLegacyDatabase } from "./legacy-guard";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function migrateDatabase(db: Database): Promise<void> {
  await assertNotLegacyDatabase(db);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
