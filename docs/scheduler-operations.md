# Durable scheduler operations

The production scheduler reconciles desired jobs against state stored in Neon PostgreSQL. GitHub Actions is the primary clock. An optional Render cron or a manual invocation cannot duplicate a completed slot because every runner uses the same database leases and job-run records.

## Job cadence

| Job | Logical cadence | Behavior after a missed trigger |
| --- | --- | --- |
| Discovery frontier | Every 15 minutes | Reconciles the latest public Rolimon's game list, retains a bounded eight-hour CCU history, and queues qualified accelerations for full Roblox enrichment. A source failure is logged as degraded without blocking collection. |
| Collection | Hourly | Collects the current bucket at the next tick; snapshot writes remain idempotent. |
| Analysis | Every four hours | Recomputes the latest complete state at the next tick. |
| Agent brief | Daily after 05:00 UTC | Generates files for the active runner and persists the latest JSON and Markdown in Neon. |
| Report | Daily after 05:00 UTC | Sends only unseen events. A missing webhook is logged without failing other jobs. |
| Maintenance | Daily after 05:00 UTC | Compacts eligible hourly snapshots with idempotent SQL. |

GitHub Actions invokes `npm run tick` every fifteen minutes at minutes 7, 22, 37, and 52. The staggered schedule avoids the start-of-hour congestion window where GitHub documents an increased risk of delayed or dropped scheduled events. Each tick:

1. Applies database migrations.
2. Acquires the global scheduler lease.
3. Computes the latest logical slot for every job.
4. Acquires each due job atomically.
5. Retries failed or expired jobs and skips successful slots.
6. Releases the global lease and exits.

The lease lasts 30 minutes. If a runner is terminated, another runner can resume after expiry. GitHub workflow concurrency prevents its own runs from overlapping, while the database lease also protects against manual invocations and optional secondary providers.

## Configure the free GitHub scheduler

1. Open **Settings → Secrets and variables → Actions** in `MoulinLouis/roblox-trends`.
2. Store the direct connection string for the Neon production branch as the `DATABASE_URL` repository secret.
3. Optionally store `DISCORD_WEBHOOK_URL` for daily reports, rising-game digests, and collection-health alerts.
4. Open **Actions → Scheduler** and make sure the workflow is enabled.
5. Select **Run workflow**, run it from `main`, and confirm that the logs end with `Scheduler tick completed` and an empty `failures` array.

The repository is public and the workflow uses a standard GitHub-hosted runner, so GitHub does not bill runner minutes for these scheduled runs. GitHub can still delay or drop an individual scheduled event. Running four staggered reconciliations per hour, persisting state in Neon, and monitoring the heartbeat limit the impact of that behavior.

## Configure domain-free heartbeat monitoring

Healthchecks.io can detect a scheduler that fails, produces stale data, or stops launching without requiring a deployed website or a domain. At the end of each tick, the command verifies the same collection and analysis freshness thresholds used by `/api/health/data`; a stale state makes the workflow fail and prevents a success ping.

1. Create a free Healthchecks.io account and add a check named `Roblox Trends Scheduler`.
2. Use a simple schedule with a 20-minute period and a 20-minute grace time. This alerts after approximately 40 minutes without a successful run while tolerating one delayed GitHub event.
3. Enable an email notification integration for the check.
4. Copy the generated ping URL, which has the form `https://hc-ping.com/<uuid>`.
5. Add it to the GitHub repository as an Actions secret named `HEALTHCHECKS_PING_URL`.
6. Manually run the `Scheduler` workflow once and confirm that the check becomes **Up**.

Treat the ping URL as a secret. The workflow sends start, success, and failure signals but deliberately does not fail data collection if the monitoring provider is temporarily unavailable.

## Configure data freshness monitoring after web deployment

If the Next.js application is deployed later, monitor its public endpoint from an external provider:

```text
https://<production-host>/api/health/data
```

The endpoint returns `200` only when:

- the latest usable collection is at most 75 minutes old;
- the latest analysis is at most 5 hours old.

It otherwise returns `503`. Configure the monitor to run every 10–15 minutes and alert after two consecutive failures. The endpoint deliberately exposes only timestamps, ages, and health thresholds; it bypasses application Basic Authentication so an external monitor can call it without storing the application password. A provider-generated hostname is sufficient; a custom domain is optional.

Heartbeat monitoring detects a missing GitHub run. Endpoint monitoring additionally detects stale data even if a workflow reports success, so use both after the web application has a public URL.

## Optional paid Render clock and manual operations

The committed `render.yaml` remains available as an optional paid secondary clock. It is not required for production. If it is enabled later, it uses the same Neon leases and normally skips slots already completed by GitHub.

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

Inspect active launch breakouts and resurgences:

```sql
select universe_id, signal_type, tier, score, current_ccu, last_detected_at
from rising_game_signals
where active = true
order by score desc, current_ccu desc;
```

Inspect recent idempotent signal events and Discord delivery state:

```sql
select universe_id, signal_type, event_type, tier, score, current_ccu, detected_at, notified_at
from rising_game_events
order by detected_at desc
limit 50;
```
