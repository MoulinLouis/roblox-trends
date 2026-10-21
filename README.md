# Roblox Trend Radar

Roblox Trend Radar tracks Roblox games to answer three questions: which Roblox formats convert right now, what is breaking out early, and whether a concept still has room. The v1 radar answered them late: games that later passed 10,000 CCU were first seen at a median of 6,216 CCU, only 54% of the Rolimon's games above 100 CCU were tracked in detail, and irregular GitHub Actions runs captured 37–58% of the real weekend peaks of the owner's game. v2 rebuilds the data core on one server: every place listed by Rolimon's is counted every 10 minutes, the 2,000 highest-priority active games are polled every 10 minutes and the other active games every 20–30 minutes, and the history lives in PostgreSQL with TimescaleDB, so the database computes the aggregates. This branch implements phase 1a, the data core: schema, collectors, legacy history import and a status command. Phase 1b runs it on one production server (see Production). Classification, analysis and the dashboard follow in later phases.

## Architecture

One Next.js 16 application and one PostgreSQL 18 database with TimescaleDB 2.30, accessed through Drizzle ORM and `pg` on Node.js 24 (`.nvmrc` and CI). `package.json` declares Node.js 22.12 or newer and npm 11 or newer (`engines` only warns). In this phase the web application is only a shell. The work is done by six collectors in `src/lib/jobs`, started by `npm run job <name>` (one job) or `npm run collect` (all of them). In production each job runs from its own systemd timer (phase 1b).

`executeJob` (`src/lib/jobs/runner.ts`) runs every job the same way:

- It pings the Healthchecks check `radar-<job>` on start, records a `job_runs` row for the slot (the start time floored to the job's interval), enforces the job's timeout, then pings success or failure.
- A run ends `success`, `degraded` or `failed`. Degraded runs still ping `radar-<job>`; only fully successful runs also ping `radar-<job>-quality`, so a sustained degradation alerts through that check.
- A run still marked `running` one minute after its timeout is marked `failed` (`abandoned`) by the job's next run.
- Observations are keyed by their slot, so a retry within the same slot overwrites instead of duplicating.

Job intervals, timeouts, thresholds and limits live in `src/lib/config.ts`: `JOB_CONFIG`, `ACTIVE_SET_CONFIG`, `STATUS_CONFIG`, `EXTERNAL_REQUEST_CONFIG`, `DATABASE_SESSION_CONFIG` and `ROBLOX_DISCOVERY_CHARTS`, plus `ROBLOX_REGION` read from the environment. The intervals must match the systemd timers. `DATABASE_SESSION_CONFIG` holds the database session limits of the scripts: `lock_timeout`, the `statement_timeout` of `status` and of the legacy import (a job's is its own timeout), how long a script waits for its connections to close before it exits, and the grace after which a run still marked `running` is abandoned.

| Job | Interval | Timeout | Work |
| --- | --- | --- | --- |
| `census` | 10 min | 9 min | Downloads the Rolimon's game list and writes `census_observations`. Resolves every listed place at or above 100 CCU whose universe is unknown, busiest first, within a 150-second budget per run (the rest waits for the next run), and promotes the new universes to `games`. A place without a universe is retried after 7 days. |
| `poll` | 10 min | 9 min | Calls the Games API in batches of 50, one request every 7 s (the game details limit, below), and writes `game_observations` batch by batch. Each run requests the hot set, the 2,000 highest-priority active games, then the rotating tail: the 1,150 other active games whose details were stored or requested the longest ago (never either first), 63 requests in about 441 s, so each tail game is refreshed every 20–30 minutes while `census` still counts its CCU every 10 minutes. A game Roblox does not answer moves behind the others too, so it is retried once per tail cycle instead of heading every run; `missing` counts the requested games Roblox did not answer and `missingSample` lists up to 10 of their universe ids. Updates `games` and records name and description changes in `game_versions`. No batch starts after a 7.5-minute deadline (about 64 requests), after a 429 that outlasted the retries, or after 3 failed batches in a row: the end of the request order, tail before hot set, waits for the next run. |
| `votes` | 1 h | 30 min | Calls the votes endpoint for the active set in batches of 50 and writes `vote_observations`, with the same stop rules as `poll` and a 25-minute deadline. |
| `charts` | 1 h | 30 min | Reads the 22 discovery sorts of `ROBLOX_DISCOVERY_CHARTS`, replaces each sort's hourly slot in `chart_placements` as soon as it is read, and promotes new universes. A rank is the position Roblox listed the game at. |
| `explore` | 1 h | 30 min | Asks for 20 recommendations for each of the 10 fastest-rising games at most 60 days old (6-hour average of at least 150 CCU, compared with the same window a day earlier), and searches up to 4 words shared by at least 3 of the titles of up to 50 rising games (by all of them when fewer are available). Promotes found games at or above 50 CCU and also records sightings of games already tracked in `discovery_sources`. |
| `thumbnails` | 1 h | 30 min | Batches of 50, at most 4,000 games per run, with a 20-minute deadline. Checks games never requested first, then refreshes games at or above 50 CCU (a reading less than 24 hours old) whose last check is older than 24 hours. A game never checked that Roblox answered as pending, with an error or not at all is retried last, once its last request is more than 6 hours old. Stores the 16:9 thumbnail and the icon; a new thumbnail key records a thumbnail version. |

A game is active when its best CCU evidence of the last 24 hours (hourly peaks, census readings of the last 30 minutes, or its latest stored CCU if less than 24 hours old) is at least 50, or when it is at most 90 days old and had players in the last 7 days.

Quality gates mark a run `degraded`:

- `poll`: fewer than 95% of the requested games (the hot set and the tail slice) returned, or an empty active set.
- `votes`: fewer than 95% of the active set returned, or an empty active set.
- `census`: a list shorter than 1,000 places, more than 5% malformed entries, or a size change above 30% from the latest list of the last 6 hours that passed this check; a list identical to the latest one read (Rolimon's serving the previous slot again, `listQuality` `repeated`), which is not stored; also a stalled place resolution or a failed promotion. A Rolimon's outage (an error status, a network failure or a broken envelope) degrades the run too, with `listQuality` `failed` and the error in `listError`, while `poll` keeps sampling the tracked games; a database error still fails it.
- `charts`: fewer than 80% of the sorts collected (an empty sort, or one with more than 20% malformed entries, counts as failed), a 429 that outlasted the retries, or a failed promotion.
- `explore`: an endpoint that failed or answered empty on every request, a 429, or a failed promotion.
- `thumbnails`: fewer than 90% of the requested games answered. A run where Roblox answered for no game fails.

### Tables

Hypertables (`drizzle/0001_timescale.sql`), without foreign keys:

| Table | Grain | Content | Chunk | Compressed after | Raw retention |
| --- | --- | --- | --- | --- | --- |
| `game_observations` | universe × 10-minute slot (5-minute until 2026-10-21) | CCU, visits, favorites; `source` is `poll` or `legacy` | 1 day | 7 days | 365 days |
| `census_observations` | place × 10-minute slot | Rolimon's active players | 1 day | 7 days | 365 days |
| `vote_observations` | universe × hour | Cumulative up and down votes | 7 days | 30 days | Permanent |
| `chart_placements` | sort × universe × hour | Rank, player count, sponsored flag | 7 days | 30 days | Permanent |

Continuous aggregates, kept permanently. They are real-time: buckets not yet materialized are computed from the raw rows at query time. Their policies refresh up to one hour before now.

| View | Bucket | Columns | Refresh | Compressed after |
| --- | --- | --- | --- | --- |
| `game_hourly` | universe × hour | `ccu_min`, `ccu_avg`, `ccu_max`, `visits_max`, `favorites_last`, `samples` | Every 15 min, last 3 days | 30 days |
| `game_daily` | universe × UTC day | `ccu_min`, `ccu_avg`, `ccu_peak`, `visits_min`, `visits_max`, `favorites_last`, `samples` | Every hour, last 7 days | Not compressed |
| `census_hourly` | place × hour | `ccu_min`, `ccu_avg`, `ccu_max`, `samples` | Every 15 min, last 3 days | 30 days |

The view `game_daily_all` merges `game_daily` (`origin = 'observed'`) with `game_daily_legacy` (`origin = 'legacy'`) for the days `game_daily` lacks.

Regular tables (`src/db/schema.ts`):

- `games`: one row per universe with Roblox metadata, the Roblox creation time (`roblox_created_at`) kept separate from the radar's first observation (`first_observed_at`), the latest CCU and the last time it had players (`last_active_at`), name and description fingerprints, and the current thumbnail, icon and check time, with the time of the last thumbnail request (`thumbnails_attempted_at`), answered or not. `thumbnail_key` is `media:<asset id>`, or `url:<sha1>` of the image URL when Roblox gives no asset id.
- `places`: cached place-to-universe mapping. A place without a universe keeps a null `universe_id` and an `error`.
- `game_versions`: `metadata` versions (name and description) and `thumbnail` versions, each with its observation time.
- `discovery_sources`: one row per universe, source (`rolimons`, `chart`, `search`, `recommendation`) and detail (sort id, search term or seed universe), with first and last sighting. `explore` also records sightings of games already tracked, so the table holds relations too: a row is the game's discovery path when its `first_seen_at` equals `games.first_observed_at`.
- `game_daily_legacy`: the v1 daily snapshots (the days v1 had compacted, from 2026-08-24): average and peak CCU, visits, favorites, and the v1 daily votes and best rank, null where v1 had no reading.
- `job_runs`: one row per job execution, with slot, status, duration, `stats` and error.

The full design is in [`docs/plans/2026-10-20-radar-v2-design.md`](docs/plans/2026-10-20-radar-v2-design.md), and the phase 1a plan with its execution notes in [`docs/plans/2026-10-20-radar-v2-phase-1a-data-core.md`](docs/plans/2026-10-20-radar-v2-phase-1a-data-core.md).

```text
src/lib/jobs/     Collectors, the job runner and Healthchecks pings
src/lib/api/      Roblox and Rolimon's clients, parsers and the HTTP client
src/lib/legacy/   v1 history import
src/lib/ops/      Healthchecks provisioning and system check logic
src/lib/          Configuration, time slots, fingerprints, status report
src/components/   React components (navigation, interactive area chart)
src/db/           Drizzle schema, client, migrations runner and repositories
src/app/          Next.js application shell
scripts/          job, collect, import-legacy, status, migrate, provision-healthchecks, system-check
ops/              Server units (systemd), PostgreSQL configuration and shell scripts (docs/operations.md)
drizzle/          SQL migrations (0001 holds the TimescaleDB objects)
```

## Local setup

The database needs PostgreSQL 18 with TimescaleDB; PGlite cannot load TimescaleDB. On Ubuntu or WSL, the commands and URLs below assume PostgreSQL 18 on port 5433, because another PostgreSQL (16) already uses 5432; adjust the port if your cluster listens elsewhere.

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | sudo bash
sudo apt-get install -y postgresql-18 timescaledb-2-postgresql-18
sudo timescaledb-tune --yes --quiet --pg-config=/usr/lib/postgresql/18/bin/pg_config
sudo pg_ctlcluster 18 main restart
sudo -u postgres psql -p 5433 -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb -p 5433 roblox_trends
```

Alternatively, run the CI image: `docker run -d --name radar-db -p 5433:5432 -e POSTGRES_PASSWORD=postgres timescale/timescaledb:2.30.2-pg18`, then `docker exec radar-db createdb -U postgres roblox_trends`.

Then:

```bash
cp .env.example .env.local
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5433/roblox_trends in .env.local.
npm install
npm run db:migrate
npm run collect
npm run status
```

`npm run collect` calls the live Roblox and Rolimon's APIs. A fresh database fills over many census runs: place resolution calls `apis.roblox.com`, spaced 1.3 s apart, within a 150-second budget per run, so at most about 115 places per run (150 / 1.3). The roughly 2,900 Rolimon's places at or above 100 CCU therefore take about 25 census runs, about 4 hours at one run every 10 minutes, and longer with retries or slow responses. In production, the legacy import first seeds `places` with the v1 games. `npm run dev` serves the application shell; the dashboard returns in phase 4.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | The v2 database. Required by every command that connects to it. |
| `TEST_DATABASE_URL` | Server for the database test suites, set in `.env.test.local` (see Tests). |
| `LEGACY_DATABASE_URL` | The v1 production database, read only by `npm run import:legacy`. Never use it as `DATABASE_URL`. |
| `HEALTHCHECKS_PING_BASE` | Healthchecks.io ping base, for example `https://hc-ping.com/<ping-key>`. Checks are created on first ping with Healthchecks' default 1-day period, so they alert about 25 hours late until `npm run provision:healthchecks` sets the real periods. Without it, no ping is sent. |
| `HEALTHCHECKS_API_KEY` | Read-write Healthchecks API key, read from the environment only (not from `.env.local`) by `npm run provision:healthchecks`. Never stored on the server. |
| `RADAR_REQUIRE_HEALTHCHECKS` | `1` makes `npm run job` and `npm run system-check` refuse to run without `HEALTHCHECKS_PING_BASE`. |
| `ROBLOX_COUNTRY`, `ROBLOX_DEVICE` | Charts filters; default `all` and `computer`. |

Every command that connects to the database refuses one that still holds v1 tables, and requires PostgreSQL 18 (`RETURNING old.*`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run job <name>` | Runs one job once: `census`, `poll`, `votes`, `charts`, `explore` or `thumbnails`. Exits 1 when the run failed or could not start, and 2 for an unknown name. Sets `statement_timeout` to the job's timeout and `lock_timeout` to 30 s. |
| `npm run collect` | Runs the six jobs once, in the order above, for local setup and manual catch-up. A failed job does not stop the others; the exit code is 1 when any failed. |
| `npm run import:legacy [-- --since=<ISO date>]` | Copies the v1 history from `LEGACY_DATABASE_URL` into `DATABASE_URL`: games with their `places` mappings, metadata versions, discoveries, hourly observations within the raw retention, votes, chart placements before the first v2 `charts` run, and daily rows. It refreshes `game_hourly` and `game_daily` window by window, then fills `games.last_ccu` where `last_ccu_at` is null and moves `games.last_active_at` forward from the imported observations. The source is read in read-only transactions. Rows v2 already holds are kept: inserts skip conflicts, an existing game only widens `first_observed_at` and `last_observed_at` (least/greatest), and an existing discovery only widens its sighting window. A failed run resumes by running it again; `--since=<the failed window start, as logged>` only skips the raw windows already imported. It runs once on the first production deployment (phase 1b), after `npm run db:migrate` and before the timers are enabled, and warns if `poll` already ran. Phase 4 adds a final incremental import. |
| `npm run status` | Prints, per job, the latest and last completed run, the runs, degraded and failed counts over the last 24 hours, rate-limited runs and 429s per request, the watched census and poll stats (for `poll`, also the games requested, those Roblox did not answer, the age of the oldest tail details requested and the game details spacing the run ended with) and the last error; then the coverage of Rolimon's places at or above 100 CCU polled within 60 minutes (a tail game is polled every 20–30 minutes), and data totals. |
| `npm run db:generate` | Generates a migration from `src/db/schema.ts` into `drizzle/`. Schema changes go into new migrations. It reads only the schema and the snapshots: `drizzle.config.ts` holds no database credentials, so `drizzle-kit push` and `studio`, which would bypass the v1 guard, never pick up `DATABASE_URL`. |
| `npm run db:migrate` | Applies the migrations in `drizzle/`. Sets `lock_timeout` to 10 s, so a migration blocked behind a running job fails instead of queueing every later query behind it. Exits 1 when it failed. |
| `npm run provision:healthchecks` | Creates or updates, by slug, the 16 Healthchecks checks (a heartbeat and a quality check per job, plus `radar-deploy`, `radar-system`, `radar-backup` and `radar-restore-test`) with the periods of `JOB_CONFIG` and the graces of `HEALTHCHECKS_CONFIG`, and attaches every integration of the project. Needs `HEALTHCHECKS_API_KEY`; exits 2 without it and 1 when a check was not provisioned. Run it after any change of either configuration. |
| `npm run system-check` | Checks disk usage (limit 70%), WAL archiving (a segment archived within the last 30 minutes) and the TimescaleDB policies (paused, or without success for 3 schedule intervals and at least 60 minutes), with the limits of `SYSTEM_CHECK_CONFIG`, and pings `radar-system`. Exits 1 on any problem. In production `radar-system-check.timer` runs it every 15 minutes. |
| `npm run validate` | Runs lint, typecheck, tests and the production build. |

## Tests

`npm run test` runs Vitest. Unit tests run anywhere. The `*.db.test.ts` suites need `TEST_DATABASE_URL`, pointing to a PostgreSQL 18 + TimescaleDB server whose user can create databases. Each suite creates its own databases from `template0`, migrates them (unless it needs an empty one), pauses the TimescaleDB background jobs and drops them at the end. Fixtures never reach an application database.

Put the variable in `.env.test.local`, because Vitest runs with `NODE_ENV=test` and `@next/env` does not read `.env.local` in that mode:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
```

Without it, the database suites are reported as skipped locally. In CI a missing value fails the run. CI (`.github/workflows/ci.yml`) runs on pushes to `main` and `radar-v2`, on pull requests and on manual dispatch (`workflow_dispatch`), with Node.js 24 and a `timescale/timescaledb:2.30.2-pg18` service, and runs lint, typecheck, tests and build.

## Verified external API behavior

The v1 endpoints were called directly on August 9–10, 2026. Corrections found while building v2 are noted in place.

- `GET https://apis.roblox.com/explore-api/v1/get-sorts` accepted `sessionId`, `device`, and `country`. It returned a `sorts` array; game sorts included `top-trending`, `up-and-coming`, and `top-playing-now`, and embedded their game arrays. The v2 collectors do not use it: `charts` reads each configured sort directly.
- `GET https://apis.roblox.com/explore-api/v1/get-sort-content` returned one sort object with a `games` array. Each game exposed `universeId`, `rootPlaceId`, `name`, `playerCount`, and vote/maturity fields. No continuation token was present in the tested response. v2 sends `sessionId`, `sortId`, `device`, and `country`.
- Direct sort-content calls succeeded for the 22 configured sort IDs (`ROBLOX_DISCOVERY_CHARTS`), including 13 `trending-in-*` genre sorts plus `top-rated`, `most-popular`, `top-paid-access`, and `top-earning`. Several of these valid sorts were not advertised by the tested `get-sorts` response.
- `GET https://games.roblox.com/v1/games?universeIds=...` returned `data` with creator metadata, `created`, `updated`, `playing`, `visits`, and `favoritedCount`. v2 requests 50 universes per call, the maximum: 100 returns HTTP 400. For a moderated or deleted game (universe 3269082462, seen on 2026-10-21) it returns a placeholder item with `id` 0, the name `[TITLE UNAVAILABLE]` and creator id 0; v2 skips such an item as malformed, so the game counts as not returned.
- The game details endpoint has a hidden per-IP limit that counts universe ids, not requests, measured from production on 2026-10-21. Burst: 50 ids every 2 s got HTTP 429 on the 6th request (300 ids in about 10 s). Per minute: at 0.5 s spacing, every 5-minute poll run got about four 429s, each followed by a reset of about 33–55 s, and fetched only 1,700–2,250 of the 3,090 active games before its deadline, about 500 ids per minute. One id every 2 s ran 40 requests without a 429. Meanwhile its `x-ratelimit-*` headers kept reporting `300;w=60` with 287–290 remaining, so they do not describe this limit. v2 spaces these requests 7 s apart (about 430 ids per minute) and polls every 10 minutes.
- `GET https://games.roblox.com/v1/games/votes?universeIds=...` returned cumulative `upVotes` and `downVotes` without authentication. It does not share the game details limit: on 2026-10-21, 79 requests of 50 ids 0.5 s apart (3,928 games in 39 s) got no 429.
- `GET https://games.roblox.com/v1/games/recommendations/game/{universeId}?maxRows=20` returned related games with player counts, votes, and sponsorship fields without authentication. Its items carry `placeId` instead of `rootPlaceId`.
- `GET https://apis.roblox.com/search-api/omni-search` accepted `searchQuery`, `sessionId`, and `pageType=all`, returned 40 results in the tested first page, and exposed a next-page token. Results are grouped in `searchResults[].contents` with a `contentType`; v2 keeps the `Game` items of the first page only.
- The tested Charts response advertised a 50 requests/minute limit for sort content and 120 requests/minute for sorts; Games advertised 300 requests/minute, which does not reflect the game details limit above. These headers are observational and can change.
- `GET https://api.rolimons.com/games/v1/gamelist` remained public and returned `{ success, game_count, games }`, where `games` maps a Place ID to `[name, activePlayers, iconUrl]`: 7,137 games in August, about 7,800 by October 2026. It does not provide Universe IDs. v2 resolves every listed place at or above 100 CCU whose universe is unknown, with no count cap (a 150-second budget per census run).
- `GET https://games.roblox.com/v1/games/multiget-place-details` returned `401` without authentication. The collector therefore uses `GET https://apis.roblox.com/universes/v1/places/{placeId}/universe`, which returns a Universe ID without authentication. Correction: a place without a universe returns HTTP 200 with `{"universeId": null}`, not 404 (404 comes only for an empty id). v2 stores such a place as unresolvable and retries it after 7 days.
- `GET https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=...&countPerUniverse=3&defaults=false&size=768x432&format=Png&isCircular=false`, verified on 2026-10-20, returns `data` items `{ universeId, error, thumbnails: [{ targetId, state, imageUrl }] }`, where `targetId` is the media asset id. v2 requests 50 universes per call with `defaults=false`: with `defaults=true`, games without media come back as shared generic `GameMediaItem` images marked `Completed`. A universe whose thumbnails are all `Blocked` counts as having none; `Pending`, `InReview`, `TemporarilyUnavailable` and `Error` answers are retried: on the next run for a game being refreshed, after 6 hours for a game never checked. Image URLs carry a `180DAY-` prefix and probably expire, so thumbnail history is keyed on `games.thumbnail_key` (`media:<asset id>`, or `url:<sha1>` of the URL when Roblox gives no asset id) rather than on the URL itself.

Used by v2 but not separately verified: `GET https://thumbnails.roblox.com/v1/games/icons?universeIds=...&returnPolicy=PlaceHolder&size=150x150&format=Webp&isCircular=false`, whose `data` items are `{ targetId, state, imageUrl }`. With the placeholder policy, states other than `Completed` carry a generic image, so v2 keeps only `Completed` icons.

These public web endpoints are not a stability contract. The HTTP client (`src/lib/api/http.ts`) spaces requests per host (1.3 s on `apis.roblox.com`, 0.5 s on `games.roblox.com` and `thumbnails.roblox.com`) and per endpoint, keyed by host and exact path without the query string (7 s for `games.roblox.com/v1/games`, which leaves `/v1/games/votes` at the host's 0.5 s); a request waits for both. A 429 from a paced endpoint multiplies its spacing by 1.5 for the rest of the process, up to 30 s, and logs the new spacing. The client times out after 10 s (15 s for Rolimon's), and retries 429, 5xx and network errors up to 3 times with exponential backoff (5 s base for 429, 0.5 s otherwise, up to 750 ms of jitter, at most 60 s). It honors `Retry-After` and `x-ratelimit-reset`, pauses a host whose `x-ratelimit-remaining` reaches 0, and caches responses in-process. Other 4xx responses are not retried. Parsers validate the envelope, then each item, so a malformed item is skipped instead of discarding its batch. Skipped items are logged, except by the thumbnail and icon parsers, which skip them silently. In `census`, `poll`, `votes`, `charts` and `explore`, a 429 that outlasts the retries stops further requests to that endpoint until the next run; `thumbnails` stops after 3 unanswered batches in a row. Every job records its request, retry and 429 counts in `job_runs.stats.http`, with `endpointIntervalMs`: the spacing, at the end of the run, of each paced endpoint the process requested; for `census` the counts include the Rolimon's request and place resolution on `apis.roblox.com`.

The retry behavior follows Roblox's [rate-limit guidance](https://create.roblox.com/docs/cloud/reference/rate-limits): treat `429` as expected, honor server-provided retry timing, and use exponential backoff when no timing header is present.

## Production

v2 runs on one server, `radar-prod`: a Hetzner Cloud CAX21 (4 arm64 vCPU, 8 GB RAM, 80 GB disk) with Ubuntu 24.04, PostgreSQL 18.6 with TimescaleDB 2.30.2 and Node.js 24. Only the tailnet reaches it: public SSH is closed, and the dashboard is served by `tailscale serve` at `https://radar-prod.tail6e77de.ts.net`.

- Timers: one systemd timer per job, with the intervals of `JOB_CONFIG`, plus the deploy, the system check, the backups and the restore test (`ops/systemd`).
- Backups: pgBackRest archives WAL continuously to Cloudflare R2 and takes a daily backup (full on Sundays), for 14 days of point-in-time recovery; a weekly job restores the latest backup into a scratch cluster and checks it.
- Monitoring: 16 Healthchecks.io checks, provisioned by `npm run provision:healthchecks`.
- Deploys: every 5 minutes, the server deploys the newest commit of `radar-v2` once its CI passed. Until the phase 4 cutover, v1 keeps running from `main` on GitHub Actions.

The runbook, with the layout, access, secrets, deploys, recovery, alerts and maintenance, is [`docs/operations.md`](docs/operations.md); the phase 1b plan with its execution notes is [`docs/plans/2026-10-21-radar-v2-phase-1b-infrastructure.md`](docs/plans/2026-10-21-radar-v2-phase-1b-infrastructure.md).
