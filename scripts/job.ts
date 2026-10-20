import { closeDatabase, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { healthchecksPingBase } from "@/lib/jobs/healthchecks";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import { logger } from "@/lib/logger";

// Production units set RADAR_REQUIRE_HEALTHCHECKS=1, so a missing ping URL cannot silently disable monitoring.
if (!healthchecksPingBase()) {
  if (process.env.RADAR_REQUIRE_HEALTHCHECKS === "1") {
    logger.error("HEALTHCHECKS_PING_BASE is required when RADAR_REQUIRE_HEALTHCHECKS=1");
    process.exit(1);
  }
  logger.warn("HEALTHCHECKS_PING_BASE is not set: job monitoring is disabled");
}

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
