# Radar v2 phase 2: concept check and format lifecycle

Revision of phase 2 of the [radar v2 design](2026-10-20-radar-v2-design.md), decided with the owner on 2026-10-26. It
replaces the order of phases 2 to 4 for the coming month. Section 4 of the v2 design (classification) still holds
except where this document says otherwise.

## 1. Intent

The owner is a solo Roblox developer. Their second game, `+1 Stone Skipping` (universe 10765298801, created
2026-09-05), was a hit: 67 million visits and 97% likes by 2026-10-26, and its style has been copied since. The tool
exists to help them pick the next game: see early which trends work on Roblox, and judge whether an idea arrives in
time. They use it mostly in conversation with Claude, who queries the data while they bring their eye for what can
work. The dashboard comes second.

How the hit was found, in the owner's words: a satisfying concept seen outside Roblox (a 2D stone-skipping demo from an
indie developer, seen on X), married to a Roblox format that was rising (`+1`), built from scratch with strong
execution (clean UI, intro cutscene, smooth progression, clean onboarding). Other stone-skipping games already existed,
with few players; the owner won on execution. Their earlier failures came from arriving late, behind ten copies, or
from reusing a template.

So the tool cannot predict success: execution decides, and execution is the owner's part. Its job is to show where good
execution has the best odds:

- which formats are rising, at their peak or declining, and whether followers still succeed;
- for a given concept, who already tried it, how each attempt did, and whether the race has started.

A concept tried several times without a well-executed winner is an opportunity, not a closed door.

## 2. Evidence gathered on 2026-10-26

Read-only queries on production, with titles as the only classifier.

- **Formats move as the owner says.**
  - `+1` games fell from 7.7% to 3.2% of tracked players between the weeks of 2026-08-24 and 2026-10-19. Its leader,
    `+1 Speed Keyboard Escape`, fell from a 268,000 to a 77,000 weekly average CCU.
  - Among `+1` games, those that peaked above 10,000 CCU went from 10 (created the week of 2026-07-27) to 0–2 per
    creation week in October.
  - Egg games are the current wave. `Steal An Egg` (created 2026-07-25) alone holds 1.2–1.9 million CCU. A
    `{verb} for Eggs` sub-format appeared in late August, had most entrants the week of 2026-09-21, and still produced
    1–3 games above 10,000 CCU a week until early October.
- **A concept check works with a live search.**
  - A Roblox search for "stone skipping", "skip stones" and "skipping stones" returned five attempts before the
    owner's: 6,700 to 57,000 visits each, 67–69% likes for the older ones and 88–93% for the two from early September.
  - It also returned every copy since. The best one, `Egg Skipping`, married the concept with the egg wave (1.6
    million visits); the `+1 … Skipping` copies have 10,000–140,000 visits and no players.
  - The visit counts are today's, not those of the day before the owner's launch.
- **Outside concepts reach Roblox before they ship.** `Fart Together`, in Steam's popular upcoming list (release
  2026-10-29, about 1,300 followers), already had four Roblox copies created between 2026-10-12 and 2026-10-19. The
  best one peaked at 6,430 CCU. The radar first saw them on 2026-10-22, when explore was widened.
- **Coverage.** Until 2026-10-20 the v1 history holds the 3,700 or so biggest games each week; since 2026-10-21 v2
  tracks about 10,700. Of the 2,319 tracked games created in the last 60 days, 390 never passed 100 CCU. Games that
  never had more than a handful of players are mostly missing, and a live search finds them when they matter.

## 3. Goals, non-goals, anti-goals

**Goals, in order:**

1. **Concept check**: for a concept, every Roblox attempt with its numbers and a plain diagnosis (section 4).
2. **Format classification and lifecycle**: Claude classifies games, mainly by format, and the radar computes each
   format's phase of life and room left (sections 5 and 6).
3. **Weekly brief**: in a session the owner opens, Claude reports what is breaking out, the state of the waves and a
   few leads. This is a ritual, not a build (section 7).

**Non-goals for this phase** (the owner excluded the first two on 2026-10-26):

- an idea generator (rising format × universal action × open spot);
- outside sources: X (bookmarks or account watch), Steam, Reddit, YouTube;
- the dashboard pages that were waiting for phase 2: clusters, classification card, similar games, watchlist and
  global date selector. They come once the pieces above have proved useful in sessions;
- explore's search terms from the cluster vocabulary (v2 design, section 3). Explore was widened on 2026-10-22 and
  keeps the words of young titles until the classification has proved stable.

**Anti-goals:**

- A verdict or score that says "go" on an idea. The tool shows evidence and plain, visible rules; the owner decides.
  The v2 design's rule stays: no composite score with invented weights, and every metric shows its sample size.
- Conclusions drawn from wrong classifications without a way to see or correct them.
- An interactive check that spends the production IP's search allowance (one search a minute) and starves explore.
- Synthetic or demo games in the application database.

## 4. Concept check

**Use.** In a session, the owner names a concept: a word, a game seen elsewhere, a tweet. Claude chooses search
phrases for it (synonyms, other languages, the outside game's name) and runs the check on the owner's machine:

```bash
npm run concept -- "stone skipping" "skip stones" "skipping stones"
```

**Sources.**

- Live Roblox search (`omni-search`, the endpoint explore uses), a page or two per phrase. It runs from the machine of
  the session, never from the server: the production IP's search allowance belongs to explore.
- Game details (`games.roblox.com/v1/games`, at most 50 ids per request, spaced like poll) and votes
  (`/v1/games/votes`) for every result.
- The radar's history for the results it tracks, read through the read-only role over the analysis tunnel
  (`docs/operations.md`, "Analysis sessions"): first seen, peak CCU, daily curve, discovery source, and metadata
  versions, so a renamed game shows its earlier titles.

**Output.** One row per relevant game, oldest first:

- creation date, title, creator;
- visits, players now, favorites, votes and like ratio, last update;
- the radar's first sighting and peak, when it tracks the game;
- a diagnosis label.

A summary comes first: number of attempts, the first attempt's date, the leader and its trend, and the attempts of the
last 14 days ("the race has started"). The command prints a table for reading and takes `--json` for Claude to
process.

**Relevance.** A search returns many unrelated games (57 results, 17 relevant, for stone skipping). By default the
output keeps the games whose title or description shares a meaningful word with a search phrase, and says how many it
hid.

**Diagnosis labels.** These are plain rules with their thresholds in `src/lib/config.ts`, shown next to the label:

- **no audience**: few visits;
- **liked but stuck**: a high like ratio on enough votes, but few visits or players;
- **leader**: the attempt with the most players, or the most visits when none has players;
- **fading**: a tracked peak far above today's players.

**Later, not in this phase.** A dashboard page (it would search from the server, so it needs its own share of the
search allowance), and matching on the classified core action, so that attempts whose titles use other words show up.

## 5. Classification, oriented to formats

Section 4 of the v2 design holds: fields, living vocabulary, overrides, the model and prompt version recorded with each
classification, the Message Batches API, and structured outputs. This phase changes the following.

**Fields.** A format has two halves, the way the owner names them: "`+1` is a good genre", "the new number one trend
is egg / Steal an Egg games".

- **Family and template.** The template has two levels.
  - The family is the genre the owner names: `+1`, `Steal a`, obby, tycoon.
  - The template is the pattern within it: `+1 {stat} per {action}`, `+1 {thing} Escape`, `{verb} for {reward}`.
  - `+1 Speed Keyboard Escape` and `+1 Stone Skipping` share the family `+1` even when their templates differ.
- **Reward loop.** It is the other half of a format. `eggs` is its own value, separate from `pets`: the owner reads
  egg games as one wave across templates (`Steal An Egg`, `Bike For Egg`, `Climb For Animals Eggs`).
- **Starting vocabulary.** It is seeded from the 2026-10-26 evidence.
- **Living vocabulary.** It matters most for families, templates and reward loops: a new format must appear as a new
  value, not be forced into an old one.
- **Core action.** It serves the concept check (later) and the game view; it is not a dimension of section 6 in this
  phase.
- **Other fields.** They stay, for the game view.

**Inputs.** The raw title, the description (truncated) and the stored 16:9 thumbnail. As the v2 design says, the prompt
tells the model to trust the title and thumbnail over keyword-stuffed descriptions.

**Which games.**

- Every game in `games` (13,165 on 2026-10-26) is a candidate. Lifecycle needs both the big games, which carry the
  player share, and the young failures, which carry the hit rate.
- The model comparison sets the cost, and the owner may narrow the scope after it (section 8).

**Model comparison** (from the v2 design):

- 200 games are classified with both Claude Opus 5.5 (`claude-opus-5-5`) and Claude Haiku 5.5 (`claude-haiku-5-5`).
- The differences are shown to the owner in a session, and the owner chooses the model.
- The sample must include the waves above: `+1`, egg and `{verb} for Eggs`, `Fart Together`. It must also include the
  owner's game and young games of every size.

**Owner review, before the full run.**

- The owner reviews a sample of 100 games classified by the chosen model before the full run, about 30–45 minutes of
  their time.
- They judge only the format fields: family, template, reward loop and core action.
- Claude prepares the table: title, thumbnail, the model's answer, and Claude's own doubts flagged. The owner confirms
  or corrects each row.
- Corrections go to the overrides file; the result goes to the plan's execution notes.
- The full classification starts only at 90% or more correct. Below that, the prompt or the vocabulary is revised and
  a new sample is reviewed, so nothing is paid twice for 13,000 games.

**Reclassification.**

- A game is classified when it enters tracking.
- It is classified again when its title's content fingerprint changes. Version 2, deployed on 2026-10-26, ignores
  bracketed text, update versions and trailing markers.
- Each classification stores the content fingerprint it classified and `CONTENT_FINGERPRINT_VERSION`.
- A description-only change does not trigger reclassification in this phase: 781 of 987 content changes between
  2026-10-22 and 2026-10-26 were small description edits (codes, update notes). A rule for a material description
  change comes later, measured on `game_versions`.
- An owner override always wins.

**Overrides and vocabulary merges.**

- Both live in a versioned file in the repository. Claude edits it in a session at the owner's request, and the
  `classify` job applies it after the deploy.
- An override sets one field of one game.
- A merge maps a vocabulary value onto another, for two templates that mean the same thing. `format_stats` reads the
  merged values.
- Production keeps changing only through the repository: `radar_analysis` stays read-only.
- Batches classify many games against the same vocabulary, so near-duplicate values will appear. Claude lists the new
  values in the weekly brief and proposes merges.

**Operations.**

- A `classify` job is a systemd timer like the others, with Healthchecks job and quality checks (18 of the 20 free
  checks after it).
- Each run submits a batch for unclassified and stale games, up to a cap in `src/lib/config.ts`, and collects the
  batches that finished.
- A failed or expired batch leaves its games unclassified for the next run.
- The Anthropic key lives in `/etc/radar/anthropic.env` (root, 600). Only the `classify` unit loads it, through its
  drop-in. The owner also sets a spend limit in the Anthropic console.
- The runbook (`docs/operations.md`) gains the key in the secrets inventory, the unit, the timer and the checks.

## 6. Format lifecycle

A SQL function, `format_stats(as_of)`, replaces the v2 design's `cluster_stats`. It works per format family, per
template, per reward loop and per family × reward loop, over weekly windows from `game_daily_all`. Sessions call it first; a page
can follow later.

**Per format and week:**

- **Players**: its share of tracked players, and its average CCU.
- **Coverage**: whether the week is from v1 (biggest games only, until 2026-10-20) or v2.
- **Leader**: its top game and that game's change from the previous week.
- **Entrants**: games created in the week, by Roblox creation date.
- **Hit rate**: the share of entrants that reached 1,000 and 10,000 CCU within 14 days.
- **Followers**: the median peak of entrants 2 to 10, in order of creation.
- **Wave age**: days since the format's first game above 10,000 CCU.

Every value comes with its sample size.

**Phase label.** The owner thinks in phases of life, so each format gets a label: emerging, rising, plateau or
declining. The label follows a plain rule on two metrics, the four-week trend of the format's share and the trend of
its leader, with thresholds in `src/lib/config.ts` and the rule printed next to the label.

**Check against the owner's eye.** The function must reproduce the 2026-10-26 reading:

- the `+1` family declining;
- the `eggs` reward loop carried by its leader;
- `{verb} for {reward}` × `eggs` rising then cooling.

When it disagrees, Claude shows the numbers and the owner judges.

## 7. Weekly brief

When the owner asks in a session, Claude reads:

- `rising_games` for breakouts;
- `format_stats` for the state of the waves;
- the entrants of the week.

It writes a short brief: what broke out, which formats moved, and a few concepts worth a concept check. This needs no
code. Once `format_stats` exists, the runbook's "Analysis sessions" section lists the queries.

## 8. Decisions

**Made by the owner (2026-10-26):**

- Build order: the concept check first, then classification and format lifecycle. The weekly brief starts as a
  ritual.
- The idea generator and X are excluded for now.
- The model is chosen after the 200-game comparison (v2 design).
- The owner reviews 100 classified games, on the format fields only, before the full classification runs.

**Made by Claude, open to the owner's correction:**

- The concept check runs as a command on the owner's machine during sessions; no dashboard page in this phase.
- Relevance filter and diagnosis rules as in section 4.
- Every tracked game is a classification candidate until the comparison shows the cost.
- Reclassification on title changes only; description changes wait for a measured rule.
- A plain-rule phase label, within the v2 design's "no composite score" principle.
- The pages waiting for phase 2 are deferred.
- A format is a family plus a template, and the reward loop is its other half, with `eggs` apart from `pets`.
- Overrides and vocabulary merges go through a versioned file in the repository.
- Explore keeps its title words in this phase.

**Left to the builder:**

- SQL and code structure, within `AGENTS.md`: domain logic in `src/lib`, persistence in `src/db`, entry points in
  `scripts`, limits in `src/lib/config.ts`.
- Output layout, prompt wording, batch polling and the exact thresholds, each measured on production data and recorded
  in the plan's execution notes.

## 9. Constraints

- One Next.js application and one PostgreSQL 18 database with TimescaleDB, on the server in `docs/operations.md`.
  Production changes only through the repository and the runbook.
- Roblox limits per IP:
  - game details: about 50 ids every 7 seconds;
  - search: one request a minute from the production IP.
- The owner is cost-sensitive. Anthropic spend is capped in the console, and each run's batch size is capped in
  `src/lib/config.ts`.
- The v2 design's target holds: at least 90% correct classifications on a reviewed sample of 100 games.
- Database tests run only in CI (no local PostgreSQL); production checks are read-only through `radar-analysis`.
