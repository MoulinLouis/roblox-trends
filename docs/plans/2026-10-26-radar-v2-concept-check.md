# Concept check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run concept -- <phrase>...` lists every Roblox attempt at a concept with its numbers, the radar's history and a plain diagnosis, for analysis sessions on the owner's machine.

**Architecture:** A pure orchestrator in `src/lib/concept/` takes the Roblox API and an optional history reader as dependencies. It searches each phrase, fetches details and votes, keeps the relevant games, adds the radar's history, labels each attempt and summarizes the result. `src/db/concept.ts` reads the history in a read-only session. `scripts/concept.ts` wires the real client and database, then prints a table or JSON.

**Tech Stack:** TypeScript, Node 24, Vitest, drizzle-orm with PostgreSQL 18 and TimescaleDB, the existing `RobloxClient` (`src/lib/api/roblox.ts`).

**Spec:** `docs/plans/2026-10-26-radar-v2-phase-2-design.md`, section 4 (and sections 3, 8 and 9).

## Global Constraints

- Source code, identifiers, comments, tests, docs and output are in English (`AGENTS.md`).
- Domain logic goes in `src/lib`, persistence in `src/db`, the entry point in `scripts`.
- Every threshold and limit lives in `CONCEPT_CHECK_CONFIG` in `src/lib/config.ts`.
- The command never writes to the database. Its session sets `default_transaction_read_only=on`, like `src/db/dashboard.ts`.
- It runs on the owner's machine, never on the server: the production IP's search allowance (one request a minute)
  belongs to explore. A residential IP gets about 4 searches a second (explore config comment, 2026-10-22).
- Game details keep their spacing of 50 ids every 7 s (`EXTERNAL_REQUEST_CONFIG.minimumIntervalByEndpoint`).
- Diagnosis labels are plain rules, and the report prints each rule with its thresholds. There is no score.
- Database suites run only in CI (no local PostgreSQL). Before handing off, run `npm run lint`, `npm run typecheck`,
  `npm run test` and `npm run build`.

## Review Focus

- **Every phrase finds nothing relevant.** The report says "No attempt found" and the command exits 0 (Task 4, Task 5).
- **No database configured, or the tunnel is down.** The report comes without history and says why, and the command
  exits 0 (Task 4, Task 5).
- **One phrase's search fails after its retries.** The other phrases are still reported, and the failure is listed
  (Task 4).
- **A game without votes (0 up, 0 down).** Its like ratio shows as "—" and it is never "liked but stuck" (Task 2).
- **A phrase with no usable words**, such as the two-letter Korean word "타일", which `titleWords` drops. Every result
  of that check is kept instead of being hidden (Task 4).

---

### Task 1: Shared title words and relevance

**Files:**
- Modify: `src/lib/title.ts` (gains `titleWords` and its stop words, moved from `src/lib/jobs/explore.ts:17-47,108-126`)
- Modify: `src/lib/jobs/explore.ts` (imports `titleWords` instead of defining it)
- Create: `src/lib/concept/relevance.ts`
- Test: `src/lib/concept/relevance.test.ts`

**Interfaces:**
- Produces:
  - `titleWords(title: string): Map<string, string>`, exported from `src/lib/title.ts`. Its behavior is unchanged:
    folded word mapped to the spelling, `+N` kept as a word, stop words and words under 3 letters dropped.
  - `relevanceWords(phrases: readonly string[]): Set<string>`: the folded words of every phrase, without `+N` tokens.
  - `isRelevant(text: { name: string; description: string }, words: ReadonlySet<string>): boolean`: true when the
    title or the description shares a folded word with `words`.

- [ ] **Step 1: Move `titleWords` and `SEARCH_STOP_WORDS` to `src/lib/title.ts`, export `titleWords`, import it in explore.** Keep the comment block. Run `npx vitest run src/lib/jobs/explore.test.ts src/lib/title.test.ts`: PASS, unchanged.

- [ ] **Step 2: Write the failing relevance tests**

```ts
it("folds plurals and keeps every phrase's words", () => {
  expect(relevanceWords(["stone skipping", "skip stones"])).toEqual(new Set(["stone", "skipping", "skip"]));
});
it("ignores +N tokens, which every +1 game shares", () => {
  expect(relevanceWords(["+1 stone skipping"])).toEqual(new Set(["stone", "skipping"]));
});
it.each([
  [{ name: "Skip A Stone", description: "" }, true],
  [{ name: "Rock Toss", description: "Skip stones on the lake" }, true],
  [{ name: "Egg Tycoon", description: "Hatch eggs" }, false],
])("matches the title or the description: %o", (text, expected) => {
  expect(isRelevant(text, relevanceWords(["stone skipping", "skip stones"]))).toBe(expected);
});
```

- [ ] **Step 3: Run them to see them fail**: `npx vitest run src/lib/concept/relevance.test.ts`, FAIL (module missing).

- [ ] **Step 4: Implement `relevanceWords` and `isRelevant`** in `src/lib/concept/relevance.ts`, on top of `titleWords`; the description goes through `titleWords` too.

- [ ] **Step 5: Run them to see them pass**, then commit `refactor(title): share titleWords` and `feat(concept): match search results to a concept's words` (two commits).

### Task 2: Diagnosis and summary

**Files:**
- Modify: `src/lib/config.ts` (adds `CONCEPT_CHECK_CONFIG`)
- Create: `src/lib/concept/types.ts`, `src/lib/concept/diagnosis.ts`
- Test: `src/lib/concept/diagnosis.test.ts`

**Interfaces:**
- Produces, in `src/lib/concept/types.ts`:

```ts
export type DiagnosisLabel = "leader" | "fading" | "liked but stuck" | "no audience";

export interface ConceptHistory {
  firstObservedAt: Date;
  peakCcu: number | null;
  peakDay: Date | null;
  daily: { day: Date; ccuPeak: number }[]; // within CONCEPT_CHECK_CONFIG.historyDays, oldest first
  earlierNames: string[]; // metadata version names other than the current one, oldest first
  sources: DiscoverySource[];
}

export interface ConceptAttempt {
  universeId: number;
  name: string;
  description: string;
  creatorName: string;
  created: Date;
  updated: Date;
  visits: number;
  playing: number;
  favorites: number;
  upVotes: number;
  downVotes: number;
  likeRatio: number | null; // null without votes
  matchedPhrases: string[];
  history: ConceptHistory | null; // null when the radar does not track the game or history was not read
  labels: DiagnosisLabel[];
}

export interface ConceptSummary {
  attempts: number;
  hidden: number; // results without a shared word
  unavailable: number; // results Roblox returned no details for
  firstAttempt: { universeId: number; name: string; created: Date } | null;
  leader: { universeId: number; name: string; playing: number; visits: number; fading: boolean } | null;
  recent: { universeId: number; name: string; created: Date }[]; // created within recentDays, oldest first
}

export type HistoryStatus = { status: "read" } | { status: "skipped"; reason: string } | { status: "failed"; error: string };

export interface ConceptReport {
  phrases: string[];
  checkedAt: Date;
  attempts: ConceptAttempt[]; // oldest first
  summary: ConceptSummary;
  failures: { phrase: string; error: string }[];
  history: HistoryStatus;
}
```

- `CONCEPT_CHECK_CONFIG`, with a comment that the values come from the 2026-10-26 stone-skipping check:

```ts
export const CONCEPT_CHECK_CONFIG = {
  searchPagesPerPhrase: 2,
  recentDays: 14,
  historyDays: 60,
  diagnosis: {
    noAudienceMaximumVisits: 10_000,
    likedMinimumRatio: 0.85,
    likedMinimumVotes: 20,
    stuckMaximumPlayers: 100,
    fadingMinimumPeakCcu: 1_000,
    fadingMaximumShareOfPeak: 0.1,
  },
} as const;
```

- `diagnose(attempts: ConceptAttempt[], rules = CONCEPT_CHECK_CONFIG.diagnosis): ConceptAttempt[]`. It returns copies
  with `labels` set, and applies these rules:
  - **leader**: exactly one attempt, the one with the most players, or the most visits when none has players;
  - **fading**: a history peak of at least `fadingMinimumPeakCcu`, and players at most `fadingMaximumShareOfPeak` of
    it; it may join "leader";
  - **liked but stuck**: not the leader, a like ratio of at least `likedMinimumRatio` on at least `likedMinimumVotes`
    votes, and fewer than `stuckMaximumPlayers` players;
  - **no audience**: fewer than `noAudienceMaximumVisits` visits, and not "liked but stuck".
- `summarize(attempts: ConceptAttempt[], counts: { hidden: number; unavailable: number }, now: Date, recentDays = CONCEPT_CHECK_CONFIG.recentDays): ConceptSummary`

- [ ] **Step 1: Write the failing tests.** The fixture holds the 2026-10-26 stone-skipping numbers:

| Attempt | Created | Visits | Players | Up / down | History peak | Expected labels |
| --- | --- | ---: | ---: | --- | ---: | --- |
| A, `Skip a Rock!` | 2026-01-05 | 37,605 | 0 | 75 / 33 | — | `[]` |
| B, `Skip A Stone` | 2026-04-05 | 6,720 | 0 | 18 / 9 | — | `["no audience"]` |
| C, `Skip a Stone!` | 2026-09-02 | 9,308 | 0 | 21 / 3 | — | `["liked but stuck"]` |
| D, `+1 Stone Skipping` | 2026-09-05 | 67,362,222 | 17,579 | 90,073 / 3,057 | 41,000 | `["leader"]` |
| E, `🏞️ Skip a stone` | 2026-09-05 | 40,182 | 0 | 633 / 48 | — | `["liked but stuck"]` |
| F, `+1 TNT Skipping` | 2026-10-13 | 141,743 | 65 | 33 / 13 | 1,200 | `["fading"]` |
| G, `Skip Stones For Eggs` | 2026-10-06 | 1,366 | 0 | 0 / 0 | — | `["no audience"]`, `likeRatio` null |

Add these tests:
  - `"names the most-visited attempt leader when none has players"`: D with 0 players and A, B, so D is the leader.
  - `"lets a leader fade"`: a single attempt with 20,000 players and a history peak of 268,000 gets
    `["leader", "fading"]`.
  - `summarize` at `now = 2026-10-26T18:00:00Z` gives:
    - `firstAttempt` A;
    - `leader` D with `fading: false`;
    - `recent` with F only (G was created on 10-06);
    - `attempts` 7, and `hidden` / `unavailable` passed through.
  - `summarize([])` gives `leader` null and `firstAttempt` null.

- [ ] **Step 2: Run them to see them fail**: `npx vitest run src/lib/concept/diagnosis.test.ts`, FAIL.

- [ ] **Step 3: Add `CONCEPT_CHECK_CONFIG` and the types, then implement `diagnose` and `summarize`.**

- [ ] **Step 4: Run them to see them pass**, then commit `feat(concept): label each attempt with plain rules`.

### Task 3: History from the radar

**Files:**
- Create: `src/db/concept.ts`
- Test: `src/db/concept.db.test.ts`

**Interfaces:**
- Consumes: `ConceptHistory` (Task 2).
- Produces: `readConceptHistory(db: Database, universeIds: number[], since: Date): Promise<Map<number, ConceptHistory>>`.
  - It returns one entry per tracked universe; untracked ids are absent.
  - The peak is all-time, from `game_daily_all`; `daily` keeps the days on or after `since`.
  - It takes at most four statements in all, whatever the number of ids: no query per game.

- [ ] **Step 1: Write the failing database test**, built like `src/db/game-view.db.test.ts`.
  - Fixture:
    - game 1 is first upserted as `Skip a Stone` on 2026-10-01T00:00Z, then as `Skip a Stone [UPD]` on 2026-10-20;
    - its observations are 300 CCU on 2026-08-01 and 1,000 CCU on 2026-10-19;
    - its discovery source is `search`;
    - game 2 is upserted with no observation.
  - Read ids `[1, 2, 3]` since 2026-09-01. Expect:
    - game 1: `peakCcu` 1,000 with `peakDay` 2026-10-19, `daily` holding only 2026-10-19, `earlierNames`
      `["Skip a Stone"]`, `sources` `["search"]`;
    - game 2: present, with `peakCcu` null and `daily` `[]`;
    - id 3: absent.

- [ ] **Step 2: Run it**: `npx vitest run src/db/concept.db.test.ts` is skipped locally. Check that it compiles with `npm run typecheck`, which FAILS (module missing).

- [ ] **Step 3: Implement `readConceptHistory`.**

- [ ] **Step 4: Typecheck passes; commit `feat(db): read the radar's history of a concept's attempts`.** The suite runs in CI with Task 5's pull request.

### Task 4: Orchestration

**Files:**
- Create: `src/lib/concept/check.ts`
- Test: `src/lib/concept/check.test.ts`

**Interfaces:**
- Consumes: `relevanceWords`, `isRelevant` (Task 1); `diagnose`, `summarize`, the types and `CONCEPT_CHECK_CONFIG` (Task 2); `RobloxApi` (`src/lib/api/roblox.ts`).
- Produces:

```ts
export interface ConceptCheckDependencies {
  api: Pick<RobloxApi, "searchGames" | "getGameDetails" | "getGameVotes">;
  // Absent when no database is configured; a rejection becomes { status: "failed" }, never an exception.
  readHistory?: (universeIds: number[], since: Date) => Promise<Map<number, ConceptHistory>>;
  // Why readHistory is absent, shown in the report.
  historySkippedReason?: string;
  now: Date;
}
export async function runConceptCheck(phrases: string[], dependencies: ConceptCheckDependencies, config = CONCEPT_CHECK_CONFIG): Promise<ConceptReport>;
```

  - Each phrase is searched for up to `searchPagesPerPhrase` pages, following `nextPageToken`.
  - A search that rejects adds `{ phrase, error }` to `failures` and keeps the pages it already got.
  - Details and votes are fetched once for every unique result. A rejection there rejects `runConceptCheck`: there is
    nothing to show without them.
  - When `relevanceWords` is empty, every result is kept.
  - `since` is `now` minus `historyDays`.

- [ ] **Step 1: Write the failing tests** with a fake API (plain object, no mocking library).
  - `"merges results across phrases and pages"`:
    - "stone skipping" page 1 returns ids 1 and 2 with token `p2`, and page 2 returns ids 2 and 3 with token `p3`;
      `p3` is never requested;
    - "skip stones" returns id 1;
    - details return 1 (`Skip a Stone`), 2 (`Egg Tycoon`) and 4 (not searched, ignored), but not 3.
    - Expect: one attempt (id 1), whose `matchedPhrases` holds both phrases; `summary.hidden` 1 and
      `summary.unavailable` 1.
  - `"reports a failed search and keeps the other phrases"`: the first phrase rejects with `Error("HTTP 429")`. Expect
    `failures` to be `[{ phrase: "stone skipping", error: "HTTP 429" }]`, with the second phrase's attempts present.
  - `"keeps every result when the phrases have no usable words"`: phrase "타일" with a result titled `시퀀스 타일`, which
    stays an attempt.
  - `"reports history it could not read"`: `readHistory` rejects with `Error("connect ECONNREFUSED")`. Expect
    `history` to be `{ status: "failed", error: "connect ECONNREFUSED" }` and the attempts to have `history: null`.
  - `"skips history without a reader"`: expect `{ status: "skipped", reason: "DATABASE_URL is not set" }`, where the
    reason comes from `historySkippedReason`.
  - `"finds no attempt"`: every search returns no game. Expect `attempts` `[]` and `summary.leader` null.

- [ ] **Step 2: Run them to see them fail**: `npx vitest run src/lib/concept/check.test.ts`, FAIL.

- [ ] **Step 3: Implement `runConceptCheck`.** The order is: search, details and votes, relevance, history, `diagnose`, `summarize`. Sort attempts by `created`, then by `universeId`.

- [ ] **Step 4: Run them to see them pass**, then commit `feat(concept): check a concept across searches, details, votes and history`.

### Task 5: Report, command and documentation

**Files:**
- Create: `src/lib/concept/report.ts`, `scripts/concept.ts`
- Modify: `package.json` (script `"concept": "tsx scripts/concept.ts"`), `README.md` (commands table, after `npm run status`), `docs/operations.md` ("Analysis sessions": how to run it with the tunnel)
- Test: `src/lib/concept/report.test.ts`

**Interfaces:**
- Consumes: `runConceptCheck` (Task 4), `readConceptHistory` (Task 3), `RobloxClient`, `getDatabase`, `closeDatabaseWithin`, `assertNotLegacyDatabase`, and `formatCount` and `formatPercent` (`src/lib/format.ts`).
- Produces: `formatConceptReport(report: ConceptReport, rules = CONCEPT_CHECK_CONFIG.diagnosis): string`.

- [ ] **Step 1: Write the failing report tests** on a fixed `ConceptReport`: attempts A, C and D from Task 2, `hidden` 40, `unavailable` 1, and history `{ status: "skipped", reason: "DATABASE_URL is not set" }`. The output contains:
  - `Concept check: "stone skipping", "skip stones"`;
  - `3 attempts (40 unrelated results hidden, 1 unavailable)`;
  - `First attempt: Skip a Rock! (2026-01-05)`;
  - `Leader: +1 Stone Skipping, 17,579 playing, 67,362,222 visits`;
  - `History: not read (DATABASE_URL is not set)`;
  - the rows in creation order, dates as `YYYY-MM-DD`, the like ratio as a percentage with its vote count, and `—`
    for a missing value;
  - a legend built from `rules`, with `no audience: under 10,000 visits`, `liked but stuck: at least 85% likes on 20
    or more votes, under 100 playing`, `fading: playing at most 10% of a tracked peak of 1,000 or more` and `leader:
    most playing, or most visits when none plays`.

  A second test: an empty report prints `No attempt found` and the search failures (`Search failed for "x": HTTP 429`).

- [ ] **Step 2: Run them to see them fail**, implement `formatConceptReport`, and run them to see them pass.

- [ ] **Step 3: Write `scripts/concept.ts`.**
  - Usage: `npm run concept -- [--json] <phrase>...`. Without a phrase, print the usage and exit 1.
  - When `DATABASE_URL` is set, open `getDatabase("radar-concept", { statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs, lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs, settings: { default_transaction_read_only: "on" } })`, run `assertNotLegacyDatabase`, and pass `readHistory`. Otherwise pass `historySkippedReason: "DATABASE_URL is not set"`.
  - Print `formatConceptReport`, or `JSON.stringify(report, null, 2)` with `--json`.
  - Exit codes: 0, or 1 when every phrase's search failed or `runConceptCheck` rejected (logged with `logger.error`).
  - Always end with `closeDatabaseWithin`.

- [ ] **Step 4: Document the command.**
  - **README.** Add one row to the commands table: the command searches Roblox from the machine it runs on and must not
    run on the server. It reads the radar's history when `DATABASE_URL` points to it (the analysis tunnel). It never
    writes.
  - **`docs/operations.md`, "Analysis sessions".** Add the tunnel, then:

    ```bash
    DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npm run concept -- "stone skipping" "skip stones"
    ```

- [ ] **Step 5: Validate**: `npm run validate`, where lint, typecheck, test and build all pass.

- [ ] **Step 6: Live check against production, read-only.**
  1. Open the tunnel: `ssh -f -N -L 15432:/var/run/postgresql/.s.PGSQL.5432 radar-analysis`.
  2. Run the documented command with "stone skipping", "skip stones" and "skipping stones".
  3. Expected:
     - `+1 Stone Skipping` is the leader;
     - `Skip a Stone!` and `🏞️ Skip a stone` are "liked but stuck";
     - the 6,720-visit `Skip A Stone` is "no audience";
     - tracked games show their first sighting and peak;
     - `Egg Skipping` and the `+1 … Skipping` copies are listed.
  4. Close the tunnel. Write the numbers and any threshold change in the execution notes below.

- [ ] **Step 7: Commit, open a pull request, watch CI** (it runs `src/db/concept.db.test.ts`), then fast-forward `main` once it is green.

```bash
git commit -m "feat(concept): print a concept check from the command line"
```

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)

- **Task 1** (`bd44c2e`, `45f7086`): `titleWords` and its stop words moved to `src/lib/title.ts` unchanged.
- **Task 3** (`df4ed25`): the database suite runs only in CI; it ran on the pull request of Task 5.
- **Task 4** (`79ab5f5`): one more test covers the history that was read (window start, fading from the history peak).
- **Task 5**, live checks of "stone skipping", "skip stones" and "skipping stones" on 2026-10-26 at 16:57 and 16:59 UTC:
  - 120 search results, 22 attempts kept, 98 hidden, none unavailable;
  - the first attempt is `Squid Game | Glass Stepping Stone` (2021), a false friend on the word "stone"; the relevance
    filter keeps such games on purpose, and Claude reads past them;
  - `+1 Stone Skipping` is the leader (17,590 playing, 67.4 million visits). The radar first saw it on 2026-09-29, 24
    days after its creation, and its tracked peak is 75,862;
  - `Skip a Stone!` (9,309 visits, 88% on 24 votes), `🏞️ Skip a stone` (40,186, 93% on 681) and `+1 Throw A Rock`
    (174,791, 93% on 441) are liked but stuck;
  - the 6,720-visit `Skip A Stone` has no audience;
  - `Egg Skipping` was first seen on 2026-10-21 and peaked at 4,668.
  - Threshold change: `[NEW]Stone Miner Evolution` (8.7 million visits, 91% likes, 2 playing) came out liked but
    stuck. The design says "few visits or players", so `stuckMaximumVisits` (1,000,000) was added.
- **Final review** (fixed in one pass, each with a test seen failing first):
  - relevance matches words of Chinese, Japanese and Korean inside titles and keeps their two-letter words, and a
    phrase with no usable word keeps its own results even beside other phrases: `["tile sequence", "타일"]` hid
    `시퀀스 타일`;
  - "no audience" also needs fewer than 100 players (`noAudienceMaximumPlayers`): a new attempt with 8,000 visits and
    400 players was labelled no audience;
  - the leader line shows its tracked peak and day, the trend the spec asks for;
  - renamed attempts list their earlier titles under the table.

