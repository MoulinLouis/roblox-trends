import { sql } from "drizzle-orm";
import { JOB_NAMES, type JobName, type JobStatus } from "@/lib/jobs/types";
import type { Database } from "./client";
import { latestRunWithStat } from "./job-runs";

const hourMs = 60 * 60 * 1000;

// An expression rather than a subquery, so TimescaleDB can exclude older chunks when the query starts.
function windowStart(now: Date, windowHours: number) {
  return sql`${now.toISOString()}::timestamptz - make_interval(hours => ${windowHours}::int)`;
}

export interface JobSummary {
  job: JobName;
  // The most recent run, whatever its status; null when the job never ran.
  latest: { status: JobStatus; startedAt: Date } | null;
  // The most recent successful or degraded run: running runs have no stats yet and failed runs keep none.
  lastCompleted: { status: "success" | "degraded"; finishedAt: Date; stats: Record<string, unknown> } | null;
  // The runs started within the window.
  recent: {
    runs: number;
    degraded: number;
    failed: number;
    // Null when no run of the window reports `rateLimited` or `http`: the job does not record it.
    rateLimitedRuns: number | null;
    http: { rateLimitedResponses: number; attempts: number } | null;
  };
  // The most recent error of the window, or of the latest run when the job stopped running before the window.
  lastError: { startedAt: Date; message: string } | null;
}

export interface CensusCoverage {
  // The slot of the latest census list that passed its quality check; null when none did within the lookup window.
  slot: Date | null;
  listed: number;
  tracked: number;
  minimumCcu: number;
  withinMinutes: number;
}

export interface DataTotals {
  games: number;
  pollObservations: number;
  censusRows: number;
}

// Every job appears in pipeline order, also one that never ran. Each lookup walks the (job, started_at) index of one
// job, newest first: the latest run is one entry; the window counts and the last error stay within the window (plus
// the latest run); the last completed run walks back past the failed and running runs in a row before it.
export async function jobSummaries(db: Database, now: Date, windowHours: number): Promise<JobSummary[]> {
  const start = windowStart(now, windowHours);
  const result = await db.execute<{
    job: JobName;
    latest_status: JobStatus | null;
    latest_started_at: Date | null;
    completed_status: "success" | "degraded" | null;
    completed_finished_at: Date | null;
    completed_stats: Record<string, unknown> | null;
    runs: number;
    degraded: number;
    failed: number;
    rate_limit_reports: number;
    rate_limited_runs: number;
    http_reports: number;
    rate_limited_responses: number;
    attempts: number;
    error: string | null;
    error_started_at: Date | null;
  }>(sql`
    select j.job,
      latest.status as latest_status, latest.started_at as latest_started_at,
      completed.status as completed_status, completed.finished_at as completed_finished_at, completed.stats as completed_stats,
      recent.*,
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
    -- Failed runs store no stats, so the requests and 429s of a run that failed (for example one that timed out
    -- during a backoff) are missing: the HTTP figures are a lower bound. A stat of the wrong type counts 0.
    cross join lateral (
      select count(*)::int as runs,
        (count(*) filter (where status = 'degraded'))::int as degraded,
        (count(*) filter (where status = 'failed'))::int as failed,
        (count(*) filter (where jsonb_typeof(stats #> '{rateLimited}') = 'boolean'))::int as rate_limit_reports,
        (count(*) filter (where stats #>> '{rateLimited}' = 'true'))::int as rate_limited_runs,
        (count(*) filter (where jsonb_typeof(stats #> '{http}') = 'object'))::int as http_reports,
        coalesce(sum(
          case when jsonb_typeof(stats #> '{http,rateLimitedResponses}') = 'number'
            then (stats #>> '{http,rateLimitedResponses}')::numeric end
        ), 0)::int as rate_limited_responses,
        coalesce(sum(
          case when jsonb_typeof(stats #> '{http,attempts}') = 'number' then (stats #>> '{http,attempts}')::numeric end
        ), 0)::int as attempts
      from job_runs
      where job = j.job and started_at > ${start}
    ) recent
    left join lateral (
      select error, started_at from job_runs
      where job = j.job and error is not null and (started_at > ${start} or started_at = latest.started_at)
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
    recent: {
      runs: row.runs,
      degraded: row.degraded,
      failed: row.failed,
      rateLimitedRuns: row.rate_limit_reports > 0 ? row.rate_limited_runs : null,
      http: row.http_reports > 0 ? { rateLimitedResponses: row.rate_limited_responses, attempts: row.attempts } : null,
    },
    lastError:
      row.error !== null && row.error_started_at
        ? { startedAt: new Date(row.error_started_at), message: row.error }
        : null,
  }));
}

// Share of the places in Rolimon's latest complete list, at or above the threshold, whose universe was polled
// recently. A truncated list would inflate the share, so the list is the latest one that passed the census quality
// check; census writes it at the slot of its run, which job_runs records.
export async function censusCoverage(
  db: Database,
  now: Date,
  criteria: { minimumCcu: number; withinMinutes: number; listWithinHours: number },
): Promise<CensusCoverage> {
  const { minimumCcu, withinMinutes } = criteria;
  // job_runs.started_at holds wall-clock time, like `now` here.
  const since = new Date(now.getTime() - criteria.listWithinHours * hourMs);
  const list = await latestRunWithStat(db, "census", since, "listQuality", "success");
  if (!list) return { slot: null, listed: 0, tracked: 0, minimumCcu, withinMinutes };
  const at = now.toISOString();
  const result = await db.execute<{ listed: number; tracked: number }>(sql`
    with listed as (
      select place_id from census_observations
      where observed_at = ${list.slot.toISOString()}::timestamptz and ccu >= ${minimumCcu}::int
    )
    select (select count(*) from listed)::int as listed,
      (
        select count(*) from listed l
        where exists (
          select 1 from places p
          join game_observations o on o.universe_id = p.universe_id
          where p.place_id = l.place_id
            and o.source = 'poll'
            and o.observed_at > ${at}::timestamptz - make_interval(mins => ${withinMinutes}::int)
        )
      )::int as tracked
  `);
  const row = result.rows[0];
  return { slot: list.slot, listed: row?.listed ?? 0, tracked: row?.tracked ?? 0, minimumCcu, withinMinutes };
}

// Imported v1 history is not collection, so only polled observations count.
export async function dataTotals(db: Database, now: Date, windowHours: number): Promise<DataTotals> {
  const start = windowStart(now, windowHours);
  const result = await db.execute<{ games: number; poll_observations: number; census_rows: number }>(sql`
    select (select count(*) from games)::int as games,
      (select count(*) from game_observations where observed_at > ${start} and source = 'poll')::int as poll_observations,
      (select count(*) from census_observations where observed_at > ${start})::int as census_rows
  `);
  const row = result.rows[0];
  return { games: row?.games ?? 0, pollObservations: row?.poll_observations ?? 0, censusRows: row?.census_rows ?? 0 };
}
