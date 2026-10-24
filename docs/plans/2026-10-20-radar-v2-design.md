# Roblox Trend Radar v2 design

Validated with the repository owner on 2026-10-20. Updated on 2026-10-21 to match the phase 1a implementation (sections 2 and 3) and the phase 1b server (section 1). Updated on 2026-10-22 for the first dashboard (sections 3, 5A, 6 and 7). Updated on 2026-10-25 for the early v1 shutdown (sections 1 and 7).

## Why a v2

The v1 radar was built quickly on free infrastructure. It kept collecting for eight weeks, but measurements on live data on 2026-10-20 showed that it answers the wrong questions, and answers them late:

- **Late detection.** Of the 129 games first seen after 2026-09-21 that later passed 10,000 CCU, the median CCU at first sighting was 6,216 (31% of their eventual peak). Only 6 were first seen below 1,000 CCU. Discovery relies on charts, which list a game only after it is already large.
- **Partial coverage.** The Rolimon's list held 2,900 games above 100 CCU, but only 54% of them were tracked in detail, because the frontier promoted 20 candidates per run.
- **Missed peaks.** GitHub Actions ran the 15-minute cron only 4 to 8 times per day. For the owner's game "+1 Stone Skipping", the radar captured 37–58% of the real weekend peaks (for example 59k recorded against 160k real). Paid ads started on 2026-09-15, but the radar first saw the game on 2026-09-28, already at about 9–13k CCU.
- **Keyword classification.** Among new games that peaked above 5,000 CCU, 22% had no tag and 28% had four or more, because descriptions are keyword-stuffed. The concept that makes a game work, its core action (skipping stones, chopping, peeling, riding scooters, doing makeup), was not modelled at all. Trends became broad groups dominated by incumbents ("Collection" held 1,302 games).
- **Fragile measurements.** Point-to-point 72-hour comparisons on irregular samples labelled every format "declining" on weekdays. Market CCU averaged about 8M on weekdays against 12–14M on Saturdays. "New entrants" were counted from the radar's first sighting rather than from the real release. CCU was duplicated on one row per chart (about 3,700 rows per collection for about 3,000 games). Visits were stored as `real`, which loses precision on large games.
- **Unvalidated scores.** Opportunity and momentum weights were invented and never checked against outcomes. "Retention" counted keywords such as "upgrade" and "rebirth". The developer profile was frozen at "solo, limited budget, 2–4 weeks".
- **Unused outputs.** The idea generator had produced two ideas, and none was saved or rated. The Top Earning chart (monetization), the Top Revisited chart (retention) and the session-length estimate derived from visits (for example Adopt Me 28 minutes, Fisch 32, Steal a Brainrot 11) were collected or derivable, but never analysed.
- **Free-tier time bombs.** The Neon-to-Aiven move lost the data collected from 2026-08-10 to 2026-08-24. The Aiven free plan caps storage at 1 GB, and the database already used 504 MB. GitHub disables scheduled workflows after 60 days without repository activity. A health check expected a run every 20 minutes while runs actually arrived every 4–5 hours, so its alert stayed red permanently and the agent brief failed for six weeks without anyone noticing.

The owner's hit did not come from the radar. It came from a viral X clip of a 2D Steam demo (Rippleloop), transposed into a Roblox "+1" format, then executed and differentiated (secret throws, cinematics). v2 therefore focuses on the Roblox half of that recipe: which Roblox formats convert right now, what is breaking out early, and whether a concept still has room.

## Scope

In scope:

- Roblox-only data collection, classification, analysis and dashboard.
- Ad-hoc analysis sessions with an AI assistant through a read-only database role.

Out of scope for now:

- External concept sources (X, Steam, YouTube, Reddit). The owner monitors X personally and brings concepts to analysis sessions.
- Discord product alerts, weekly reports, the agent brief and the template-based idea generator.

## 1. Architecture and infrastructure

- One Hetzner Cloud CAX21 server (4 Ampere arm64 vCPU, 8 GB RAM, 80 GB disk, Ubuntu 24.04 LTS, Germany). It costs €10.99 per month excluding VAT, plus 20% for Hetzner backups, about €13.20 per month in total. The CX33 planned first was sold out in every EU location, and Ubuntu 26.04 lacks the TimescaleDB community packages: Timescale publishes only the Apache-licensed edition for it, without compression or continuous aggregates.
- PostgreSQL 18 with TimescaleDB (community edition, which includes compression, continuous aggregates and retention policies).
- The Next.js dashboard and all jobs run on the same server. Jobs are systemd services triggered by systemd timers. systemd prevents a service from overlapping with itself, which replaces the v1 lease and slot reconciliation.
- Access:
  - Public SSH is closed and only the tailnet reaches the server: ufw admits only the Tailscale interface and Tailscale's UDP port, and a Hetzner Cloud Firewall admits only inbound UDP 41641. The owner logs in as root over SSH through Tailscale, with keys only.
  - The owner reaches the dashboard through Tailscale only, with a private HTTPS address served by `tailscale serve`. The app has no public port.
  - AI analysis sessions log in as the `analysis` user over SSH, mapped to the read-only PostgreSQL role by peer authentication (no password); local tools reach the same socket through an SSH tunnel.
- Backups:
  - pgBackRest continuously archives WAL and stores encrypted base backups in an S3-compatible bucket at another provider (Cloudflare R2, with Backblaze B2 as the fallback), giving 14 days of point-in-time recovery.
  - Hetzner takes a daily server backup.
  - An automated weekly job restores the latest backup into a scratch database and checks row counts.
- Monitoring: Healthchecks.io runs two checks per job with its real period (one for every completed run, one for fully successful runs only), plus checks for the deploy timer, the system (disk usage above 70%, WAL archiving, TimescaleDB policies), backup completion and the restore test. Notifications go to email or Telegram.
- Deployment:
  - GitHub Actions keeps CI.
  - Deployment is pull-based: a timer on the server deploys, every 5 minutes, the newest commit of the deploy branch (`radar-v2` until 2026-10-25, then `main`) whose CI passed, so the server accepts no inbound connection except over Tailscale and GitHub holds no credential for it. It builds the release beside the live one, migrates (pausing the job timers only for migrations), switches the live release and restarts the dashboard. GitHub's scheduled-workflow delays and the 60-day inactivity rule do not apply.
- Reproducibility: a provisioning script (`ops/bin/provision.sh`) and an operations runbook (`docs/operations.md`) rebuild the server from scratch and restore the database from the backups.
- Local development: PGlite cannot load TimescaleDB, so local development uses a Docker container running PostgreSQL with TimescaleDB.

## 2. Data model

Principles:

- One row per game per observation.
- Chart placements are stored separately from game metrics.
- Identifiers and visits are 64-bit integers.
- The database computes the aggregates.

Time series (TimescaleDB hypertables):

| Table | Grain | Content | Compressed after | Raw retention |
| --- | --- | --- | --- | --- |
| `game_observations` | universe × 10-minute slot | CCU, visits, favorites | 7 days | 365 days |
| `census_observations` | place × 10-minute slot | Rolimon's active players for every listed game (about 7,800) | 7 days | 365 days |
| `vote_observations` | universe × hour | Cumulative up and down votes | 30 days | Permanent |
| `chart_placements` | sort × universe × hour | Rank, player count and sponsored flag in each of the 22 discovery sorts | 30 days | Permanent |

Continuous aggregates, kept permanently. They are real-time: buckets not yet materialized are computed from the raw rows.

- `game_hourly`: minimum, average and maximum CCU per hour (`ccu_min`, `ccu_avg`, `ccu_max`), so that one-hour admin-abuse peaks stay visible, plus visits as a maximum (`visits_max`), the last favorites count (`favorites_last`) and `samples`. Compressed after 30 days.
- `game_daily`: minimum, average and peak CCU (`ccu_min`, `ccu_avg`, `ccu_peak`), visits as a minimum and a maximum (`visits_min`, `visits_max`), `favorites_last` and `samples`. New visits and new favorites are derived from these.
- `census_hourly`: hourly minimum, average and maximum active players per place (`ccu_min`, `ccu_avg`, `ccu_max`) and `samples`. Compressed after 30 days.

Reference tables:

- `games`: universe metadata, with the Roblox creation timestamp kept separate from the radar's first observation.
- `places`: cached place-to-universe mapping, resolved once. A place without a universe is retried after 7 days.
- `game_versions`: history of titles, descriptions and thumbnails with observation times. Thumbnail changes are A/B tests and are worth keeping. A thumbnail version is keyed on `games.thumbnail_key`: `media:<asset id>`, or `url:<sha1>` of the image URL when Roblox gives no asset id, so a new CDN URL for the same media asset is not a change.
- `discovery_sources`: how and when each game was found (chart, search query, recommendation seed, Rolimon's), one row per game, source and detail with its first and last sighting. `explore` also records sightings of games already tracked, so the table holds relations too: a row is the game's discovery path when its `first_seen_at` equals `games.first_observed_at`.
- `discovery_candidates`: the promotion queue of the universes `explore` saw that `games` does not hold yet, keyed like `discovery_sources`. `poll` promotes the busiest in place of as many tail games, then moves their sightings into `discovery_sources`.
- `game_features`: the AI classification (section 4).
- `clusters` and `cluster_members`: groups of similar games.
- `watchlist`: games and clusters the owner follows.
- `job_runs`: outcome, duration, counters and error of every job execution.

Legacy history import:

- v1 hourly snapshots (from 2026-09-20) become `game_observations` rows with `source = 'legacy'`, deduplicated by universe and bucket, within the 365-day raw retention. Their votes go into `vote_observations`, and their chart ranks into `chart_placements` for the hours before the first v2 `charts` run. Data collected by v2 is never overwritten.
- v1 daily snapshots (2026-08-24 to 2026-09-19) go into `game_daily_legacy`, which also keeps the v1 daily votes and best rank (migration 0004).
- A view `game_daily_all` merges `game_daily_legacy` with `game_daily`; `game_daily` wins on days present in both.
- v1 discoveries come from its hourly snapshots only. Games whose first v1 snapshots were compacted (older than 30 days in v1) therefore have no discovery path.

The v1 trend, score, idea, artifact, alert and scheduler tables are dropped after cutover.

Estimated volume: about 1M rows per day in `census_observations` and about 0.5M in `game_observations` (3,000–4,000 games every 10 minutes). After compression this is a few gigabytes per year, well within the 80 GB disk.

## 3. Collection

| Job | Interval | Work |
| --- | --- | --- |
| `census` | 10 min | Downloads the full Rolimon's game list in one request and writes `census_observations`. Every place at or above 100 CCU that is not yet tracked is resolved to a universe (mapping cached) and promoted to tracking, with no per-run cap on the count. Places are resolved busiest first; those left when the 150-second resolution budget runs out wait for the next run. |
| `poll` | 10 min | Calls the Games API in batches of 50, one request every 7 seconds, with a 7.5-minute deadline that holds about 64 requests (3,200 games). The active set outgrew that (about 4,300 games on 2026-10-21, toward 5,000), so each run requests a hot set, the 2,000 highest-priority games, then a rotating tail, the 1,150 other active games whose details are the oldest, which refreshes each tail game every 20–30 minutes. Writes `game_observations` and records title and description changes in `game_versions`. It ran every 5 minutes until 2026-10-21, when the game details endpoint proved to allow only about 500 ids per minute per IP address. |
| `votes` | 1 h | Calls the votes endpoint for the active set and writes `vote_observations`. |
| `charts` | 1 h | Reads the 22 discovery sorts, writes `chart_placements` and discovers new universes. |
| `explore` | 1 h | Reads Up-and-Coming and Top Trending by country, expands the recommendations of every young game, and searches the words young titles share, two pages deep, the most shared and least recently searched first, until a 45-minute deadline (search allows one request per minute from the production IP). Search terms come from cluster vocabulary instead of a fixed taxonomy; until clusters exist (phase 2), they are the words shared by the titles of young games. Untracked games go to a promotion queue that `poll` works through within its game details budget. Widened on 2026-10-22, when four young games of 380 to 8,500 CCU were found missing: explore had reached about 55 recommendations and 2 to 4 searches per run. |
| `thumbnails` | 1 h | Records the 16:9 thumbnail and the icon of new games, and refreshes games at or above 50 CCU every 24 hours, in batches of 50 (at most 4,000 games per run), for classification and display. A new game that gets no usable answer is retried after 6 hours, behind the other games. |

A game is active when it reached 50 CCU or more in the last 24 hours, when it is at most 90 days old and had players in the last 7 days, or when it is on the watchlist. Older games that revive show up in `census` first and then re-enter `poll`.

Reliability rules:

- **Idempotency.** Every observation is keyed by its slot timestamp, so a retry within the same slot overwrites instead of duplicating.
- **No overlap.** `poll` starts no batch after a 7.5-minute deadline (its timeout is 9 minutes), after a rate limit that outlasted the retries, or after 3 failed batches in a row. The hot set is requested before the tail, so the tail games are the ones left for the next run instead of running into the next slot.
- **Quality gates.** A run is marked `degraded`, and excluded from analysis, when fewer than 95% of the requested games come back, or when the Rolimon's list has fewer than 1,000 places, more than 5% malformed entries, or a size more than 30% away from the latest list of the last 6 hours that passed this check, or the same list as one read in an earlier slot of those 6 hours (Rolimon's serving an earlier list again, which happened in 2 of the first 44 runs; such a list is not stored).
- **Rate limits.** The existing HTTP client is kept: per-host spacing, retries, `Retry-After` handling, jittered exponential backoff. Rate limiting did persist on the dedicated IP address: the game details endpoint has a hidden limit of about 500 ids per minute that its `x-ratelimit-*` headers do not show (measured on 2026-10-21), so `poll` moved to 10 minutes, and the client spaces that endpoint alone 7 seconds apart and slows it down by 1.5 times, up to 30 seconds, on each 429.

To measure in the first week:

- The CCU at which Rolimon's starts listing a new game.
- How often Rolimon's refreshes its list.
- The 429 rate on the dedicated IP address. At the end of the phase 1b observation (2026-10-22): none since poll moved to 10 minutes, and none on the other endpoints.

## 4. Classification and clusters

Each game is classified by Claude from its title, description and thumbnail. The response is structured JSON validated against a schema, with these fields:

- core action;
- object or theme;
- title template (for example `+1 {stat} per {action}`, `Steal a {thing}`, `{verb} for {reward}`, `Build a {thing}`);
- reward loop (eggs and pets, brainrots, gacha, cosmetics);
- progression type;
- social structure (solo, co-op, PvP, theft);
- setting;
- confidence.

The prompt tells the model to rely on the title and thumbnail first and to treat keyword-stuffed descriptions as noisy.

- **Living vocabulary.** The prompt contains the current known values for actions, templates and reward loops. The model reuses a value when one fits, or proposes a new one. New values are added to the vocabulary, so new waves become visible without hand-maintained keyword lists.
- **Clusters.** A game belongs to one cluster per action, per title template and per reward loop, and to useful combinations (template × reward loop, for example `{verb} for Eggs`). The section 5 metrics are computed per cluster.
- **Reclassification.** A game is classified when it first enters tracking, then again only when its normalized title or description changes materially. Promotional markers such as `[🎃]` or `UPD` are ignored. A thumbnail change alone does not trigger reclassification.
- **Overrides.** The owner can correct a classification from the dashboard, and the override always wins. Each classification records the model, prompt version and timestamp.
- **Model.**
  - Claude Opus 5.5 (`claude-opus-5-5`) is the default, called with structured outputs through the Message Batches API (50% discount; results usually arrive within an hour).
  - At launch, 200 games are classified with both Opus 5.5 and Haiku 5.5 (`claude-haiku-5-5`), and the differences are shown to the owner, who decides whether to switch.
  - Estimated cost on Opus 5.5: about $100–200 for the initial classification of about 9,000 games, then about $40–120 per month for 200–500 games per day. On Haiku 5.5: about $5, then $2–6 per month. These estimates are to be measured during the comparison.

## 5. Analysis

Every metric is a SQL view or function that shows its sample size. There is no composite score with invented weights. Each function takes an `as_of` timestamp, so any past date can be replayed and the metrics can be validated against known outcomes, starting with "+1 Stone Skipping".

**A. What is breaking out: `rising_games(as_of)`.**

`rising_games(as_of, …)` is defined in `drizzle/0007_rising_games.sql`; its parameters come from `RADAR_CONFIG` in `src/lib/config.ts`. Windows are whole UTC hours (24 by default), and every interval is counted in hours so a session time zone cannot shift them. The function sorts the games itself (`sort_by`) and returns the first `row_limit` of them: the history behind velocity, first-seen CCU and peak is read only for those rows, game by game and place by place through their indexes, so its cost follows the page size rather than the data volume (0.3–0.4 s for 30 or 90 days on 2026-10-22).

- Weekday-safe growth: the game's share against the same hour one week earlier, over the hours where both readings exist and among the games read in both. Pairing the hours cancels a game's own daily cycle on the sparse v1 hours and the v1-to-v2 change of tracked games. Games are sorted by a smoothed log score. `week_baseline` says where the baseline comes from: `tracked` (poll read the game in both); `census` (poll did not, usually because the game was discovered since, but Rolimon's listed its places in both: the census of its places against the same market totals); `new` (created since); `unlisted` (census stored a list in every hour a week earlier without the game: too few players for Rolimon's, counted from 0); or `unknown` (no score).
- Acceleration: the window's average against the window before it.
- Velocity: hours from 100 to 1,000 CCU and from 1,000 to 10,000 CCU, from one hourly reading per game (poll, or the census of its places). A crossing is measured only when the reading before it is at most `velocityMaximumGapHours` older.
- Event flag: a peak at least 3 times the median hourly CCU of the same window that the game came back down from (its last hour is under 3 times the median), with at least 12 hourly samples, such as an admin abuse, is labelled as an event rather than organic growth. A seven-day median would flag every hour of a fast organic rise, and without the last-hour condition a breakout late in the window would look like an event.
- Every metric returns its sample size. Game metadata (name, icon) is today's, not `as_of`'s.

**B. Why it works: the game view.**

- AI classification and cluster memberships.
- Estimated session length (average CCU × minutes / new visits).
- Like ratio and favorites per 1,000 new visits.
- Monetization: Top Earning rank relative to Top Playing Now rank.
- Retention: presence in Top Revisited.

**C. Is there room left: `cluster_stats(as_of)`, over a rolling 30 days.**

- Entrants per week.
- Hit rate: share of new games that reach 1k, 10k or 50k CCU within 14 days.
- Median peak of followers (entrants 2 to 10, in order of first appearance).
- Wave age: days since the first hit above 10,000 CCU.
- Leader share of the cluster's CCU.
- Weekday-normalized cluster share trend over four weeks.
- Hit half-life: days from the daily peak to 50% of it.
- Cluster medians for monetization and engagement.

**D. Concept check: `concept_search(text)`.** A fuzzy search (pg_trgm) over titles and classification fields, used in sessions to test a concept the owner found outside Roblox. Live Roblox search complements it.

Continuous aggregates refresh automatically. Cluster statistics are materialized and refreshed hourly. `rising_games` is computed on demand from the hourly aggregates.

## 6. Dashboard

Next.js server components read the section 5 views directly. The existing chart components are kept and extended. Every page works on a phone over Tailscale.

1. **Radar** (home): rising games, showing thumbnail, title, real age, current and peak CCU, weekday-safe growth, velocity, clusters and an event badge. Filters: age (14, 30 or 90 days), minimum CCU, cluster and watchlist.
2. **Clusters**: a sortable table of the section 5C metrics with a four-week share sparkline, filterable by cluster type. A cluster page lists its members in order of entry, with how each one performed.
3. **Game**:
   - 10-minute curve for 14 days, then hourly and daily curves;
   - annotations for title and thumbnail changes and chart entries;
   - an editable classification card;
   - engagement and monetization signals;
   - similar games.
4. **Watchlist**: starred games and clusters.
5. **Health**:
   - status and freshness of each job;
   - coverage of Rolimon's games above 100 CCU;
   - Roblox rate-limit errors;
   - disk usage, last backup and last restore test.

A global date selector recomputes every page as of a past date.

**First version (2026-10-22).** The first pages ship before classification:

- the Radar, without the cluster column, the cluster filter or the watchlist filter;
- the Game page, with the curves, a timeline, and the engagement, monetization and retention signals, without the classification card or similar games. The timeline lists title, description and thumbnail changes and chart entries instead of annotating the charts;
- the Health page, without backup and restore-test status, which report to Healthchecks only.

An `asOf` field on the Radar page replaces the global date selector for backtests.

The Ideas, Trends and Settings pages are removed.

## 7. Testing, migration and delivery

**Testing.**

- **Unit tests** (Vitest): API parsers, title fingerprints, poll prioritization, quality gates and classification schema validation.
- **SQL tests:** CI starts a disposable PostgreSQL + TimescaleDB container and checks every view and function against fixture time series. Fixtures live only in that test database and never reach the application database.
- **Backtest:** the `as_of` functions are replayed on real history.

**Success criteria**, tracked on the Health page:

| Criterion | v1 (2026-10-20) | v2 target |
| --- | ---: | ---: |
| Median CCU at first detection of games that later pass 10k | 6,216 | ≤ 1,000 |
| Share of Rolimon's games above 100 CCU that are tracked | 54% | ≥ 95% |
| Captured peak relative to real peak (checked against the owner's game) | 37–58% | ≥ 90% |
| Silent failures | 6 weeks | 0 |
| Correct classifications on a reviewed sample of 100 games | n/a | ≥ 90% |

**Error handling.**

- Every job has a timeout, pings Healthchecks on start, success and failure, and writes `job_runs`.
- A Rolimon's outage degrades `census` while `poll` continues on tracked games.
- A Claude API failure leaves games "unclassified" and retries on the next run.
- Roblox 429 responses trigger backoff and priority shedding.

**Delivery phases.** Each phase is usable on its own. The v1 collector was meant to keep running on Aiven until cutover. On 2026-10-25 its database ran out of disk space and went read-only, so that part of phase 4 came first: the GitHub scheduled workflow was disabled, `radar-v2` was fast-forwarded into `main`, and `main` became the deploy branch.

1. **Data:** server provisioning, monitoring, backups, v2 schema, legacy import, and the `census`, `poll`, `votes`, `charts`, `explore` and `thumbnails` collectors. New data accumulates from this point.
2. **Classification:** Opus 5.5 against Haiku 5.5 on 200 games (the owner chooses the model), initial classification, clusters.
3. **Analysis:** SQL views and functions, then backtest validation.
4. **Dashboard and cutover:** the remaining pages and the full versions of the first ones (which ship between phases 1 and 2, see section 6), then removal of v1 code (ideas, trends, agent brief, Discord reports, scheduler leases).
   - A final incremental import from Aiven closes any gap.
   - The GitHub scheduled workflow is disabled.
   - Aiven stays read-only for 14 days, then is deleted.

`AGENTS.md` and the README are updated to the v2 commands and local setup.

**Owner prerequisites before phase 1:**

- a Hetzner Cloud server;
- a Tailscale account;
- an R2 or B2 bucket;
- a Healthchecks.io account;
- an Anthropic API key.
