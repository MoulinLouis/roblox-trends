import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
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

// A run degraded for one reason can still hold a measurement that passed its own check, so the stat selects the run,
// not the status. Without a value, any string value of the stat selects the run; slotBefore keeps the runs of earlier
// slots only. Running runs have no stats yet, and the stats of failed runs are not trusted.
export async function latestRunWithStat(
  db: Database,
  job: JobName,
  since: Date,
  key: string,
  { value, slotBefore }: { value?: string; slotBefore?: Date } = {},
): Promise<{ slot: Date; stats: Record<string, unknown> } | null> {
  const [run] = await db
    .select({ slot: jobRuns.slot, stats: jobRuns.stats })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, job),
        inArray(jobRuns.status, ["success", "degraded"]),
        gte(jobRuns.startedAt, since),
        value === undefined
          ? sql`jsonb_typeof(${jobRuns.stats} -> ${key}::text) = 'string'`
          : sql`${jobRuns.stats} ->> ${key}::text = ${value}::text`,
        slotBefore === undefined ? undefined : lt(jobRuns.slot, slotBefore),
      ),
    )
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return run ?? null;
}

// A run still "running" well past its timeout belongs to a process that crashed or was killed.
export async function abandonStaleRuns(db: Database, job: JobName, olderThan: Date): Promise<number> {
  const abandoned = await db
    .update(jobRuns)
    .set({ status: "failed", error: "abandoned", finishedAt: sql`now()` })
    .where(and(eq(jobRuns.job, job), eq(jobRuns.status, "running"), lt(jobRuns.startedAt, olderThan)))
    .returning({ id: jobRuns.id });
  return abandoned.length;
}
