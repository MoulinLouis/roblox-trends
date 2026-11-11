# Format lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analysis sessions read, for every format family, template, reward loop and family × reward loop, its weekly share of players, its leader, its entrants and their hit rate, and a phase label (emerging, rising, plateau or declining) given by a plain rule. The owner's vocabulary merges apply to all of it.

**Architecture:**
- **Merges** live in `src/lib/classify/merges.ts`, beside the overrides. Every classify run copies them into `classification_merges`, the way it copies the overrides.
- **The `game_formats` view** gives each game's family, template and reward loop once the merges are applied, on top of `game_classifications`.
- **`format_weeks(as_of, …)`** is a PL/pgSQL function over `game_daily_all` and `game_formats`. It returns one row per format and complete UTC week.
- **`format_stats(as_of, …)`** returns one row per format: the latest week, the four-week trends, the wave age, the followers and the phase label with its rule.
- **Thresholds:** both functions take every threshold as a parameter; `FORMAT_CONFIG` in `src/lib/config.ts` holds the values. Thin wrappers in `src/db/formats.ts` call the functions for the tests and a later page.

**Tech Stack:** TypeScript, Vitest, drizzle-orm and drizzle-kit, PostgreSQL 18 with TimescaleDB, PL/pgSQL.

**Spec:**
- `docs/plans/2026-10-26-radar-v2-phase-2-design.md`, section 6 (format lifecycle) and section 5 ("Overrides and vocabulary merges");
- the execution notes of `docs/plans/2026-10-29-radar-v2-classification-job.md` (S1–S5, new values, spot check), which measured what this plan builds on.

**Out of scope:**
- A dashboard page (the design defers it) and a command-line report: sessions query the functions through the analysis tunnel.
- Teaching the prompt the values production learned (`Mount {name}`, `{thing} Prison Run`, `{thing} Obby`, …). That is a prompt v4 and a reclassification of about $36, the owner's call after this plan.

## Global Constraints

- **Language and layout.** Code, identifiers, comments, tests and docs are in English (`AGENTS.md`). Domain logic in `src/lib`, persistence in `src/db`. Every threshold lives in `FORMAT_CONFIG` in `src/lib/config.ts`; the SQL functions take them as parameters and hold no constant of their own.
- **No composite score.** The phase label is a plain rule on the share trend and the leader trend, and its rule is returned as text next to it. Every metric comes with its sample size (design, sections 3 and 6).
- **Weeks are whole UTC weeks**, Monday 00:00 to Monday 00:00, and only weeks that ended by `as_of` count. No interval or truncation may depend on the session time zone.
- **The functions follow `rising_games`** (`drizzle/0009_rising_games_execute.sql`): PL/pgSQL running one query through `EXECUTE … USING`, `STABLE`, so TimescaleDB plans the continuous aggregate's watermark as a constant.
- **Analysis reads `game_formats`, never the tables**, and `radar_analysis` stays read-only. Functions are executable by `PUBLIC` by default, as `rising_games` is.
- **Database suites (`*.db.test.ts`) run only in CI.** Push the branch to see them on the pull request. Test data goes in `game_daily_legacy` (a plain table), so no continuous aggregate needs refreshing.
- **Before handing off,** run `npm run lint`, `npm run typecheck`, `npm run test` and `npm run build`.
- **Production changes only through the repository and the runbook.** A push to `main` deploys, and needs the owner's approval.

## Review Focus

- **A session time zone other than UTC.** Week boundaries must not move (Task 4).
- **A week with missing days**, at the start of history or during an outage. Averages divide by the days the market has readings for, not by 7 (Task 4).
- **A format with no readings in the first half of the trend window.** No division by zero: the format is `emerging` (Task 5).
- **A merge file with a chain, a loop or two spellings of one value.** The test of the committed file fails before a deploy (Task 1).
- **`as_of` exactly on a Monday at 00:00.** The week that ends there counts; the next one does not (Task 4).

## Decisions taken in this plan (open to the owner's correction)

- **Coverage.** Weeks before the week of 2026-10-19 are `top`: the radar tracked about 3,800 of the biggest games. Later weeks are `full`, about 11,000 games. A CCU floor does not make them comparable: games of 300 CCU or more went from 2,046 to 3,557 at the change (measured on 2026-11-11). So a trend window must hold one coverage only, otherwise the phase is `unknown`. Every trend window that starts on or after 2026-10-19 holds full coverage; `as_of` from 2026-11-16 has one.
- **Share** is the format's average daily CCU over the market's, from `game_daily_all`, summed over the days of the week the market has readings for. The market counts every tracked game, classified or not.
- **Template `none`** (51% of games) is left out of the template dimension. Families and reward loops keep every value, `other` included.
- **Spelling.** Templates that differ only in case or spaces form one format, shown with their most frequent spelling (39 such groups on 2026-11-11).
- **Merges** map one value of one field onto another, case-insensitively; an override is merged like any value. Chains are refused, so a merge's target is final.
- **The first merges** (Task 1), from the near-duplicates in the classify job's execution notes:
  - families `rhythm game` → `rhythm`; `sandbox builder` → `building sandbox`; `grand strategy`, `war strategy`, `conquest strategy`, `territory strategy` and `RTS` → `strategy`; `donation hangout` → `donation game`;
  - template `{thing} Roleplay` → `{thing} RP`.
- **Hit rate.** An entrant is a game created in the week (Roblox creation date). It counts once its 14 days have passed by `as_of` (`matured`); a hit is a daily peak of at least 1,000 or 10,000 CCU in those 14 days. The summary sums the trend window's four weeks.
- **Followers** are the format's 2nd to 10th games in order of creation among the games the radar knows. The median is taken over their 14-day peaks. Formats older than the radar's history (2026-08-25) have no real first entrants, so the count is shown next to the median.
- **Wave age** is the number of days since the first day any game of the format peaked at 10,000 CCU or more. When that day is the first day of the radar's history, `wave_before_history` says the wave started earlier.
- **Phase rule**, applied in order over the last four complete weeks (W−3 to W):
  1. `small`: in week W, fewer than 5 games or under 1,000 average CCU.
  2. `unknown`: the four weeks mix `top` and `full` coverage.
  3. `emerging`: the first 10,000 CCU day is under 28 days old, or the format had no readings in W−3 and W−2.
  4. Share trend = (share W−1 + share W) / (share W−3 + share W−2); `rising` at 1.25 or more, `declining` at 0.80 or less.
  5. `declining` also when the leader holds at least half of the format and the leader's own trend (its CCU, same formula) is 0.80 or less: a format carried by a falling leader.
  6. Otherwise `plateau`.
  The ratios are provisional. S3 measures them on production.
- **Measured on 2026-11-11 with a prototype query.** The 2026-10-26 reading reproduces:
  - The `+1` family share went from 7.2% (week of 2026-08-24) to 3.0%. With `as_of` 2026-10-19, all its weeks are `top` and the ratio is 0.72: `declining`.
  - In the `eggs` reward loop, `Steal An Egg` held 66–90% of the loop's CCU every week from 2026-09-21: carried by its leader.
  - The `{verb} for {reward}` × `eggs` share rose from 0.01% to 1.12% (week of 2026-10-26), then fell to 0.93% and 0.79%. Its ratio is 1.52 with `as_of` 2026-10-19 (`rising`), and about 0.77 with `as_of` 2026-11-16 (cooling).

---

### Task 1: The merges file

**Files:**
- Create: `src/lib/classify/merges.ts`, `src/lib/classify/merges.test.ts`

**Interfaces:**
- Produces:
  - `type MergedField = "family" | "template" | "rewardLoop"`
  - `interface ClassificationMerge { field: MergedField; from: string; to: string; reason: string; decidedAt: string }` (`decidedAt` is `YYYY-MM-DD`)
  - `CLASSIFICATION_MERGES: readonly ClassificationMerge[]`
  - `mergeProblems(merges: readonly ClassificationMerge[]): string[]`, with one plain sentence per problem and an empty array when the list is valid

- [ ] **Step 1: Write the failing tests** in `merges.test.ts`:
  - `mergeProblems(CLASSIFICATION_MERGES)` equals `[]`. This test guards every later edit of the file.
  - A merge whose `to` equals its `from` case-insensitively is reported.
  - Two merges of the same field whose `from` differ only in case or spaces (`"Rhythm Game"`, `"rhythm  game"`) are reported.
  - A chain (`a → b` and `b → c` in the same field) is reported. A loop is reported too.
  - The same `from` in two different fields is allowed.
  - An empty `from`, `to` or `reason`, and a `decidedAt` that is not `YYYY-MM-DD`, are reported.

- [ ] **Step 2: Run** `npx vitest run src/lib/classify/merges.test.ts`. Expect FAIL (module not found).

- [ ] **Step 3: Implement `merges.ts`.**
  - Compare values with one key, `value.trim().replace(/\s+/g, " ").toLowerCase()`, exported as `mergeKey(value: string): string` so Task 2's tests can use the same normalization.
  - Write the first merges from "Decisions" above. Each has the reason `"Near-duplicate in the classify job's new values (execution notes, 2026-11-11)."` and the `decidedAt` of the owner's approval of this plan.
  - Above the list, a comment explains:
    - a merge maps one value of one field onto another for `format_stats`;
    - the classify job copies the list into `classification_merges` on its next run after a deploy;
    - targets are final (no chains).

- [ ] **Step 4: Run** `npx vitest run src/lib/classify/merges.test.ts`. Expect PASS.

- [ ] **Step 5: Commit** `feat(classify): record the owner's vocabulary merges`.

### Task 2: The merges table, its sync and the `game_formats` view

**Files:**
- Modify: `src/db/schema.ts`, `src/db/classifications.ts`, `src/lib/jobs/classify.ts`
- Create: `drizzle/0014_classification_merges.sql` (generated), `drizzle/0015_game_formats.sql` (custom), the files drizzle-kit adds to `drizzle/meta`
- Test: `src/db/classifications.db.test.ts`, `src/lib/jobs/classify.db.test.ts`

**Interfaces:**
- Consumes: `ClassificationMerge`, `CLASSIFICATION_MERGES` and `mergeKey` (Task 1).
- Produces:
  - table `classification_merges (field text, from_key text, from_value text, to_value text, reason text, decided_at text)`, primary key `(field, from_key)`, with `from_key = mergeKey(from)`;
  - `syncClassificationMerges(db: Database, merges: readonly ClassificationMerge[]): Promise<number>`;
  - view `game_formats (universe_id bigint, family text, template text, reward_loop text)`;
  - `ClassifyDependencies.merges?: readonly ClassificationMerge[]` and the run's stat `merges`.

- [ ] **Step 1: Write the failing database tests.**
  - In `classifications.db.test.ts`, `syncClassificationMerges`:
    - replaces the table's content and returns the count;
    - with an empty list, empties the table.
  - In the same file, `game_formats`:
    - a game classified `family = 'Rhythm Game'` with a merge `rhythm game → rhythm` reads `family = 'rhythm'`;
    - a merge of `template` does not touch the `family` of a game whose family has the same text;
    - an override that sets the family to a merged value is merged too;
    - a game with no merge keeps its values unchanged, case included.
  - In `classify.db.test.ts`, a run copies `dependencies.merges` into `classification_merges` and reports `stats.merges`, next to the existing overrides test.

- [ ] **Step 2: Add the table to `schema.ts`.** Use `classificationOverrides` as the model, with a comment saying the table is a copy of `src/lib/classify/merges.ts` that every classify run rewrites. Run `npm run db:generate -- --name=classification_merges`. Expect `drizzle/0014_classification_merges.sql` with one `CREATE TABLE`.

- [ ] **Step 3: Write the view.** Run `npx drizzle-kit generate --custom --name=game_formats`, then write `drizzle/0015_game_formats.sql`.
  - The view reads `game_classifications` (overrides already applied).
  - It left-joins `classification_merges` once per field, on `field` and on the normalized value. In SQL the normalization is `lower(regexp_replace(btrim(value), '\s+', ' ', 'g'))`, which must equal `mergeKey`.
  - Each column is `coalesce(merge.to_value, value)`.
  - It keeps only rows with a non-null family.
  - A comment says that `format_stats` reads this view, and that analysis sessions read it for merged values and `game_classifications` for the model's own answers.

- [ ] **Step 4: Implement the sync.** `syncClassificationMerges` replaces the table's content in one transaction, like `syncClassificationOverrides`. In `createClassifyJob`, call it right after the overrides with `dependencies.merges ?? CLASSIFICATION_MERGES`, and add `merges` to the run's stats.

- [ ] **Step 5: Check and commit.**
  - Run `npm run typecheck && npx vitest run src/lib`. Expect PASS.
  - Read `src/db/schema.db.test.ts` and `src/db/production-roles.db.test.ts`, and add `classification_merges` and `game_formats` wherever they list relations.
  - Commit `feat(db): apply the vocabulary merges in a game_formats view`.

### Task 3: `FORMAT_CONFIG`

**Files:**
- Modify: `src/lib/config.ts`

**Interfaces:**
- Produces `FORMAT_CONFIG`, read by Tasks 4 and 5:

```ts
// Format lifecycle (docs/plans/2026-11-11-radar-v2-format-stats.md): the parameters of format_weeks and format_stats.
export const FORMAT_CONFIG = {
  // format_weeks returns this many complete UTC weeks before as_of.
  weeks: 12,
  // Weeks starting before this Monday are "top": the radar then tracked about 3,800 of the biggest games, about
  // 11,000 since. A trend never compares the two.
  fullCoverageFrom: "2026-10-19",
  // A hit: an entrant whose daily peak reaches a threshold within hitDays of its Roblox creation date.
  hitDays: 14,
  hitThresholds: { small: 1_000, large: 10_000 },
  // Wave age counts from the first day a game of the format peaked at this CCU.
  waveCcu: 10_000,
  // Followers: the format's games of these ranks, in order of creation.
  followerRanks: { first: 2, last: 10 },
  // The phase rule, in order (provisional ratios, measured in S3).
  trendWeeks: 4,
  minimumGames: 5,
  minimumCcu: 1_000,
  emergingDays: 28,
  risingShareRatio: 1.25,
  decliningShareRatio: 0.8,
  leaderCarryShare: 0.5,
} as const;
```

- [ ] **Step 1: Add it** after `RADAR_CONFIG`. Run `npm run typecheck`. Expect PASS. It is committed with Task 4.

### Task 4: `format_weeks`

**Files:**
- Create: `drizzle/0016_format_weeks.sql` (custom), `src/db/formats.ts`, `src/db/formats.db.test.ts`

**Interfaces:**
- Consumes: `game_formats` (Task 2), `FORMAT_CONFIG` (Task 3), `game_daily_all`, `games.roblox_created_at`.
- Produces:
  - SQL `format_weeks(as_of timestamptz, weeks int, full_coverage_from date, hit_days int, hit_small int, hit_large int, dimension_filter text DEFAULT NULL, format_filter text DEFAULT NULL)`. It returns `TABLE (dimension text, format text, week_start timestamptz, coverage text, market_games int, market_ccu double precision, games int, ccu_avg double precision, share double precision, leader_universe_id bigint, leader_name text, leader_ccu double precision, leader_previous_ccu double precision, leader_share double precision, entrants int, entrants_matured int, hits_small int, hits_large int)`.
  - `dimension` is one of `family`, `template`, `reward_loop` or `family_reward_loop`. For the last one, `format` is `family || ' × ' || reward_loop`. `format_filter` matches case-insensitively.
  - TS `formatWeeks(db: Database, query: { asOf: Date; dimension?: FormatDimension; format?: string }, config = FORMAT_CONFIG): Promise<FormatWeek[]>`, with `type FormatDimension = "family" | "template" | "reward_loop" | "family_reward_loop"`. `FormatWeek` holds the columns in camelCase, numbers as numbers and `weekStart` as a `Date`.

**Column definitions** (for one format and one week):
- `week_start`: a Monday 00:00 UTC whose week ended by `as_of`, among the `weeks` most recent ones.
- `coverage`: `top` when `week_start` is before `full_coverage_from`, else `full`.
- `market_games` and `market_ccu`: the games with a reading that week, and their summed `ccu_avg` divided by the number of distinct days that have readings that week.
- `games`, `ccu_avg` and `share`: the same for the format's games, then `ccu_avg / market_ccu`.
- `leader_*`: the format's game with the highest average CCU that week. `leader_previous_ccu` is that game's average the week before (null without readings). `leader_share` is `leader_ccu / ccu_avg`.
- `entrants`: the format's games with `roblox_created_at` in the week. `entrants_matured` counts those created at least `hit_days` before `as_of`. `hits_small` and `hits_large` count matured entrants whose highest `ccu_peak` on days in `[created, created + hit_days)` reaches the threshold.
- A format with entrants but no readings in a week still gets a row; a format with neither gets none.
- Template `none` is left out. Templates are grouped by the normalized key of Task 2 and shown with their most frequent spelling across all games.

- [ ] **Step 1: Write the failing tests** in `formats.db.test.ts`. Seed `games`, a collected `classification_batches` row with `classified` `classifications`, and daily rows in `game_daily_legacy`. Use weeks in March 2026 and pass `fullCoverageFrom` explicitly.
  - Share: in one complete week, game 1 (`obby`) at 300, game 2 (`obby`) at 100 and game 3 (`tycoon`) at 600 average CCU give `obby` a share of 0.4, 2 games and 400 CCU. `market_games` is 3.
  - Missing days: when the market has readings on 4 days of a week, the averages divide by 4.
  - Week boundaries: with `as_of` on a Monday at 00:00, the week that ends then is the latest row, and readings on that Monday count in no row. The result is the same after `set time zone 'Pacific/Auckland'` on the connection.
  - Leader: the leader, its share, and `leader_previous_ccu` (null when the leader had no readings the week before).
  - Entrants and hits: a game created on the week's Wednesday that peaks at 1,500 on its 3rd day and 12,000 on its 15th counts as one entrant, one small hit and no large hit. An entrant created 5 days before `as_of` counts in `entrants` but not in `entrants_matured`.
  - Spelling and dimensions:
    - templates `Build To Survive {thing}` (2 games) and `Build to Survive {thing}` (1 game) are one format, shown as `Build To Survive {thing}`;
    - template `none` has no row;
    - `family_reward_loop` rows read `obby × progress`.
  - Coverage: a week before `fullCoverageFrom` reads `top`, the next one `full`.
  - Filters: `dimension: "family", format: "OBBY"` returns only `obby` rows.

- [ ] **Step 2: Write the function** in `drizzle/0016_format_weeks.sql`, created with `npx drizzle-kit generate --custom --name=format_weeks`.
  - Follow the shape of `rising_games`: a header comment saying what it computes, then the query run through `EXECUTE … USING`, with its arguments as `$1` to `$8`.
  - Compute week boundaries from `date_trunc('week', as_of AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, stepping back in `interval '7 days'`. Read days in the half-open range `[first week start, last week end)`.

- [ ] **Step 3: Write `formatWeeks`** in `src/db/formats.ts`, in the style of `risingGames` in `src/db/radar.ts`: named arguments with explicit casts, and rows mapped to camelCase.

- [ ] **Step 4: Run** `npm run typecheck && npm run lint`. Expect PASS. The database tests run in CI (Step 6).

- [ ] **Step 5: Commit** `feat(db): compute each format's weeks from the daily aggregates`, with Task 3's config.

- [ ] **Step 6: Push the branch** and open a draft pull request, so CI runs the database suites. Expect `validate` green before Task 5.

### Task 5: `format_stats` and its phase label

**Files:**
- Create: `drizzle/0017_format_stats.sql` (custom)
- Modify: `src/db/formats.ts`, `src/db/formats.db.test.ts`

**Interfaces:**
- Consumes: `format_weeks` (Task 4), `FORMAT_CONFIG`.
- Produces:
  - SQL `format_stats(as_of timestamptz, full_coverage_from date, hit_days int, hit_small int, hit_large int, wave_ccu int, follower_first int, follower_last int, trend_weeks int, minimum_games int, minimum_ccu int, emerging_days int, rising_ratio double precision, declining_ratio double precision, leader_carry_share double precision)`. It returns `TABLE (dimension text, format text, week_start timestamptz, coverage text, games int, ccu_avg double precision, share double precision, share_trend double precision, leader_universe_id bigint, leader_name text, leader_share double precision, leader_trend double precision, entrants int, entrants_matured int, hits_small int, hits_large int, first_wave_day timestamptz, wave_age_days int, wave_before_history boolean, followers int, followers_median_peak double precision, phase text, phase_rule text)`.
  - It has one row per format with readings in the latest complete week. Entrant and hit counts sum the `trend_weeks` weeks.
  - TS `formatStats(db: Database, query: { asOf: Date }, config = FORMAT_CONFIG): Promise<FormatStat[]>`, with `type FormatPhase = "small" | "unknown" | "emerging" | "rising" | "declining" | "plateau"`.

- [ ] **Step 1: Write the failing tests** in `formats.db.test.ts`. Use four complete `full` weeks unless a test says otherwise. Each test names the rule step it pins (Decisions, "Phase rule").
  - `rising`: the format's share goes 0.10, 0.10, 0.15, 0.15. `share_trend` is 1.5, and `phase_rule` contains `1.50` and `1.25`.
  - `declining`: shares 0.20, 0.20, 0.15, 0.15 give a trend of 0.75.
  - `plateau`: shares 0.20, 0.20, 0.19, 0.21.
  - Falling leader: flat shares, the leader holding 70% of the format, and the leader's CCU falling to 0.7 of its first half. Expect `declining`, with a `phase_rule` that names the leader.
  - Leader change: week W's leader was only second in W−3. Its trend uses its own CCU, not the CCU of W−3's leader.
  - `unknown`: the same `rising` data with `fullCoverageFrom` between W−3 and W.
  - `emerging`: a game first peaks at 10,000 CCU 10 days before `as_of`. Also a format with no readings in W−3 and W−2: no error, `emerging`.
  - `small`: 4 games in week W.
  - Followers: with 11 games created on successive days, peaking at 100 to 1,100 in 14 days (in order of creation), the followers are ranks 2 to 10: `followers` is 9 and `followers_median_peak` is 600.
  - Wave age: the first 10,000 CCU day 40 days before `as_of` gives `wave_age_days` 40. When that day is the first day of the test's history, `wave_before_history` is true.

- [ ] **Step 2: Write the function** in `drizzle/0017_format_stats.sql`, in PL/pgSQL.
  - It reads `format_weeks` for `trend_weeks` weeks, then computes the trends, the wave and the followers.
  - The leader trend follows week W's leader through its own daily rows over the four weeks: `format_weeks` names each week's leader, and earlier weeks may have had another one.
  - It applies the rule steps in order.
  - `phase_rule` gives the measured value and the threshold, for example `share x0.72 over 4 weeks (declining at x0.80 or less)`.
  - "History start" is the earliest day in `game_daily_all`.

- [ ] **Step 3: Write `formatStats`** in `src/db/formats.ts`, passing every parameter from `FORMAT_CONFIG`.

- [ ] **Step 4: Run** `npm run typecheck && npm run lint`, push, and wait for CI. Expect `validate` green.

- [ ] **Step 5: Commit** `feat(db): label each format's phase from its share and its leader`.

### Task 6: The runbook

**Files:**
- Modify: `docs/operations.md` (section 2, "Analysis sessions"; section 4, "Classification")

- [ ] **Step 1: Analysis sessions.**
  - Add `game_formats` next to `game_classifications`: merged values against the model's own.
  - Add a `format_stats` query and a `format_weeks` query for one format, with the current `FORMAT_CONFIG` values written out, as the section does for `rising_games`. Order the summary by `dimension, share desc`.
  - Say that `phase_rule` gives the reason for each label, and that a trend window mixing `top` and `full` weeks gives `unknown`.

- [ ] **Step 2: Classification.** Merges are edited in `src/lib/classify/merges.ts`. A deploy applies them on the next classify run, and `stats.merges` counts them. A merge's target is final.

- [ ] **Step 3: Validate and commit.** Run `npm run lint && npm run typecheck && npm run test && npm run build`. Expect PASS. Commit `docs: read format lifecycle in analysis sessions`, then mark the pull request ready for review.

---

## Sessions after the merge

- [ ] **S1: Merge.** CI green, then the owner approves. The deploy runs migrations 0014 to 0017.
  - Check that the release is live.
  - Check, through the analysis tunnel, that `select count(*) from game_formats` is close to the classified count.
  - Check that the next classify run reports `stats.merges`.
- [ ] **S2: The check against the owner's eye** (design, section 6), through the tunnel:
  - `as_of` 2026-10-19 (four `top` weeks): `+1` family `declining`; `eggs` reward loop with `leader_share` of 0.5 or more; `{verb} for {reward} × eggs` `rising`.
  - `as_of` 2026-11-16 (four `full` weeks): `{verb} for {reward} × eggs` with `share_trend` under 1.
  - When a result disagrees, Claude shows the numbers and the owner judges.
- [ ] **S3: Thresholds.** For `as_of` 2026-11-16 and 2026-11-23:
  - read the distribution of `share_trend` and the count per phase among the formats above `small`;
  - show the owner the formats closest to each threshold;
  - change `FORMAT_CONFIG` only with the owner's agreement.
- [ ] **S4: Notes.** The execution notes record:
  - the runtime of both functions on production;
  - the S2 and S3 results;
  - the merges added since.

  The weekly brief can then start (design, section 7).

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)

- **Execution, 2026-11-11.** The owner approved the plan and chose subagent-driven execution. Every subagent ran on Sonnet, the final review included. Tasks 3 and 4 shipped together.
  - **Merges** (`7572fa5`): 9 first merges; `mergeProblems` refuses chains, loops, self-merges and two spellings of one `from`.
  - **Merge key in SQL:** `lower(btrim(regexp_replace(value, '\s+', ' ', 'g')))`. It collapses whitespace first, then trims, so a leading tab keys as `mergeKey` does. The plan's order (trim first) would have missed it.
  - **`game_formats`** (`c97323f`): migrations 0014 and 0015. The production-roles read list was not extended: its privilege test already covers every public relation.
  - **`format_weeks`** (`ad978ef`):
    - It reads one week more than it returns, so the oldest week's leader has a `leader_previous_ccu`.
    - The hit window is the `hit_days` UTC days from the creation day. The literal `[created, created + hit_days)` range would drop the creation day's peak.
    - A format with entrants and no readings in a week has a row with 0 CCU.
    - On production, read-only with `game_formats` replaced by `game_classifications`, its query took 3.2 s for every format over 12 weeks. The `+1` shares matched the prototype.
  - **`format_stats`** (`1bb2890`, `8dd31c2`):
    - Followers count once their window has ended by `as_of`.
    - "No readings in W−3 and W−2" means a share of 0 in both weeks. That gives `emerging` with a null `share_trend`.
    - The leader trend follows week W's leader through its own daily rows.
  - **Runbook** (`0a38b56`, `aadfae7`): the queries, the rule order, and what `game_formats` holds.
  - **Final review:** ready to merge. Its one important point is S2: `format_stats` has not run on production yet. A read-only check found its follower lookups cheap (2,000 in 140 ms).
  - **Left for later:**
    - `format_stats` recomputes the coverage rule instead of reading `format_weeks`' column;
    - the market day count is computed twice in 0016;
    - entrant peaks are looked up for unclassified games;
    - an odd `trend_weeks` splits unequal halves;
    - a few tie-break and window tests are missing.
