import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { readArchiver, readTimescaleJobs } from "@/db/system-health";
import { DATABASE_SESSION_CONFIG, HEALTHCHECKS_CONFIG } from "@/lib/config";
import { healthchecksPingBase, sendPing } from "@/lib/jobs/healthchecks";
import { errorMessage, logger } from "@/lib/logger";
import { diskUsedShare, evaluateSystemHealth } from "@/lib/ops/system-check";

// Run every 15 minutes by radar-system-check.timer: disk usage, WAL archiving and the TimescaleDB policies, reported to
// the radar-system check. Not being able to read them is reported as a failure too.
// radar-system-check.service sets RADAR_REQUIRE_HEALTHCHECKS=1, so a missing ping URL cannot silently disable the check.
if (!healthchecksPingBase()) {
  if (process.env.RADAR_REQUIRE_HEALTHCHECKS === "1") {
    logger.error("HEALTHCHECKS_PING_BASE is required when RADAR_REQUIRE_HEALTHCHECKS=1");
    process.exit(1);
  }
  logger.warn("HEALTHCHECKS_PING_BASE is not set: system check monitoring is disabled");
}

const slug = HEALTHCHECKS_CONFIG.operations.system.slug;
const runId = randomUUID();
let exitCode = 1;
try {
  // Read-only and short, like `status`.
  const database = getDatabase("radar-system-check", {
    statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs,
    lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs,
  });
  await assertNotLegacyDatabase(database);
  const [jobs, archiver, disk] = await Promise.all([readTimescaleJobs(database), readArchiver(database), statfs("/")]);
  const result = evaluateSystemHealth({ now: new Date(), diskUsedShare: diskUsedShare(disk), archiver, jobs });
  await sendPing(slug, result.ok ? "success" : "fail", runId, result.summary);
  if (result.ok) logger.info("System check passed", { summary: result.summary });
  else logger.error("System check failed", { problems: result.problems });
  exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = errorMessage(error);
  logger.error("System check could not run", { error: message });
  await sendPing(slug, "fail", runId, message);
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "system-check" });
process.exit(exitCode);
