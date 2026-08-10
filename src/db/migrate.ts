import { getDatabase, isRemoteDatabase } from "./index";

export async function migrateDatabase(): Promise<void> {
  const database = getDatabase();
  if (isRemoteDatabase()) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(database as never, { migrationsFolder: "drizzle" });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(database, { migrationsFolder: "drizzle" });
  }
}
