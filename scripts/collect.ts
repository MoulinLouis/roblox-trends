import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { DATABASE_SESSION_CONFIG } from "@/lib/config";
import { orderJobs } from "@/lib/jobs/order";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import { errorMessage, logger } from "@/lib/logger";

// Runs every collector once, for local setup and manual catch-up; production runs one systemd timer per job instead.
// Classification is left out: it is not collection and it calls a paid API with a key this script never loads
// (`npm run job classify` runs it alone).
// Census registers the places that poll and votes sample, and thumbnails run last so they also cover the games
// that charts discovered in this pass. Explore queues the games it finds: the next poll run promotes them.
const ORDER: readonly JobName[] = ["census", "poll", "votes", "charts", "explore", "thumbnails"];

// Registered jobs the pass skips on purpose; a registered job in neither list still stops the pass.
const LEFT_OUT: readonly JobName[] = ["classify"];

let exitCode = 1;
try {
  const definitions = orderJobs(createJobs(), ORDER, LEFT_OUT);
  // One pool serves every job in this process, so its statement timeout is the longest job timeout; the lock
  // timeout matches the job script.
  const statementTimeoutMs = Math.max(...definitions.map((definition) => definition.timeoutMs));
  const database = getDatabase("radar-collect", { statementTimeoutMs, lockTimeoutMs: DATABASE_SESSION_CONFIG.lockTimeoutMs });
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

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "collect" });
process.exit(exitCode);
