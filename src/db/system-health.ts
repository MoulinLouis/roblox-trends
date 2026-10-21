import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface TimescaleJobHealth {
  jobId: number;
  procName: string;
  // The hypertable, or the continuous aggregate for its refresh and compression policies.
  hypertableName: string | null;
  scheduleIntervalSeconds: number;
  scheduled: boolean;
  lastRunStatus: string | null;
  // Null when the policy never succeeded.
  lastSuccessfulFinish: Date | null;
  initialStart: Date | null;
}

export interface ArchiverHealth {
  archiveMode: string;
  lastArchivedAt: Date | null;
  lastFailedAt: Date | null;
}

// TimescaleDB starts last_successful_finish at -infinity, which would parse to an invalid date and never look late.
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// The policies added by the migrations (ids from 1000; lower ids are TimescaleDB's own jobs). The jobs view names a
// continuous aggregate's policies after the aggregate rather than its materialized hypertable.
export async function readTimescaleJobs(db: Database): Promise<TimescaleJobHealth[]> {
  const result = await db.execute<{
    job_id: number;
    proc_name: string;
    hypertable_name: string | null;
    schedule_seconds: number;
    scheduled: boolean;
    last_run_status: string | null;
    last_successful_finish: Date | string | null;
    initial_start: Date | string | null;
  }>(sql`
    select j.job_id, j.proc_name, j.hypertable_name, extract(epoch from j.schedule_interval)::int as schedule_seconds,
      j.scheduled, s.last_run_status, nullif(s.last_successful_finish, '-infinity') as last_successful_finish, j.initial_start
    from timescaledb_information.jobs j
    left join timescaledb_information.job_stats s on s.job_id = j.job_id
    where j.job_id >= 1000
    order by j.job_id
  `);
  return result.rows.map((row) => ({
    jobId: row.job_id,
    procName: row.proc_name,
    hypertableName: row.hypertable_name,
    scheduleIntervalSeconds: row.schedule_seconds,
    scheduled: row.scheduled,
    lastRunStatus: row.last_run_status,
    lastSuccessfulFinish: toDate(row.last_successful_finish),
    initialStart: toDate(row.initial_start),
  }));
}

export async function readArchiver(db: Database): Promise<ArchiverHealth> {
  const result = await db.execute<{
    archive_mode: string;
    last_archived_time: Date | string | null;
    last_failed_time: Date | string | null;
  }>(sql`select current_setting('archive_mode') as archive_mode, last_archived_time, last_failed_time from pg_stat_archiver`);
  const row = result.rows[0];
  return {
    archiveMode: row?.archive_mode ?? "off",
    lastArchivedAt: toDate(row?.last_archived_time ?? null),
    lastFailedAt: toDate(row?.last_failed_time ?? null),
  };
}
