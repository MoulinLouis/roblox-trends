import { migrateDatabase } from "@/db/migrate";

let readiness: Promise<void> | null = null;

export function ensureAppReady(): Promise<void> {
  if (!readiness) {
    readiness = (async () => {
      await migrateDatabase();
    })().catch((error) => {
      readiness = null;
      throw error;
    });
  }
  return readiness;
}
