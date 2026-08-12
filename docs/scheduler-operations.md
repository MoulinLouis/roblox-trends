# Durable scheduler operations

The production scheduler reconciles desired jobs against state stored in Neon PostgreSQL. Render is the primary clock and GitHub Actions is a low-frequency fallback. Neither provider can duplicate a completed slot because both use the same database leases and job-run records.

## Job cadence

| Job | Logical cadence | Behavior after a missed trigger |
| --- | --- | --- |
| Collection | Hourly | Collects the current bucket at the next tick; snapshot writes remain idempotent. |
| Analysis | Every four hours | Recomputes the latest complete state at the next tick. |
| Agent brief | Daily after 05:00 UTC | Generates files for the active runner and persists the latest JSON and Markdown in Neon. |
| Report | Daily after 05:00 UTC | Sends only unseen events. A missing webhook is logged without failing other jobs. |
| Maintenance | Daily after 05:00 UTC | Compacts eligible hourly snapshots with idempotent SQL. |

Render invokes `npm run tick` every ten minutes. Each tick:

1. Applies database migrations.
2. Acquires the global scheduler lease.
3. Computes the latest logical slot for every job.
4. Acquires each due job atomically.
5. Retries failed or expired jobs and skips successful slots.
6. Releases the global lease and exits.

The lease lasts 30 minutes. If a runner is terminated, another runner can resume after expiry. Render also guarantees that only one instance of its cron service is active, while the database lease protects against overlap with GitHub or manual invocations.

## Create the Render cron service

1. Confirm that the Neon production branch is in Europe. The committed Blueprint uses Render's `frankfurt` region; change `region` in `render.yaml` first if Neon is elsewhere.
2. In Render, select **New → Blueprint** and connect `MoulinLouis/roblox-trends`.
3. Select the `main` branch and apply `render.yaml`.
4. Enter the production Neon connection string for `DATABASE_URL`.
5. Enter `DISCORD_WEBHOOK_URL`, or leave it empty if reports and application alerts are intentionally disabled.
6. Wait for the first build, then select **Trigger Run** once.
7. Confirm that the run ends successfully and logs `Scheduler tick completed`.

The Blueprint uses the Starter cron instance and therefore has a minimum Render charge. Secrets are declared with `sync: false` and are never committed.

## Configure independent freshness monitoring

Monitor the public endpoint below from a provider other than Render and Neon:

```text
https://<production-host>/api/health/data
```

The endpoint returns `200` only when:

- the latest usable collection is at most 75 minutes old;
- the latest analysis is at most 5 hours old.

It otherwise returns `503`. Configure the monitor to run every 10–15 minutes and alert after two consecutive failures. The endpoint deliberately exposes only timestamps, ages, and health thresholds; it bypasses application Basic Authentication so an external monitor can call it without storing the application password.

Also enable Render notifications for failed cron runs. Endpoint monitoring detects stale data even if the scheduler never starts, while Render notifications provide immediate job-level failure context.

## GitHub fallback and manual operations

`Scheduler fallback` invokes the same reconciliation command once per hour. GitHub may delay or drop it, but it is no longer the primary clock. In normal operation, the fallback sees successful Render-owned slots and exits without calling Roblox.

The existing collection, analysis, and daily workflows remain available through `workflow_dispatch` for manual intervention. Their automatic schedules are disabled.

Useful commands:

```bash
npm run tick
npm run collect
npm run analyze
npm run brief
npm run report
npm run maintenance
```

`collect` is intentionally forceful when invoked manually. `tick` is the safe operational default because it honors all leases and completed slots.

## Diagnostics

Inspect recent reconciliation state in Neon:

```sql
select job_name, scheduled_for, status, attempt, started_at, finished_at, error
from scheduled_job_runs
order by started_at desc
limit 30;
```

Inspect an active or abandoned global lease:

```sql
select name, owner, acquired_at, lease_until
from scheduler_locks;
```

Retrieve the latest persisted agent brief from the authenticated application:

```text
GET /api/agent-brief
GET /api/agent-brief?format=markdown
```
