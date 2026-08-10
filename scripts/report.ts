import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getSettings } from "@/db/repository";
import { logger } from "@/lib/logger";
import { sendDailyReport } from "@/lib/report";

try {
  await migrateDatabase();
  await sendDailyReport(await getSettings());
} catch (error) {
  logger.error("Report job failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
