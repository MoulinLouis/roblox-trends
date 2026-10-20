# Roblox Trend Radar v2 design

Validated with the repository owner on 2026-10-20.

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

- One Hetzner Cloud CX33 server (4 vCPU, 8 GB RAM, 80 GB NVMe, Ubuntu 24.04 LTS, EU location). The server costs €8.99 per month excluding VAT, plus 20% for Hetzner backups, about €11 per month in total.
- PostgreSQL 18 with TimescaleDB (community edition, which includes compression, continuous aggregates and retention policies).
- The Next.js dashboard and all jobs run on the same server. Jobs are systemd services triggered by systemd timers. systemd prevents a service from overlapping with itself, which replaces the v1 lease and slot reconciliation.
- Access:
  - The owner reaches the dashboard through Tailscale only, with a private HTTPS address served by `tailscale serve`. The app has no public port.
  - AI analysis sessions connect over an SSH tunnel with a read-only PostgreSQL role.
- Backups:
  - pgBackRest continuously archives WAL and stores base backups in an S3-compatible bucket at another provider (Cloudflare R2 or Backblaze B2), giving 14 days of point-in-time recovery.
  - Hetzner takes a daily server backup.
  - An automated weekly job restores the latest backup into a scratch database and checks row counts.
- Monitoring: Healthchecks.io runs one check per job with its real period, plus checks for disk usage above 70%, backup completion and the restore test. Notifications go to email or Telegram.
- Deployment:
  - GitHub Actions keeps CI.
  - After CI passes on `main`, a deploy job connects over SSH, pulls, builds, migrates and restarts. Deploys are event-triggered, so GitHub's scheduled-workflow delays and the 60-day inactivity rule no longer apply.
- Reproducibility: a provisioning script and an operations runbook in the repository rebuild the server from scratch in about 30 minutes.
- Local development: PGlite cannot load TimescaleDB, so local development uses a Docker container running PostgreSQL with TimescaleDB.

## 2. Data model

Principles:

- One row per game per observation.
- Chart placements are stored separately from game metrics.
- Identifiers and visits are 64-bit integers.
- The database computes the aggregates.

Time series (TimescaleDB hypertables, compressed after 7 days):

| Table | Grain | Content | Raw retention |
| --- | --- | --- | --- |
| `game_observations` | universe × 5-minute slot | CCU, visits, favorites; up and down votes once per hour | 90 days |
| `census_observations` | place × 10-minute slot | Rolimon's active players for every listed game (about 7,800) | 90 days |
| `chart_placements` | sort × universe × hour | Rank in each of the 22 discovery sorts | Permanent |

Continuous aggregates, kept permanently:

- `game_hourly`: minimum, average and maximum CCU per hour, so that one-hour admin-abuse peaks stay visible.
- `game_daily`: average and peak CCU, new visits, new favorites.
- `census_hourly`: hourly maximum and average active players per place.

Reference tables:

- `games`: universe metadata, with the Roblox creation timestamp kept separate from the radar's first observation.
- `places`: cached place-to-universe mapping, resolved once.
- `game_versions`: history of titles, descriptions and thumbnails with observation times. Thumbnail changes are A/B tests and are worth keeping.
- `discovery_sources`: how and when each game was found (chart, search query, recommendation seed, Rolimon's).
- `game_features`: the AI classification (section 4).
- `clusters` and `cluster_members`: groups of similar games.
- `watchlist`: games and clusters the owner follows.
- `job_runs`: outcome, duration, counters and error of every job execution.

Legacy history import:

- v1 hourly snapshots (from 2026-09-20) become `game_observations` rows with `source = 'legacy'`, deduplicated by universe and bucket.
- v1 daily snapshots (2026-08-24 to 2026-09-19) go into `game_daily_legacy`.
- A view `game_daily_all` merges `game_daily_legacy` with `game_daily`.

The v1 trend, score, idea, artifact, alert and scheduler tables are dropped after cutover.

Estimated volume: about 1M rows per day in each of `game_observations` and `census_observations`. After compression this is a few gigabytes per year, well within the 80 GB disk.

## 3. Collection

| Job | Interval | Work |
| --- | --- | --- |
| `census` | 10 min | Downloads the full Rolimon's game list in one request and writes `census_observations`. Every place at or above 100 CCU that is not yet tracked is resolved to a universe (mapping cached) and promoted to tracking, with no per-run cap. |
| `poll` | 5 min | Calls the Games API in batches of 50 for every active game (about 3,000–4,000 games, 60–80 requests, about 40 seconds). Writes `game_observations` and records title and description changes in `game_versions`. |
| `votes` | 1 h | Calls the votes endpoint for the active set. |
| `charts` | 1 h | Reads the 22 discovery sorts, writes `chart_placements` and discovers new universes. |
| `explore` | 1 h | Runs bounded Roblox searches and recommendation expansion from rising games. Search terms come from cluster vocabulary instead of a fixed taxonomy. |
| `thumbnails` | On new or changed games | Downloads thumbnails for classification and display. |

A game is active when it reached 50 CCU or more in the last 24 hours, when it is at most 90 days old and shows activity, or when it is on the watchlist. Older games that revive show up in `census` first and then re-enter `poll`.

Reliability rules:

- **Idempotency.** Every observation is keyed by its slot timestamp, so a retry within the same slot overwrites instead of duplicating.
- **No overlap.** If `poll` cannot finish within its interval because of rate limits, it drops the lowest-CCU games first instead of running into the next slot.
- **Quality gates.** A run is marked `degraded`, and excluded from analysis, when fewer than 95% of the requested games come back, or when the Rolimon's list size changes by more than 30% from one run to the next.
- **Rate limits.** The existing HTTP client is kept: per-host spacing, retries, `Retry-After` handling, jittered exponential backoff. If rate limiting persists on the dedicated IP address, `poll` moves to 10 minutes.

To measure in the first week:

- The CCU at which Rolimon's starts listing a new game.
- How often Rolimon's refreshes its list.
- The 429 rate on the dedicated IP address.

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

- Weekday-safe growth: the game's share of total tracked CCU, compared with the same hour one week earlier.
- Velocity: hours from 100 to 1,000 CCU and from 1,000 to 10,000 CCU.
- Acceleration: the trailing 24-hour average against the previous 24 hours.
- Event flag: an hourly peak far above the game's 7-day hourly median, such as an admin abuse, is labelled as an event rather than organic growth.

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
   - 5-minute curve for 14 days, then hourly and daily curves;
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

**Delivery phases.** Each phase is usable on its own. The v1 collector keeps running on Aiven until cutover.

1. **Data:** server provisioning, monitoring, backups, v2 schema, legacy import, and the `census`, `poll`, `votes`, `charts`, `explore` and `thumbnails` collectors. New data accumulates from this point.
2. **Classification:** Opus 5.5 against Haiku 5.5 on 200 games (the owner chooses the model), initial classification, clusters.
3. **Analysis:** SQL views and functions, then backtest validation.
4. **Dashboard and cutover:** the new pages, then removal of v1 code (ideas, trends, agent brief, Discord reports, scheduler leases).
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
