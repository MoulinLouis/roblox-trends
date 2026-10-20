import { and, desc, eq, inArray } from "drizzle-orm";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import type { Database } from "./client";
import { jobRuns } from "./schema";

export async function startJobRun(
  db: Database,
  run: { id: string; job: JobName; slot: Date; startedAt: Date },
): Promise<void> {
  await db.insert(jobRuns).values({ ...run, status: "running", stats: {} });
}

export async function finishJobRun(
  db: Database,
  id: string,
  outcome: {
    status: Exclude<JobStatus, "running">;
    finishedAt: Date;
    durationMs: number;
    stats: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      status: outcome.status,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
      stats: outcome.stats,
      error: outcome.error ?? null,
    })
    .where(eq(jobRuns.id, id));
}

export async function latestCompletedRun(
  db: Database,
  job: JobName,
): Promise<{ slot: Date; stats: Record<string, unknown> } | null> {
  const [run] = await db
    .select({ slot: jobRuns.slot, stats: jobRuns.stats })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), inArray(jobRuns.status, ["success", "degraded"])))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return run ?? null;
}
