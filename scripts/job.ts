import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
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
  // No single statement may outlive the job, and a blocked lock fails fast instead of stalling the run.
  const database = getDatabase(slug, { statementTimeoutMs: definition.timeoutMs, lockTimeoutMs: 30_000 });
  await assertNotLegacyDatabase(database);
  exitCode = (await executeJob(definition, database)) === "failed" ? 1 : 0;
} catch (error) {
  const message = errorMessage(error);
  logger.error("Job could not start", { job: definition.name, error: message });
  // No run was recorded, so the failure ping carries a run id of its own.
  await sendPing(slug, "fail", randomUUID(), message);
}

// A query left running by a timed-out job keeps its client checked out, and closing the pool waits for it.
// The timer stays referenced: if closing never settles and nothing else keeps the event loop alive, Node
// would otherwise exit with code 13 (unsettled top-level await) before reaching process.exit below.
const closed = await Promise.race([
  closeDatabase().then(
    () => true,
    (error: unknown) => {
      logger.warn("Could not close the database", { job: definition.name, error: errorMessage(error) });
      return true;
    },
  ),
  new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
]);
if (!closed) logger.warn("Database connections did not close within 5 s", { job: definition.name });
process.exit(exitCode);
