import { sql } from "drizzle-orm";
import { JOB_NAMES, type JobName, type JobStatus } from "@/lib/jobs/types";
import type { Database } from "./client";

export interface JobSummary {
  job: JobName;
  // The most recent run, whatever its status; null when the job never ran.
  latest: { status: JobStatus; startedAt: Date } | null;
  // The most recent successful or degraded run: running runs have no stats yet and failed runs keep none.
  lastCompleted: { status: "success" | "degraded"; finishedAt: Date; stats: Record<string, unknown> } | null;
  runs24h: number;
  degraded24h: number;
  failed24h: number;
  // The most recent error of the last 24 hours, or of the latest run when the job stopped running before that.
  lastError: { startedAt: Date; message: string } | null;
}

export interface CensusCoverage {
  slot: Date | null;
  listed: number;
  tracked: number;
}

export interface DataTotals {
  games: number;
  observations24h: number;
  censusRows24h: number;
}

// Every job appears in pipeline order, also one that never ran. Each lookup walks the (job, started_at) index of one
// job, newest first, so the cost does not grow with the history kept in job_runs.
export async function jobSummaries(db: Database, now: Date): Promise<JobSummary[]> {
  const at = now.toISOString();
  const result = await db.execute<{
    job: JobName;
    latest_status: JobStatus | null;
    latest_started_at: Date | null;
    completed_status: "success" | "degraded" | null;
    completed_finished_at: Date | null;
    completed_stats: Record<string, unknown> | null;
    runs_24h: number;
    degraded_24h: number;
    failed_24h: number;
    error: string | null;
    error_started_at: Date | null;
  }>(sql`
    select j.job,
      latest.status as latest_status, latest.started_at as latest_started_at,
      completed.status as completed_status, completed.finished_at as completed_finished_at, completed.stats as completed_stats,
      recent.runs as runs_24h, recent.degraded as degraded_24h, recent.failed as failed_24h,
      failure.error, failure.started_at as error_started_at
    from unnest(${sql.param([...JOB_NAMES])}::text[]) with ordinality as j(job, position)
    left join lateral (
      select status, started_at from job_runs where job = j.job order by started_at desc limit 1
    ) latest on true
    left join lateral (
      select status, finished_at, stats from job_runs
      where job = j.job and status in ('success', 'degraded')
      order by started_at desc limit 1
    ) completed on true
    cross join lateral (
      select count(*)::int as runs,
        (count(*) filter (where status = 'degraded'))::int as degraded,
        (count(*) filter (where status = 'failed'))::int as failed
      from job_runs
      where job = j.job and started_at > ${at}::timestamptz - interval '24 hours'
    ) recent
    left join lateral (
      select error, started_at from job_runs
      where job = j.job and error is not null
        and started_at >= least(latest.started_at, ${at}::timestamptz - interval '24 hours')
      order by started_at desc limit 1
    ) failure on true
    order by j.position
  `);
  return result.rows.map((row) => ({
    job: row.job,
    latest:
      row.latest_status && row.latest_started_at
        ? { status: row.latest_status, startedAt: new Date(row.latest_started_at) }
        : null,
    lastCompleted:
      row.completed_status && row.completed_finished_at
        ? { status: row.completed_status, finishedAt: new Date(row.completed_finished_at), stats: row.completed_stats ?? {} }
        : null,
    runs24h: row.runs_24h,
    degraded24h: row.degraded_24h,
    failed24h: row.failed_24h,
    lastError:
      row.error !== null && row.error_started_at
        ? { startedAt: new Date(row.error_started_at), message: row.error }
        : null,
  }));
}

// Share of Rolimon's places above the threshold, in its latest list, whose universe was polled recently.
export async function censusCoverage(
  db: Database,
  now: Date,
  minimumCcu: number,
  trackedWithinMinutes: number,
): Promise<CensusCoverage> {
  const at = now.toISOString();
  const result = await db.execute<{ slot: Date | null; listed: number; tracked: number }>(sql`
    with latest as (select max(observed_at) as slot from census_observations),
    listed as (
      select c.place_id from census_observations c
      where c.observed_at = (select slot from latest) and c.ccu >= ${minimumCcu}::int
    )
    select (select slot from latest) as slot,
      (select count(*) from listed)::int as listed,
      (
        select count(*) from listed l
        where exists (
          select 1 from places p
          join game_observations o on o.universe_id = p.universe_id
          where p.place_id = l.place_id
            and o.observed_at > ${at}::timestamptz - make_interval(mins => ${trackedWithinMinutes}::int)
        )
      )::int as tracked
  `);
  const row = result.rows[0];
  return { slot: row?.slot ? new Date(row.slot) : null, listed: row?.listed ?? 0, tracked: row?.tracked ?? 0 };
}

export async function dataTotals(db: Database, now: Date): Promise<DataTotals> {
  const at = now.toISOString();
  const result = await db.execute<{ games: number; observations_24h: number; census_rows_24h: number }>(sql`
    select (select count(*) from games)::int as games,
      (select count(*) from game_observations where observed_at > ${at}::timestamptz - interval '24 hours')::int as observations_24h,
      (select count(*) from census_observations where observed_at > ${at}::timestamptz - interval '24 hours')::int as census_rows_24h
  `);
  const row = result.rows[0];
  return { games: row?.games ?? 0, observations24h: row?.observations_24h ?? 0, censusRows24h: row?.census_rows_24h ?? 0 };
}
