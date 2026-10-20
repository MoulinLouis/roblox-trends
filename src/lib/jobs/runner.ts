import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import { finishJobRun, startJobRun } from "@/db/job-runs";
import { errorMessage, logger } from "@/lib/logger";
import { floorToSlot } from "@/lib/time-slots";
import { sendPing } from "./healthchecks";
import type { JobName, JobStatus } from "./types";

export interface JobContext {
  db: Database;
  now: Date;
  slot: Date;
  runId: string;
}

export interface JobResult {
  status: "success" | "degraded";
  stats: Record<string, unknown>;
}

export interface JobDefinition {
  name: JobName;
  intervalMinutes: number;
  timeoutMs: number;
  run(context: JobContext): Promise<JobResult>;
}

// A degraded run still sends a success ping: the heartbeat means "the job ran";
// data quality is tracked in job_runs and excluded from analysis there.
export async function executeJob(
  definition: JobDefinition,
  db: Database,
  now = new Date(),
): Promise<Exclude<JobStatus, "running">> {
  const runId = randomUUID();
  const slug = `radar-${definition.name}`;
  const slot = floorToSlot(now, definition.intervalMinutes);
  const startedMs = Date.now();
  await startJobRun(db, { id: runId, job: definition.name, slot, startedAt: new Date(startedMs) });
  await sendPing(slug, "start", runId);
  try {
    const result = await withTimeout(definition.run({ db, now, slot, runId }), definition.timeoutMs, definition.name);
    await finishJobRun(db, runId, {
      status: result.status,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
      stats: result.stats,
    });
    await sendPing(slug, "success", runId, JSON.stringify({ status: result.status, ...result.stats }));
    logger.info("Job completed", { job: definition.name, status: result.status, ...result.stats });
    return result.status;
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Job failed", { job: definition.name, error: message });
    try {
      await finishJobRun(db, runId, {
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - startedMs,
        stats: {},
        error: message,
      });
    } catch (recordError) {
      logger.error("Could not record job failure", { job: definition.name, error: errorMessage(recordError) });
    }
    await sendPing(slug, "fail", runId, message);
    return "failed";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
