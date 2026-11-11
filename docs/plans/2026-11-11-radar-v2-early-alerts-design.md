# Radar v2: early breakout alerts

Designed with the owner on 2026-11-11, after the first ideas session on the format lifecycle. It adds a push alert to the
radar; it does not change the phase 2 design (`2026-10-26-radar-v2-phase-2-design.md`) or the format lifecycle plan
(`2026-11-11-radar-v2-format-stats.md`).

## 1. Intent

The owner, a solo Roblox developer, judged on 2026-11-11 that the radar reads trends well at a point in time but leaves them
"a train late" for game ideas. By the time a format's share moves (`format_stats` compares weekly shares over four
weeks), the copies have flooded in. The owner ships a polished game in under a week, so speed is not the bottleneck:
seeing a new pattern break out a few days earlier is.

This project sends the owner a Discord alert when a young game breaks out on a pattern that has few or no breakouts yet,
early enough to arrive among the first followers. It shows evidence, never a verdict: the owner decides.

A second project, a watch of sources outside Roblox (Steam, YouTube, Reddit) filtered by engagement, comes after this
one and is not designed here.

## 2. Evidence gathered on 2026-11-11

Read-only queries on production (`game_hourly`, `census_hourly` through `places`, `game_daily_all`, `games`).

- **The radar sees breakouts late, but around 1,000 CCU.** Of 240 games created since 2026-09-20 that peaked at
  10,000 CCU or more, 104 were in `games` before they reached 1,000 CCU, 112 between 1,000 and 10,000, and 24 only after
  10,000. The median discovery is 16 minutes after the game reached 1,000 CCU.
- **1,000 CCU comes days before 10,000.** Among the 102 breakouts read below 1,000 CCU, the median time from 1,000 to
  10,000 CCU is 99.5 hours (25th percentile 71 hours). Only 5 of 102 took less than 24 hours. From 500 CCU the median is
  128.5 hours; from 100 CCU, 241 hours.
- **Breakouts are not that young.** The median game reaches 1,000 CCU 13.5 days after its Roblox creation date.
- **Crossing 1,000 is common.** In each full week since 2026-10-19, 270 to 350 games under 30 days old crossed
  1,000 CCU; 12–21% of them went on to 10,000. Without a novelty filter that is about 300 alerts a week.
- **Copies follow within days, and followers still win for a few weeks.**
  - Realistic ragdoll sandboxes: the first to reach 10,000 CCU did so on 2026-10-15. 19 new ragdoll games were created
    the week of 2026-10-12, 8 of which reached 10,000. Games created the week of 2026-10-26 still did (6 of 20).
  - `{verb} for {reward}` × `eggs`: the first 10,000 CCU day was 2026-09-01. Games created up to the week of
    2026-10-05 still reached 10,000; none created later did.

## 3. Goals, non-goals, anti-goals

**Goals:**

1. A Discord notification when a pattern's second (or third) young game breaks out within a short time: "a wave is
   forming".
2. A daily Discord digest of the young games that are the first breakout of their pattern.
3. A backtest proving the filter before Discord is wired: few alerts a week, and the ragdoll wave flagged early.

**Non-goals:**

- Sources outside Roblox (project 2).
- Finding games before 1,000 CCU: discovery below 1,000 would add about a day and much noise. It is revisited only if
  the backtest shows the 10% discovered after 10,000 CCU hold the waves that matter.
- A dashboard page.

**Anti-goals:**

- A score, a ranking of opportunities or a "go". The alert shows numbers, each with its sample size.
- A flood: if the owner learns to ignore the channel, the project has failed even when it works.
- Spending the production IP's Roblox search allowance (one search a minute, explore's). Alerts read the radar's
  database only.
- The webhook URL in the repository, a log, a printed file or a conversation with an AI session.

## 4. Design

### Trigger

A candidate is a game that:

- has a Roblox creation date at most 30 days before the moment it first reached 1,000 CCU;
- first reached 1,000 CCU since the last run, in its hourly readings (`game_hourly`, or `census_hourly` of its places,
  whichever comes first).

### Pattern keys

A pattern is what makes two games "the same idea" to a developer. Each game carries a set of **pattern keys**, and
everything below counts per key (Claude's call, tuned by the backtest):

- `word:<w>` for each distinctive title word: a word of `titleKey(name)` (`src/lib/fingerprint.ts`) that is neither a
  stop word nor a generic Roblox word (obby, simulator, tycoon, update markers, numbers), nor too frequent across
  tracked titles;
- `action:<family>|<core action>` from `game_formats` (merges applied) and a normalized `core_action` from
  `game_classifications`;
- `template:<key>` for a template other than `none`, keyed like the merges (`mergeKey`).

Matching is per key and not transitive: two games share a pattern when they share a key. The model's templates alone
are too scattered (793 values the model proposed by 2026-11-11), which is why title words and core actions also count.

**Breakouts are ordered by the hour they first reached 1,000 CCU**, not by creation date. A **breakout** is a game that
reached 1,000 CCU at most 30 days after its creation. A **prior breakout** of a key is a breakout of that key that
crossed 1,000 CCU before the candidate. A breakout counts only when the radar has the readings to date it: a game
never read below 1,000 CCU is dated by its first reading at or above it, and a game the radar never read within 30 days
of its creation does not count (Claude's call; the backtest shows what this costs).

### Two levels

- **First breakout:** the candidate is the first breakout of at least one of its keys within the lookback. It goes to
  the next daily digest, once per game, listing the keys it opens.
- **Wave forming:** the candidate is the second or third breakout of a key within a window after that key's first
  breakout. It is pushed at once. A key is pushed at most once within a cooldown; a candidate that forms waves on several
  keys at once gives one push listing them. The push cites the earlier breakouts, including a first one already sent in
  a digest.
- The two levels are independent: a game can open one key (digest) and form a wave on another (push).

The lookback, the window, the cooldown and the counts are set by the backtest (section 5) and live in `src/lib/config.ts`.

### Classification

An alert needs the candidate's family and core action. A new game is classified by the hourly classify job, usually
within a few hours of discovery (`thumbnailWaitHours` is 6). The alerts job waits for the classification: a few hours
of delay against a median of about four days between 1,000 and 10,000 CCU (Claude's call). An unclassified candidate is
evaluated on its title words only, and is held from the digest until it is classified or 12 hours old.

### The card

One Discord embed per alert, in English (`AGENTS.md`):

- the thumbnail (`games.thumbnail_url`), the title linked to the Roblox page, the age since creation;
- the trajectory: CCU now, the hour it crossed 1,000, the CCU 24 hours earlier, the like ratio;
- the format: family, template, reward loop, core action;
- the pattern's evidence from the radar's database: what the pattern matched on, the prior breakouts (count, names,
  their peaks and ages), and the tracked games of the pattern (count, created in the last 14 days);
- a line with the local concept check command for the owner to run, for example
  `npm run concept -- "ragdoll physics"`.

The daily digest groups the day's first breakouts in one message, most CCU first, capped (a "and N more" line, with the
full list readable in the database).

### Delivery and state

- A table records every alert: kind, pattern key, the games, the evidence shown, when it was created and when it was
  sent. Alerts are created whether or not Discord is reachable, so sessions can read them, and a failed send is retried
  on the next run. A game or a pattern is never alerted twice for the same level.
- The digest goes out on the first run at or after 08:00 Europe/Paris (Claude's call).
- Pushes go out on the run that finds them.

## 5. Backtest gate

Before Discord is wired, the filter is replayed over history: hourly from 2026-09-20 (v2 readings), and with daily peaks
from 2026-08-25 where v1 left only daily data.

**How it runs** (Claude's call):

- The decision is a pure TypeScript function of the history known at a time T: games with their creation dates, keys and
  1,000 CCU crossing hours, plus the alerts already sent. The job and the backtest share it, and CI tests it on fixtures.
- The backtest is a command on the owner's machine that reads production through the read-only analysis tunnel, like the
  concept check and the classification trial. It writes nothing to the database and prints the alerts it would have
  sent, day by day.
- Classifications did not exist before the classify job (2026-10-29): every tracked game was classified then, with its
  title of that day. The backtest therefore uses today's classifications, which leaks some hindsight. A second run on
  `word:` keys alone, which need no classification, shows how much of the result rests on it. The 9 merges of
  2026-11-11 touch neither gate wave.

It must show:

- about 3 to 5 wave pushes a week at most, and a digest of about 10 games a day at most;
- the realistic ragdoll wave pushed by 2026-10-22 at the latest (its first 10,000 CCU day was 2026-10-15);
- the `{verb} for {reward}` × `eggs` wave pushed before its copies peaked (the week of 2026-09-21). This check is best
  effort: v1 history before 2026-09-21 holds only the biggest games;
- the list of every push it would have sent, for the owner to read.

When it misses these, the thresholds or the pattern rule change, and the backtest runs again. Discord is wired only after
the owner has read the result.

## 6. Operations

- A new job, `alerts`, runs hourly at `*:56:30`, after the classify job's slot. It makes no Roblox request.
- It adds the two checks every job has, `radar-alerts` and `radar-alerts-quality`: 20 of the 20 free checks (18 today,
  `docs/operations.md`, section 1). Project 2 will need a paid plan or merged checks.
- The webhook URL lives in `/etc/radar/discord.env` (`root 600`, one line `DISCORD_WEBHOOK_URL=...`). The owner creates
  the webhook in their Discord server and writes the file. Only the alerts unit loads it, through a drop-in that may be
  missing (a `-` prefix), so the job runs before the owner sets Discord up.
- A run with alerts to send and no webhook, or a send Discord rejects, is degraded: it pings the heartbeat but not the
  quality check, which alerts after an hour. Unsent alerts stay in the table and go out on a later run.
- The runbook (`docs/operations.md`) gains the job, the secret and how to read the alerts table.

## 7. Success

After 4 to 6 weeks of alerts:

- the number of pushes and digest entries a week stays within the targets;
- the share of pushed patterns that produced at least one more 10,000 CCU game within three weeks;
- the owner says whether an alert made them start a game, and which ones felt like noise.

## 8. Decisions

**Made by the owner (2026-11-11):**

- Automate; start with alerts inside Roblox, the outside watch next.
- Discord, a card as in section 4, and a trigger on young games crossing 1,000 CCU with a novelty filter.
- Two levels: a push when a wave forms (second or third breakout), a daily digest of first breakouts.
- The owner ships a game in under a week, so earlier detection is the lever.

**Made by Claude, open to the owner's correction:**

- The pattern rule (title words, family and core action, template) as per-key counts without transitivity, tuned by the
  backtest.
- Breakouts ordered by their 1,000 CCU crossing, and counted only when the radar can date them.
- The two levels independent, one push per candidate listing its keys, one push per key within a cooldown.
- The backtest as a read-only local command over a pure decision function shared with the job, on today's
  classifications, with a control run on title words alone.
- Waiting for the hourly classification rather than classifying candidates separately.
- A degraded run when alerts cannot be sent, the webhook drop-in optional.
- The digest at 08:00 Europe/Paris.
- The job at `*:56:30`, and the use of the last two free Healthchecks checks.

**Left to the builder:**

- SQL and code structure, within `AGENTS.md`.
- The stop-word list and the frequency cut of distinctive title words.
- The exact thresholds, from the backtest, recorded in the plan's execution notes.
- The embed layout within the content of section 4, and Discord rate limits (one webhook, a few messages an hour).

## 9. Constraints

- One Next.js application and one PostgreSQL 18 database with TimescaleDB, on the server in `docs/operations.md`;
  production changes only through the repository and the runbook.
- Every threshold in `src/lib/config.ts`.
- Test fixtures only in disposable test databases; database suites run in CI.
- Secrets follow `docs/operations.md`, section 3: the owner writes them from their own terminal.
