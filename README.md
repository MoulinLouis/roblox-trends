# Roblox Trend Radar

Roblox Trend Radar is a growth-first market intelligence application for choosing a realistic next Roblox game concept. It tracks historical snapshots, scores momentum, detects multi-creator concept propagation and saturation, and turns promising signals into scoped game ideas.

The application is one Next.js 16 service with one PostgreSQL-compatible database. Local development can use embedded PGlite. Production should use a persistent PostgreSQL provider such as Supabase, Neon, or another managed PostgreSQL instance. The application only displays data collected from live Roblox sources.

## What it measures

- CCU growth over 1 hour, 24 hours, 72 hours, and 7 days, plus absolute player gains.
- Acceleration, new visits, new favorites, chart movement, freshness, and growth persistence.
- Independent dimensions for core loop, progression, reward, social pressure, and theme.
- Rising title words and two-word phrases, promoted only when several independent creators adopt them and recent frequency exceeds the older baseline.
- Trend breadth, creator diversity, combined demand, new entrants, growing share, and leader concentration.
- Separate momentum, trend, saturation, and solo-developer opportunity scores with visible breakdowns.
- Deterministic, data-supported ideas that work without a paid API; optional OpenAI structured generation.

## Clean installation with live data

Requirements: Node.js 20.19 or newer and npm.

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run collect
npm run analyze
npm run dev
```

Open `http://localhost:3000`. The first collection populates the database from Roblox Charts, the Roblox Games API, and optional Rolimon's discovery. An empty database stays empty until a successful live collection; the application never inserts synthetic games.

Run the complete validation workflow:

```bash
npm run validate
```

## Live collection

```bash
npm run db:migrate
npm run collect
npm run analyze
npm run brief
npm run report
npm run maintenance
```

The commands are intentionally separate:

- `collect` reads Roblox Charts, enriches games through the Games API, optionally discovers extra candidates through Rolimon's, and writes idempotent snapshots.
- `analyze` updates game momentum, trend stages, saturation, opportunity scores, history, and deterministic ideas.
- `brief` writes an agent-oriented Markdown and JSON decision dossier using only fully covered evidence windows.
- `report` sends only unseen breakout, stage-change, and opportunity events to Discord.
- `maintenance` aggregates hourly snapshots older than the configured retention into daily rows and removes the compacted hourly rows.

The default collection bucket is 30 minutes. A retry inside the same bucket updates the matching `(universe, bucket, source, chart)` row instead of creating a duplicate.

## Local WSL scheduler

Install the managed user crontab block:

```bash
npm run cron:install
npm run cron:status
```

The local schedule runs a collection at minutes 17 and 47 of every hour. It refreshes analysis near every six hours, with the 06:35 daily run providing the fourth refresh while also sending the report and running maintenance. From 06:35 onward, the daily work retries hourly until it completes once for the current day. An `@reboot` entry collects immediately whenever the WSL cron service starts. All jobs share one non-blocking lock so collection and analysis cannot overlap.

Logs are appended to `.data/logs/local-scheduler.log`. The installer preserves unrelated crontab entries and can safely be run again. Remove only the managed block with:

```bash
npm run cron:remove
```

The WSL distribution and its `cron` systemd service must remain running. Windows sleep pauses collection, and a Windows restart requires WSL to start again unless a Windows logon task launches it automatically.

## Agent decision dossier

Every scheduled analysis refreshes:

```text
.data/reports/latest-agent-brief.md
.data/reports/latest-agent-brief.json
```

The dossier is the preferred input for AI-assisted decisions. It records data freshness, verified 1-hour/24-hour/72-hour/7-day coverage, source failures, confidence caps, broad format signals, theme signals, combinations, saturation risks, supporting Roblox games, and questions requiring human judgment. A short observation is never labeled as 24-hour or 72-hour growth in this export.

Generate it manually with:

```bash
npm run brief
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Production | PostgreSQL connection string. If absent, PGlite uses `PGLITE_DATA_DIR`. |
| `PGLITE_DATA_DIR` | No | Local embedded database directory; defaults to `.data/roblox-trends`. |
| `APP_USERNAME` | No | Basic Authentication username; defaults to `radar`. |
| `APP_PASSWORD` | No | Enables single-user Basic Authentication when non-empty. |
| `ROBLOX_COUNTRY` | No | Charts country filter; defaults to `all`. |
| `ROBLOX_DEVICE` | No | Charts device filter; defaults to `computer`. |
| `ROLIMONS_ENABLED` | No | Enables the additional Rolimon's discovery source. |
| `DISCORD_WEBHOOK_URL` | Reporting | Discord webhook; it can alternatively be stored in Settings. |
| `OPENAI_API_KEY` | No | Enables optional structured AI idea generation. |
| `OPENAI_MODEL` | No | OpenAI model for ideas; defaults to `gpt-5-mini`. |

Settings persisted from the interface take precedence for collection thresholds, score weights, taxonomy, developer profile, collection choices, and the Discord webhook.

## Automation

Three GitHub Actions workflows are included:

- `CI` runs linting, type checking, tests, and the production build on pushes and pull requests.
- `Collect Roblox data` runs every 30 minutes at minutes 17 and 47.
- `Analyze and report` runs daily at 05:20 UTC, sends the Discord report, then compacts old snapshots.

Every workflow supports manual dispatch. Scheduled workflows must receive a persistent `DATABASE_URL` repository secret; a runner-local PGlite database is intentionally not suitable because GitHub runners are ephemeral. Add `DISCORD_WEBHOOK_URL` as a secret for reports.

## Deployment

For a typical deployment:

1. Create one PostgreSQL database and set `DATABASE_URL`.
2. Run `npm run db:migrate` against it.
3. Deploy the Next.js application.
4. Add `APP_PASSWORD` if the deployment is publicly reachable.
5. Add the same `DATABASE_URL` to GitHub Actions secrets and enable the scheduled workflows.

The included Dockerfile builds the standalone Next.js output. It expects a `public` directory and copies the migrations required at runtime. On a platform with a persistent disk, PGlite can be mounted at `PGLITE_DATA_DIR`, but hosted PostgreSQL is recommended for scheduled jobs.

## Verified external API behavior

The endpoints were called directly on August 9, 2026:

- `GET https://apis.roblox.com/explore-api/v1/get-sorts` accepted `sessionId`, `device`, and `country`. It returned a `sorts` array; game sorts included `top-trending`, `up-and-coming`, and `top-playing-now`, and currently embedded their game arrays.
- `GET https://apis.roblox.com/explore-api/v1/get-sort-content` returned one sort object with a `games` array. Each game exposed `universeId`, `rootPlaceId`, `name`, `playerCount`, and vote/maturity fields. No continuation token was present in the tested response.
- `GET https://games.roblox.com/v1/games?universeIds=...` returned `data` with creator metadata, `created`, `updated`, `playing`, `visits`, and `favoritedCount`.
- The tested Charts response advertised a 50 requests/minute limit for sort content and 120 requests/minute for sorts; Games advertised 300 requests/minute. These headers are observational and can change.
- `GET https://api.rolimons.com/games/v1/gamelist` remained public and returned 7,137 games in a map from Place ID to `[name, activePlayers, iconUrl]`. It does not provide Universe IDs. The collector resolves only the configured number of highest-CCU extra candidates through Roblox's public place-to-universe endpoint.
- `GET https://games.roblox.com/v1/games/multiget-place-details` returned `401` without authentication. The collector therefore uses `GET https://apis.roblox.com/universes/v1/places/{placeId}/universe`, which returned a Universe ID without authentication in the direct test.

These public web endpoints are not a stability contract. The client validates response shapes, uses timeouts and bounded retries, honors `Retry-After`, caches responses in-process, limits Rolimon's resolution concurrency, and records source-specific failures without discarding successful sources.

## Project map

```text
src/app/          Next.js pages and mutation endpoints
src/components/   Responsive interface components
src/db/           Drizzle schema, connection, migrations, repository
src/lib/api/      Roblox and Rolimon's clients and parsers
src/lib/          Classification, scoring, analysis, ideas, reports
scripts/          collect, analyze, report, maintenance, migrate
drizzle/          PostgreSQL migrations
.github/workflows Scheduled jobs and CI
```

The optional OpenAI path uses the Responses API with a strict JSON Schema, following the [official Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs). The deterministic generator remains the default and requires no key.
