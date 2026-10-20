import { closeDatabase, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import { logger } from "@/lib/logger";

const name = process.argv[2];
const jobs = createJobs();
const definition = jobs.find((job) => job.name === name);
if (!definition) {
  logger.error("Unknown job", { name, available: jobs.map((job) => job.name) });
  process.exit(2);
}

const database = getDatabase(`radar-${definition.name}`);
await assertNotLegacyDatabase(database);
const status = await executeJob(definition, database);
await closeDatabase();
process.exit(status === "failed" ? 1 : 0);
