# Roblox Trend Radar

Roblox Trend Radar is a growth-first market intelligence application for choosing a realistic next Roblox game concept. It tracks historical snapshots, scores momentum, detects multi-creator concept propagation and saturation, and turns promising signals into scoped game ideas.

The application is one Next.js 16 service with one PostgreSQL-compatible database. Local development can use embedded PGlite. Production uses persistent Neon PostgreSQL. The application only displays data collected from live Roblox sources.

## What it measures

- CCU growth over 1 hour, 24 hours, 72 hours, and 7 days, plus absolute player gains.
- Rolling-window CCU growth, acceleration, new visits, new favorites, vote velocity, comparable chart movement, freshness, and growth persistence.
- Provisional discovery signals remain separate from durable momentum. Momentum compares 24-hour, 72-hour, or 7-day averages as enough history becomes available and exposes its history confidence.
- Independent dimensions for core loop, progression, reward, social pressure, and theme.
- Rising title words and two-word phrases, promoted only when several independent creators adopt them and recent frequency exceeds the older baseline.
- Dedicated launch-breakout signals for games created within 90 days that rapidly reach 1,000+ CCU, cross meaningful CCU milestones, or accelerate over verified 1h/3h/6h/24h windows.
- Dedicated resurgence signals for older games that move far above their recent median, establish a new tracked high, or post strong relative 6h/24h growth.
- Hype clusters that aggregate the mechanics, progression patterns, rewards, social hooks, and themes shared by active launch breakouts and resurgences.
- Trend breadth, creator diversity, combined demand, new entrants, growing share, and leader concentration.
- Separate momentum, trend, saturation, and solo-developer opportunity scores with visible breakdowns.
- Evidence-ranked ideas with title alternatives and recent-game breakout proof; deterministic generation works without a paid API, with optional OpenAI structured generation.

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
npm run tick
```

The commands are intentionally separate:

- `collect` reads 22 broad and genre-specific Roblox Charts, enriches games through the Games and Votes APIs, rotates through a bounded keyword-search window, explores recommendation results, consumes candidates from the Rolimon's acceleration frontier, and writes idempotent snapshots. It immediately re-evaluates launch breakouts and resurgences after persistence. Previously resolved Rolimon's Place IDs are reused from the game catalog instead of calling Roblox again.
- `analyze` updates game momentum, trend stages, saturation, opportunity scores, history, and deterministic ideas.
- `brief` writes an agent-oriented Markdown and JSON decision dossier using only fully covered evidence windows, including live rising games and their hype clusters.
- `report` sends only unseen breakout, stage-change, and opportunity events to Discord.
- `maintenance` aggregates hourly snapshots older than the configured retention into daily rows and removes the compacted hourly rows.
- `tick` reconciles every scheduled job against durable leases and completed slots stored in PostgreSQL. It is the production scheduler entry point.

The collection bucket is one hour. A retry inside the same bucket updates the matching `(universe, bucket, source, chart)` row instead of creating a duplicate. Every attempt and its per-source outcome are retained separately for diagnosis. Collection health is `healthy`, `degraded`, or `critical`; missing optional discovery remains degraded, while missing snapshots, insufficient chart coverage, or Games API failures are critical.

The durable scheduler checks every fifteen minutes and writes at most one successful execution per logical slot. A lightweight Rolimon's frontier scan records sub-chart CCU movement before hourly enrichment, while collection remains hourly. A PostgreSQL lease prevents scheduled and manual reconciliation from overlapping. Discord receives an immediate critical collection alert, an alert after two consecutive degraded attempts, a recovery alert, and a bounded digest of the strongest new rising-game events. Alert delivery failures are isolated from collection.

Games published in the last 90 days continue to receive direct snapshots after leaving a chart. Older games continue to be tracked while they have recorded at least 100 CCU during the last 30 days. This avoids mistaking a missing chart observation for stable demand or losing the decline after a breakout.

To merge an existing local PGlite history into a configured production PostgreSQL database, run:

```bash
DATABASE_URL="postgresql://..." npm run db:import-local
```

The import copies only live game metadata, tags, snapshots, daily aggregates, and source-run history. It is idempotent and does not copy derived scores, trends, ideas, settings, alert state, or secrets. Run `npm run analyze` against the production database after the import.

## Agent decision dossier

Every daily brief refreshes:

```text
.data/reports/latest-agent-brief.md
.data/reports/latest-agent-brief.json
```

The dossier is the preferred input for AI-assisted decisions. It records data freshness, verified 1-hour/24-hour/72-hour/7-day coverage, source failures, confidence caps, broad format signals, theme signals, combinations, saturation risks, supporting Roblox games, and questions requiring human judgment. A short observation is never labeled as 24-hour or 72-hour growth in this export.

The latest structured and Markdown versions are also persisted in Neon and exposed through the authenticated `/api/agent-brief` endpoint, so they survive an ephemeral scheduler filesystem.

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
| `DISCORD_WEBHOOK_URL` | Reporting | Discord webhook for daily reports, rising-game digests, and collection-health alerts; it can alternatively be stored in Settings. |
| `OPENAI_API_KEY` | No | Enables optional structured AI idea generation. |
| `OPENAI_MODEL` | No | OpenAI model for ideas; defaults to `gpt-5-mini`. |

Settings persisted from the interface take precedence for collection thresholds, score weights, taxonomy, developer profile, collection choices, and the Discord webhook.

## Automation

GitHub Actions is the primary production clock:

- `CI` runs linting, type checking, tests, and the production build on pushes and pull requests.
- `Scheduler` runs the durable reconciliation command every fifteen minutes at staggered minutes to reduce start-of-hour delays.
- `Collect Roblox data`, `Refresh analysis`, and `Analyze and report` remain manually dispatchable for operations and recovery.

Scheduled workflows must receive a persistent `DATABASE_URL` repository secret; a runner-local PGlite database is intentionally not suitable because GitHub runners are ephemeral. Add `DISCORD_WEBHOOK_URL` as a secret for reports and alerts. An optional `HEALTHCHECKS_PING_URL` secret enables independent heartbeat monitoring without deploying the web application or owning a domain.

The scheduler uses Neon PostgreSQL for atomic leases and job history, retries expired or failed slots, and exits. Standard GitHub-hosted runners are free for this public repository. The optional paid Render cron declared in `render.yaml` can be added later as a second clock without causing duplicate work. Full setup and incident procedures are documented in [`docs/scheduler-operations.md`](docs/scheduler-operations.md).

## Deployment

For a typical deployment:

1. Create one PostgreSQL database and set `DATABASE_URL`.
2. Run `npm run db:migrate` against it.
3. Deploy the Next.js application.
4. Add `APP_PASSWORD` if the deployment is publicly reachable.
5. Add the same `DATABASE_URL` to GitHub Actions secrets and keep the `Scheduler` workflow active.
6. Add `HEALTHCHECKS_PING_URL` for domain-free scheduler monitoring, or monitor `/api/health/data` after deploying the web application.

The included Dockerfile builds the standalone Next.js output. It expects a `public` directory and copies the migrations required at runtime. On a platform with a persistent disk, PGlite can be mounted at `PGLITE_DATA_DIR`, but hosted PostgreSQL is recommended for scheduled jobs.

## Verified external API behavior

The endpoints were called directly on August 9–10, 2026:

- `GET https://apis.roblox.com/explore-api/v1/get-sorts` accepted `sessionId`, `device`, and `country`. It returned a `sorts` array; game sorts included `top-trending`, `up-and-coming`, and `top-playing-now`, and currently embedded their game arrays.
- `GET https://apis.roblox.com/explore-api/v1/get-sort-content` returned one sort object with a `games` array. Each game exposed `universeId`, `rootPlaceId`, `name`, `playerCount`, and vote/maturity fields. No continuation token was present in the tested response.
- Direct sort-content calls succeeded for 22 configured sort IDs, including 13 `trending-in-*` genre sorts plus `top-rated`, `most-popular`, `top-paid-access`, and `top-earning`. Several of these valid sorts were not advertised by the tested `get-sorts` response.
- `GET https://games.roblox.com/v1/games?universeIds=...` returned `data` with creator metadata, `created`, `updated`, `playing`, `visits`, and `favoritedCount`.
- `GET https://games.roblox.com/v1/games/votes?universeIds=...` returned cumulative `upVotes` and `downVotes` without authentication.
- `GET https://games.roblox.com/v1/games/recommendations/game/{universeId}?maxRows=20` returned related games with player counts, votes, and sponsorship fields without authentication.
- `GET https://apis.roblox.com/search-api/omni-search` accepted `searchQuery`, `sessionId`, and `pageType=all`, returned 40 results in the tested first page, and exposed a next-page token. The collector intentionally uses only the first bounded page.
- The tested Charts response advertised a 50 requests/minute limit for sort content and 120 requests/minute for sorts; Games advertised 300 requests/minute. These headers are observational and can change.
- `GET https://api.rolimons.com/games/v1/gamelist` remained public and returned 7,137 games in a map from Place ID to `[name, activePlayers, iconUrl]`. It does not provide Universe IDs. The collector resolves only the configured number of highest-CCU extra candidates through Roblox's public place-to-universe endpoint.
- `GET https://games.roblox.com/v1/games/multiget-place-details` returned `401` without authentication. The collector therefore uses `GET https://apis.roblox.com/universes/v1/places/{placeId}/universe`, which returned a Universe ID without authentication in the direct test.

These public web endpoints are not a stability contract. The client validates response shapes, spaces requests per Roblox host, uses timeouts and bounded exponential-backoff retries with jitter, honors `Retry-After` and rate-limit reset headers, caches responses in-process, rotates search keywords, stops search after a terminal `429`, limits Rolimon's resolution concurrency, reuses known Place-to-Universe mappings, and records source-specific failures without discarding successful sources. Attempt details also retain request, retry, and rate-limit counters.

The retry behavior follows Roblox's [rate-limit guidance](https://create.roblox.com/docs/cloud/reference/rate-limits): treat `429` as expected, honor server-provided retry timing, and use exponential backoff when no timing header is present.

Competitor research and the resulting implementation decisions are documented in [`docs/market-research.md`](docs/market-research.md).

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
