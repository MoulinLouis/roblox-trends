import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { orderJobs } from "@/lib/jobs/order";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import { errorMessage, logger } from "@/lib/logger";

// Runs every collector once, for local setup and manual catch-up; production runs one systemd timer per job instead.
// Census registers the places that poll and votes sample, and thumbnails run last so they also cover the games
// that charts and explore discovered in this pass.
const ORDER: readonly JobName[] = ["census", "poll", "votes", "charts", "explore", "thumbnails"];

let exitCode = 1;
try {
  const definitions = orderJobs(createJobs(), ORDER);
  // One pool serves every job in this process, so its statement timeout is the longest job timeout; the lock
  // timeout matches the job script.
  const statementTimeoutMs = Math.max(...definitions.map((definition) => definition.timeoutMs));
  const database = getDatabase("radar-collect", { statementTimeoutMs, lockTimeoutMs: 30_000 });
  await assertNotLegacyDatabase(database);
  await assertSupportedPostgres(database);
  // executeJob records and reports its own failures, so one failed collector does not stop the others.
  const outcomes: Partial<Record<JobName, Exclude<JobStatus, "running">>> = {};
  for (const definition of definitions) outcomes[definition.name] = await executeJob(definition, database);
  logger.info("Collection pass completed", outcomes);
  exitCode = Object.values(outcomes).includes("failed") ? 1 : 0;
} catch (error) {
  logger.error("Collection pass failed", { error: errorMessage(error) });
}

await closeDatabaseWithin(5_000, { command: "collect" });
process.exit(exitCode);
