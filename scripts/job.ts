import { randomUUID } from "node:crypto";
import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { healthchecksPingBase, jobSlug, sendPing } from "@/lib/jobs/healthchecks";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import { errorMessage, logger } from "@/lib/logger";

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

const slug = jobSlug(definition.name);
let exitCode = 1;
try {
  // Each statement is bounded by statement_timeout (server side it can outlive this process until PostgreSQL
  // notices the client is gone), and a blocked lock fails fast instead of stalling the run.
  const database = getDatabase(slug, { statementTimeoutMs: definition.timeoutMs, lockTimeoutMs: 30_000 });
  await assertNotLegacyDatabase(database);
  await assertSupportedPostgres(database);
  exitCode = (await executeJob(definition, database)) === "failed" ? 1 : 0;
} catch (error) {
  const message = errorMessage(error);
  logger.error("Job could not start", { job: definition.name, error: message });
  // No run was recorded, so the failure ping carries a run id of its own.
  await sendPing(slug, "fail", randomUUID(), message);
}

await closeDatabaseWithin(5_000, { job: definition.name });
process.exit(exitCode);
