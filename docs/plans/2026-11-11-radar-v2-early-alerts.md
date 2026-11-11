# Early breakout alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly `alerts` job pushes a Discord card when a pattern's second or third young game crosses 1,000 CCU, and sends a daily digest of the young games that are the first breakout of their pattern. A backtest over the radar's history tunes and proves the filter before Discord is wired.

**Architecture:**
- **Pure core** in `src/lib/alerts/`: pattern keys (`keys.ts`), the decision (`decide.ts`), Discord messages (`discord.ts`) and the backtest replay (`backtest.ts`).
- **Persistence** in `src/db/alerts.ts`:
  - breakouts are read from the hourly aggregates, with daily peaks where only v1 data exists;
  - the games' formats come from `game_formats` and `game_classifications`;
  - every alert is stored in a new `alerts` table.
- **The job** (`src/lib/jobs/alerts.ts`) reads, decides, records, then sends. The backtest command (`scripts/alerts-backtest.ts`) replays the same decision over history through the read-only tunnel and writes nothing.

**Tech Stack:** TypeScript, Vitest, drizzle-orm and drizzle-kit, PostgreSQL 18 with TimescaleDB, systemd, Discord webhooks (`fetch`), Healthchecks.io.

**Spec:** `docs/plans/2026-11-11-radar-v2-early-alerts-design.md` (approved by the owner on 2026-11-11).

**Out of scope:** the watch of sources outside Roblox (project 2), a dashboard page, discovery below 1,000 CCU.

## Global Constraints

- **Language and layout.** Code, identifiers, comments, tests, docs, logs and the Discord text are in English (`AGENTS.md`).
  - Domain logic goes in `src/lib`, persistence in `src/db`, entry points in `scripts`, units in `ops`.
  - Every threshold lives in `ALERT_CONFIG` or `JOB_CONFIG.alerts` in `src/lib/config.ts`.
- **No verdict.** A card shows facts with their sample sizes, never a score or a "go" (design, section 3).
- **No Roblox request.** Neither the job nor the backtest calls Roblox. The production IP's search allowance belongs to explore.
- **The webhook URL is a secret.** It is read only from `DISCORD_WEBHOOK_URL` in the job's environment, loaded from `/etc/radar/discord.env` by an optional drop-in. It never appears in the repository, a log, an error message, `job_runs.stats` or an alert row.
- **No double alert.** A game gets at most one alert per kind, and a pattern key at most one wave push within the cooldown.
  - Alerts are recorded before they are sent. A failed send leaves `sent_at` null, and a later run retries it.
- **The timer is never enabled by a deploy.** `ops/bin/deploy.sh` starts only enabled timers; the owner enables `radar-alerts.timer` after the backtest and the webhook (S1–S4).
- **Database suites (`*.db.test.ts`) run only in CI.** Push the branch to a pull request to see them.
- **Before handing off,** run `npm run lint`, `npm run typecheck`, `npm run test` and `npm run build`.
- **Production changes only through the repository and the runbook.** A push to `main` deploys, and needs the owner's approval.
- **Any new SQL over `game_hourly`, `census_hourly` or `game_daily_all` is timed on production** before merge, read-only through the tunnel. CI's small fixtures hid a 5-minute plan in `format_stats` (`drizzle/0018_format_stats_plan.sql`).

## Review Focus

- **A game discovered above 1,000 CCU.** It is dated by its first reading at or above 1,000, and still alerts if it is under 30 days old then (Task 3).
- **Two runs in the same hour, or a run after a crash between record and send.** No duplicate alert; unsent alerts are sent once (Tasks 3 and 5).
- **The digest around midnight and daylight saving in Europe/Paris.** It goes out once per local day, on the first run at or after 08:00 Paris time (Task 5).
- **A Discord failure** (429, 5xx, timeout, bad URL). The run is degraded, the URL appears in no message, and nothing is lost (Tasks 4 and 5).
- **A breakout crossing 1,000 CCU before an older game of its pattern.** Order is by crossing hour, not by creation date (Task 2).

## Decisions taken in this plan (open to the owner's correction)

- **Word keys** come from `titleWords` (`src/lib/title.ts`), which already drops stop words, Roblox words (obby, simulator, tycoon, update, new) and bare numbers. A word is a key only when 2 to 1% of tracked titles carry it (`minimumWordGames`, `maximumWordShare`): a one-off name cannot open a pattern, and a very common word cannot block one.
- **Action keys** join the merged `family` with `mergeKey(core_action)`. **Template keys** use `mergeKey(template)` and skip `none`.
- **First breakout:** at least one key of the candidate has no prior breakout in the lookback (the design's rule). If the backtest shows more than about 10 a day, S0 tightens `minimumWordGames`, `maximumWordShare` or `lookbackDays` before anything else.
- **Wave:** the candidate is the 2nd or 3rd breakout of a key, within 14 days of that key's first one. A key is pushed again only after a 30-day cooldown.
- **Candidates** are breakouts of the last 48 hours not yet alerted. An unclassified one waits up to 12 hours, then is judged on its word keys only.
- **Like ratio** on the card comes from the game's latest `vote_observations` row.
- **Start values** (`ALERT_CONFIG`), set before S0's backtest: lookback 60 days, candidate window 48 hours, unclassified wait 12 hours, wave ranks 2–3, wave window 14 days, cooldown 30 days, word games 2 to 1% of titles, digest at 08:00 Europe/Paris, at most 10 games per digest (Discord's limit of 10 embeds per message).

---

### Task 1: Configuration and pattern keys

**Files:**
- Modify: `src/lib/config.ts`
- Create: `src/lib/alerts/types.ts`, `src/lib/alerts/keys.ts`
- Test: `src/lib/alerts/keys.test.ts`

**Interfaces:**
- Produces:
  - `ALERT_CONFIG` and `JOB_CONFIG.alerts = { intervalMinutes: 60, timeoutMs: 10 * 60_000 }`;
  - `type AlertKind = "first_breakout" | "wave"`;
  - `interface GameFormat { name: string; family: string | null; template: string | null; coreAction: string | null }`;
  - `wordFrequencies(titles: Iterable<string>): Map<string, number>`, the number of titles carrying each folded word of `titleWords`;
  - `patternKeys(game: GameFormat, frequencies: Map<string, number>, totalTitles: number, options?: { wordsOnly?: boolean }, config = ALERT_CONFIG): string[]`, which returns sorted, unique `word:<w>`, `action:<family>|<mergeKey(coreAction)>` and `template:<mergeKey(template)>` keys.

- [ ] **Step 1: Add the configuration** after `FORMAT_CONFIG`, with a comment per value saying why, quoting the design's measurements where they set it:

```ts
// Early breakout alerts (docs/plans/2026-11-11-radar-v2-early-alerts-design.md). Measured on 2026-11-11: a median of
// about 4 days from 1,000 to 10,000 CCU, and 270–350 games under 30 days old crossing 1,000 CCU a week.
export const ALERT_CONFIG = {
  crossingCcu: 1_000,
  maximumAgeDays: 30,
  lookbackDays: 60,
  candidateWindowHours: 48,
  unclassifiedWaitHours: 12,
  waveRanks: [2, 3],
  waveWindowDays: 14,
  waveCooldownDays: 30,
  minimumWordGames: 2,
  maximumWordShare: 0.01,
  digestHour: 8,
  digestTimeZone: "Europe/Paris",
  digestMaximumGames: 10,
} as const;
```

and `alerts: { intervalMinutes: 60, timeoutMs: 10 * 60_000 }` in `JOB_CONFIG`.

- [ ] **Step 2: Write the failing tests** in `keys.test.ts`:
  - `"Ragdoll Physics 🩸"` with frequencies `{ ragdoll: 115, physic: 42 }` out of 16,000 titles gives `word:physic` and `word:ragdoll`. Assert against what `titleWords` actually folds; this test pins it.
  - A word carried by 1 title is dropped, and so is a word carried by more than 1% of titles (161 of 16,000).
  - The family `physics sandbox` with the core action `" Test  Ragdoll Physics"` gives `action:physics sandbox|test ragdoll physics`.
  - The template `{thing} Battles` gives `template:{thing} battles`; `none` and null give no template key.
  - `wordsOnly: true` gives only `word:` keys.
  - A game with no classification (null family) gives only word keys.
  - `wordFrequencies(["Ragdoll Soccer", "RAGDOLL physics", "Steal a Brainrot"])` counts `ragdoll` 2 and `soccer` 1, once per title.

- [ ] **Step 3: Run** `npx vitest run src/lib/alerts/keys.test.ts`. Expect FAIL.

- [ ] **Step 4: Implement `types.ts` and `keys.ts`.** Reuse `titleWords` and `mergeKey` (`src/lib/classify/merges.ts`); add no stop-word list of your own.

- [ ] **Step 5: Run** the test file. Expect PASS. Then `npm run typecheck`.

- [ ] **Step 6: Commit** `feat(alerts): name a game's patterns by title words, gameplay and template`.

### Task 2: The decision

**Files:**
- Create: `src/lib/alerts/decide.ts`
- Test: `src/lib/alerts/decide.test.ts`

**Interfaces:**
- Consumes: `AlertKind`, `ALERT_CONFIG` (Task 1).
- Produces, in `types.ts`:
  - `interface Breakout { universeId: number; createdAt: Date; crossedAt: Date; keys: string[]; classified: boolean }`;
  - `interface PastAlert { kind: AlertKind; universeId: number; keys: string[]; createdAt: Date }`;
  - `interface AlertDecision { kind: AlertKind; universeId: number; keys: string[]; priors: Record<string, number[]> }`, where `priors` lists, for each key, the universe ids of its earlier breakouts in crossing order.
- Produces, in `decide.ts`: `decideAlerts(input: { breakouts: Breakout[]; pastAlerts: PastAlert[]; now: Date }, config = ALERT_CONFIG): AlertDecision[]`.

**The rule, in order, per candidate:**
- A candidate is a breakout with `crossedAt` in `(now − candidateWindowHours, now]`.
  - An unclassified candidate is skipped while `now − crossedAt < unclassifiedWaitHours`.
  - After that wait, its non-word keys are ignored.
- A key's prior breakouts are the breakouts carrying it with `crossedAt` before the candidate's and within `lookbackDays` before it. Order is by `crossedAt`, then `universeId`.
- **`first_breakout`:** the keys with no prior breakout. The decision is made when that list is non-empty and no past `first_breakout` alert exists for the game.
- **`wave`:** the keys where the candidate's rank (priors + 1) is in `waveRanks`. The key's first breakout must be at most `waveWindowDays` before the candidate. No past `wave` alert may carry the key within `waveCooldownDays` before `now`. The decision is made when that list is non-empty and no past `wave` alert exists for the game.
- A candidate may yield both kinds. The output is sorted by `crossedAt`, then kind (`wave` first).

- [ ] **Step 1: Write the failing tests**, each on a handful of breakouts built by a local helper:
  - A first breakout of `word:ragdoll` gives one `first_breakout` decision with `keys` `["word:ragdoll"]`.
  - The 2nd and 3rd breakouts of the key within 14 days give `wave` decisions; the 4th gives none.
  - A 2nd breakout 15 days after the first gives no wave.
  - A key pushed 10 days ago gives no new wave on it. A push 31 days ago does not block.
  - A prior breakout 61 days before the candidate is outside the lookback, so the candidate is a first breakout.
  - Order by crossing: game B, created before game A but crossing 1,000 CCU after it, is the 2nd breakout and A the first.
  - A past `first_breakout` alert for the game blocks a second one, and a past `wave` blocks a second wave.
  - An unclassified candidate 3 hours after its crossing gives nothing. At 13 hours, its `action:` and `template:` keys are ignored.
  - A breakout that crossed 49 hours before `now` is not a candidate.
  - `priors` lists the earlier breakouts' universe ids per key.

- [ ] **Step 2: Run** `npx vitest run src/lib/alerts/decide.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement `decideAlerts`.** It is pure, and depends only on its input and config.

- [ ] **Step 4: Run** the test file. Expect PASS.

- [ ] **Step 5: Commit** `feat(alerts): decide first breakouts and forming waves`.

### Task 3: The alerts table and the reads

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0019_alerts.sql` (generated with `npm run db:generate -- --name=alerts`), `src/db/alerts.ts`
- Test: `src/db/alerts.db.test.ts`

**Interfaces:**
- Consumes: `Breakout`, `PastAlert`, `AlertKind`, `GameFormat` (Tasks 1–2).
- Produces:
  - table `alerts (id uuid pk, kind text, universe_id bigint references games on delete cascade, keys text[] not null, evidence jsonb not null, created_at timestamptz not null, sent_at timestamptz)`, with a unique index on `(kind, universe_id)` and an index on `created_at`;
  - `readBreakouts(db, query: { createdSince: Date; until: Date }, config = ALERT_CONFIG): Promise<Array<Omit<Breakout, "keys" | "classified">>>`;
  - `readGameFormats(db, universeIds: number[]): Promise<Map<number, GameFormat & { classified: boolean }>>`;
  - `readTrackedGames(db): Promise<Array<{ universeId: number; name: string }>>`, every tracked game. Its names feed `wordFrequencies`; with `readGameFormats` on all of them, a run computes every game's keys once, to count the tracked games per key on the cards;
  - `readCardFacts(db, universeIds: number[], crossedAt: Map<number, Date>): Promise<Map<number, CardFacts>>`. `CardFacts` holds the name, `rootPlaceId`, `thumbnailUrl`, `robloxCreatedAt`, `lastCcu`, `ccuDayBefore` (the game's hourly CCU 24 hours before its crossing, or null), `likeRatio` (latest votes, or null), `family`, `template`, `rewardLoop`, `coreAction` and `peakCcu`. Declare the type in `src/lib/alerts/types.ts`;
  - `readPastAlerts(db, since: Date): Promise<PastAlert[]>`;
  - `recordAlerts(db, alerts: Array<{ decision: AlertDecision; evidence: unknown; createdAt: Date }>): Promise<number>`, an insert that skips an existing `(kind, universe_id)`;
  - `readUnsentAlerts(db): Promise<StoredAlert[]>` and `markAlertsSent(db, ids: string[], sentAt: Date): Promise<void>`. Declare `StoredAlert` (`id`, `kind`, `universeId`, `keys`, `evidence`, `createdAt`, `sentAt`) in `types.ts`.

**`readBreakouts`:**
- It looks at games created at or after `createdSince`.
- `crossedAt` is the first hour, before `until`, at which the game read `crossingCcu` or more: in `game_hourly.ccu_max`, or in `census_hourly.ccu_max` of one of its places (`places`).
- When there is no such hour, it falls back to the first `game_daily_all` day with `ccu_peak` at or above the threshold (v1 history, day resolution).
- A game counts only when that moment is at most `maximumAgeDays` after its `roblox_created_at`.
- It is one query, in the style of `src/db/radar.ts`.

- [ ] **Step 1: Write the failing database tests.** Seed observations, refresh the aggregates as `src/db/radar.db.test.ts` does, and seed `game_daily_legacy` for the fallback.
  - A game read at 400, then 1,200 CCU an hour later gives that hour as `crossedAt`.
  - A game first read at 5,000 CCU gives that first reading.
  - A game reaching 1,000 CCU only in `census_hourly`, through `places`, is found.
  - A game crossing on day 31 after its creation is not a breakout.
  - A game with only legacy daily rows gives the first day at or above 1,000.
  - `recordAlerts` twice with the same decision inserts one row.
  - `readUnsentAlerts` and `markAlertsSent` round-trip.
  - `readTrackedGames` returns every game's id and name.
  - `readPastAlerts` returns kinds, keys and dates.
  - `readGameFormats` reports a game without classification as `classified: false` with null fields.

- [ ] **Step 2: Add the table** to `schema.ts` and generate the migration. Expect `drizzle/0019_alerts.sql` with one `CREATE TABLE`, its indexes and the foreign key.

- [ ] **Step 3: Implement `src/db/alerts.ts`.**

- [ ] **Step 4: Time `readBreakouts` on production.** Run its SQL read-only through the tunnel, with `createdSince` at 90 days before now: `EXPLAIN (ANALYZE, SUMMARY ON, TIMING OFF)`, as in `docs/plans/2026-11-11-radar-v2-format-stats.md`, S1. Expect a few seconds, well under the job's 10-minute timeout. Record the time in the execution notes.

- [ ] **Step 5: Typecheck, lint, push, wait for CI.** Commit `feat(db): store alerts and read young games' 1,000 CCU crossings`.

### Task 4: Discord messages

**Files:**
- Create: `src/lib/alerts/discord.ts`
- Test: `src/lib/alerts/discord.test.ts`

**Interfaces:**
- Consumes: `AlertDecision`, `CardFacts` (Tasks 2–3).
- Produces:
  - `alertEvidence(decision: AlertDecision, facts: Map<number, CardFacts>, keyGames: Record<string, number>): AlertEvidence`, the JSON stored in `alerts.evidence` and rendered by the cards. It holds the candidate's facts, each key with its prior breakouts (name, crossing date, peak) and the number of tracked games carrying it, and the local concept-check command built from the key words;
  - `waveMessage(evidence: AlertEvidence): DiscordMessage` (one embed);
  - `digestMessage(evidences: AlertEvidence[], config = ALERT_CONFIG): DiscordMessage`, one embed per game, at most `digestMaximumGames`, most CCU first, with a content line "and N more" when it truncates;
  - `postDiscord(webhookUrl: string, message: DiscordMessage, fetchImpl: typeof fetch = fetch): Promise<void>`. It throws `DiscordError` with a message free of the URL on a non-2xx answer, a network error or a timeout (10 s, `AbortSignal.timeout`).

- [ ] **Step 1: Write the failing tests:**
  - A wave embed has:
    - the title linked to `https://www.roblox.com/games/<rootPlaceId>` and the thumbnail URL;
    - a field with the CCU now, the crossing hour (UTC) and the CCU 24 hours earlier;
    - a field with the format;
    - one field per key with its prior breakouts;
    - the concept-check command.
  - Its text holds no word such as "go", "opportunity" or "score". Assert against a small list.
  - A digest of 12 evidences gives 10 embeds, sorted by CCU, and "and 2 more".
  - `postDiscord` sends JSON with `Content-Type: application/json` to the given URL, using a stubbed `fetch`.
  - On a 429 or a rejected `fetch`, it throws an error whose message holds neither the URL nor its token.

- [ ] **Step 2: Run** `npx vitest run src/lib/alerts/discord.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement.** Follow Discord's webhook body: `content`, and `embeds` with `title`, `url`, `description`, `thumbnail.url`, `fields[{ name, value, inline }]` and `timestamp`. Keep field values under 1,024 characters.

- [ ] **Step 4: Run** the test file. Expect PASS. Then commit `feat(alerts): write wave and digest messages for Discord`.

### Task 5: The `alerts` job and its operations

**Files:**
- Create: `src/lib/jobs/alerts.ts`, `ops/systemd/radar-alerts.timer`, `ops/systemd/radar-job@alerts.service.d/timeout.conf`, `ops/systemd/radar-job@alerts.service.d/discord.conf`
- Modify: `src/lib/jobs/types.ts` (`"alerts"` in `JOB_NAMES`), `src/lib/jobs/registry.ts`, `scripts/collect.ts` (`LEFT_OUT`), `src/lib/status-report.ts`, `ops/bin/deploy.sh` (`job_timers`), `.env.example`
- Test: `src/lib/jobs/alerts.db.test.ts`; the existing `src/lib/ops/systemd.test.ts` and `healthchecks-provisioning.test.ts` cover the new job through `JOB_NAMES`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `createAlertsJob(dependencies: { webhookUrl: () => string | undefined; post?: typeof postDiscord }): JobDefinition`.

**A run:**
1. Read the tracked games and their formats, count word frequencies, and compute every game's keys. The count of games per key is the cards' `keyGames`.
2. Read the breakouts created since `now − (lookbackDays + maximumAgeDays)`, until `now`, with their keys, and the past alerts of the lookback.
3. Call `decideAlerts`.
4. Build the evidence with `readCardFacts` and record the alerts.
5. If a webhook URL is set:
   - post each unsent `wave` alert on its own;
   - once per local day in `digestTimeZone`, on the first run at or after `digestHour`, post the unsent `first_breakout` alerts in one digest and mark them sent. "Already sent today" means a `first_breakout` alert has a `sent_at` in the current local day after `digestHour`.
6. Stats: `candidates`, `firstBreakouts`, `waves`, `sent` and `unsent`. The run is `degraded` when alerts are left unsent because the webhook is missing or a post failed.

- [ ] **Step 1: Write the failing job tests**, with a recording `post` stub and fixed clocks:
  - A forming wave is recorded and posted in the same run, and a second run posts nothing.
  - A first breakout found at 06:30 Paris time is recorded and not posted.
  - The run at 08:56 Paris time posts the digest, and the 09:56 run does not.
  - The same at a winter and a summer date, and on a run at 23:56 followed by one at 00:56 Paris time.
  - Without a webhook URL, alerts are recorded, nothing is posted, and the run is `degraded`. A later run with the URL posts them.
  - A `post` that throws leaves the alert unsent and degrades the run. The next run sends it.
  - The stats hold no URL.

- [ ] **Step 2: Implement the job.** Register it in `createJobs()` with `webhookUrl: () => process.env.DISCORD_WEBHOOK_URL`. Add `"alerts"` to `JOB_NAMES` and to `LEFT_OUT` in `scripts/collect.ts`: it sends notifications and reads only what the collectors wrote. Add the stats to the status report.

- [ ] **Step 3: Add the units.**
  - `radar-alerts.timer`: `OnCalendar=*:56:30`, `AccuracySec=1s`, `Persistent=false`, `Unit=radar-job@alerts.service`, written like `radar-classify.timer`.
  - `timeout.conf`: `TimeoutStartSec=630`.
  - `discord.conf`: `EnvironmentFile=-/etc/radar/discord.env`, with a comment pointing to the runbook's secrets section.
  - Add `radar-alerts.timer` to `job_timers` in `deploy.sh`.
  - Add `DISCORD_WEBHOOK_URL=` to `.env.example`, with a comment: production only, in `/etc/radar/discord.env`, never in `.env.local`.

- [ ] **Step 4: Run** `npm run lint && npm run typecheck && npx vitest run src/lib`. Expect PASS: `systemd.test.ts` checks the new timer's minute, slot and timeout, and the provisioning test expects 20 checks. Push and wait for CI.

- [ ] **Step 5: Commit** `feat(jobs): send early breakout alerts to Discord every hour`.

### Task 6: The backtest command

**Files:**
- Create: `src/lib/alerts/backtest.ts`, `scripts/alerts-backtest.ts`
- Modify: `package.json` (`"alerts:backtest": "tsx scripts/alerts-backtest.ts"`)
- Test: `src/lib/alerts/backtest.test.ts`

**Interfaces:**
- Consumes: `decideAlerts`, `patternKeys`, `wordFrequencies` and the reads of Task 3.
- Produces: `replayAlerts(input: { breakouts: Breakout[]; from: Date; to: Date }, config = ALERT_CONFIG): ReplayResult`, with `ReplayResult = { pushes: AlertDecision[] with their dates; digests: Array<{ day: string; decisions: AlertDecision[] }>; weekly: Array<{ week: string; pushes: number; firstBreakouts: number }> }`.

**The replay** steps hour by hour from `from` to `to`. At each hour `t` it calls `decideAlerts` with the breakouts that crossed by `t` and the alerts it has produced so far. It groups `first_breakout` decisions by the local day of the digest that would send them. Every breakout is treated as classified: it uses today's classifications, as the design says.

**The command:**
```bash
DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npm run alerts:backtest -- --from 2026-08-25 --to 2026-11-11 [--words-only]
```
- It reads the history read-only and computes the keys (`--words-only` passes `wordsOnly`).
- It prints the weekly counts, every push (date, game, keys, prior games), each day's digest count with its top 3, and the first push dates of `word:ragdoll` and `template:{verb} for {reward}`.

- [ ] **Step 1: Write the failing tests** on synthetic breakouts:
  - three breakouts of one key on days 1, 3 and 5 give one first breakout on day 1 and pushes on days 3 and 5;
  - a first breakout at 09:00 Paris time on day 1 lands in day 2's digest;
  - the weekly counts add up.

- [ ] **Step 2: Implement `replayAlerts` and the command.** The command builds the keys with today's titles and classifications.

- [ ] **Step 3: Run** `npx vitest run src/lib/alerts`, `npm run typecheck`. Expect PASS.

- [ ] **Step 4: Commit** `feat(alerts): replay the alert decision over the radar's history`.

### Task 7: The runbook

**Files:**
- Modify: `docs/operations.md`, `README.md`

- [ ] **Step 1: Runbook.**
  - Section 1: the job, the timer `*:56:30`, the two checks (20 of 20).
  - Section 3: `/etc/radar/discord.env` in the secrets table, `root 600`, written by the owner, loaded only by the alerts unit's optional drop-in.
  - Section 4: a short "Alerts" section:
    - what a run does and when the digest goes out;
    - how to read `alerts` (`select kind, universe_id, keys, created_at, sent_at from alerts order by created_at desc limit 20`);
    - that `ALERT_CONFIG` holds the thresholds and the backtest command tunes them;
    - the first start, in order (S2–S4 below);
    - how to pause: `systemctl disable --now radar-alerts.timer`.
  - Mention the timer in the pause and resume commands of section 4 and in section 8.
- [ ] **Step 2: README.** Add the job to the list of jobs, pointing to the runbook.
- [ ] **Step 3: Validate.** Run `npm run lint && npm run typecheck && npm run test && npm run build`. Commit `docs: run and tune the early breakout alerts`.

---

## Sessions

- [ ] **S0, before merge: the backtest gate** (design, section 5). Through the tunnel:
  - run `npm run alerts:backtest -- --from 2026-08-25 --to <today>`, then the same with `--words-only`;
  - show the owner every push and the weekly counts.

  **Pass:**
  - at most about 3–5 pushes and 10 digest games a day on average;
  - a `word:ragdoll` push by 2026-10-22;
  - `template:{verb} for {reward}` pushed before the week of 2026-09-21 (best effort, as v1 history is thin).

  On a miss, change `ALERT_CONFIG` with the owner's agreement and rerun. Record the runs in the execution notes, then mark the PR ready.
- [ ] **S1: Merge.** CI green, then the owner approves. The deploy applies 0019, installs the units and does not start the timer. Check the release and the `alerts` table through the tunnel.
- [ ] **S2: The webhook.** The owner creates a webhook in their Discord server, then from their own terminal: `ssh radar-prod`, `install -m 600 -o root -g root /dev/null /etc/radar/discord.env && nano /etc/radar/discord.env`, one line `DISCORD_WEBHOOK_URL=...`.
- [ ] **S3: Checks.** The owner runs `npm run provision:healthchecks` (runbook, section 8). Expect 20 lines.
- [ ] **S4: First run.** `systemctl start radar-job@alerts.service`, then read its `job_runs` row and the alerts it recorded. If it posted, check the card in Discord. Then `systemctl enable --now radar-alerts.timer`.
- [ ] **S5: First week.** Read the pushes and digests with the owner, tune `ALERT_CONFIG` if the volume or the noise is off, and record it.

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)
