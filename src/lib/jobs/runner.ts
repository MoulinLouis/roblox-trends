import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import { finishJobRun, startJobRun } from "@/db/job-runs";
import { errorMessage, logger } from "@/lib/logger";
import { floorToSlot } from "@/lib/time-slots";
import { jobSlug, qualitySlug, sendPing } from "./healthchecks";
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

// A degraded run still pings the heartbeat check, which means "the job ran". Only a fully successful run
// pings the quality check, so a degradation that lasts longer than that check's period raises an alert.
export async function executeJob(
  definition: JobDefinition,
  db: Database,
  now = new Date(),
): Promise<Exclude<JobStatus, "running">> {
  const runId = randomUUID();
  const slug = jobSlug(definition.name);
  const startedMs = Date.now();
  // Ping first and record inside the try: a run that cannot even be recorded must still report a failure.
  await sendPing(slug, "start", runId);
  try {
    const slot = floorToSlot(now, definition.intervalMinutes);
    await startJobRun(db, { id: runId, job: definition.name, slot, startedAt: new Date(startedMs) });
    const result = await withTimeout(definition.run({ db, now, slot, runId }), definition.timeoutMs, definition.name);
    await finishJobRun(db, runId, {
      status: result.status,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
      stats: result.stats,
    });
    await sendPing(slug, "success", runId, JSON.stringify({ ...result.stats, status: result.status }));
    if (result.status === "success") await sendPing(qualitySlug(definition.name), "success", runId);
    logger.info("Job completed", { ...result.stats, job: definition.name, status: result.status });
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
