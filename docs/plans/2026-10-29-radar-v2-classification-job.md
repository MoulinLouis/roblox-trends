# Classification job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `classify` job on the server classifies every tracked game with Claude Sonnet 5.5 and prompt v3 through the Message Batches API, keeps each classification in the database, reclassifies a game when its title changes, and applies the owner's corrections, so that analysis sessions can read each game's format from one view.

**Architecture:** An hourly systemd job, built like the other collectors (`JobDefinition`, `executeJob`, Healthchecks heartbeat and quality checks).
- **Each run:** it syncs the overrides file into a table, collects the batch it submitted earlier once that batch has ended, then submits the next batch: at most 1,000 games, chosen in TypeScript from the candidates the database returns.
- **Tables:** `classification_batches` holds one row per batch, written before the submission so that no batch is paid twice. `classifications` holds one row per game and batch (pending, classified or failed).
- **The `game_classifications` view:** the latest classification of each game, with the owner's overrides applied.
- **Reuse:** the request, prompt, schema, cost and thumbnail code come from the trial, in `src/lib/classify/`.

**Tech Stack:** TypeScript, Node, Vitest, drizzle-orm with PostgreSQL 18 and TimescaleDB, `@anthropic-ai/sdk` (Message Batches, structured outputs, vision), `sharp`, systemd, Healthchecks.io.

**Spec:**
- `docs/plans/2026-10-26-radar-v2-phase-2-design.md`, section 5 ("Reclassification", "Overrides and vocabulary merges", "Operations");
- `docs/plans/2026-10-20-radar-v2-design.md`, section 4;
- the execution notes of `docs/plans/2026-10-28-radar-v2-classification-trial.md`, for the choice of model and prompt.

**Out of scope (next plan):**
- `format_stats` and the vocabulary merges it reads. They come once the backfill has filled the table, because the phase thresholds and the check against the owner's eye (design, section 6) must be measured on production classifications.
- The dashboard's classification card, deferred by the design.

## Global Constraints

- **Language and layout.**
  - Source code, identifiers, comments, tests and docs are in English (`AGENTS.md`).
  - Domain logic goes in `src/lib`, persistence in `src/db`, units and shell scripts in `ops`.
  - Every interval, cap and threshold lives in `JOB_CONFIG.classify` or `CLASSIFICATION_CONFIG` in `src/lib/config.ts`.
- **Model and prompt.** The model is `claude-sonnet-5-5`, with prompt v3 (`CLASSIFICATION_PROMPT_VERSION = 3`), both chosen by the owner on 2026-10-29.
- **The key.**
  - It is the one the owner already uses on their machine; the owner decided on 2026-10-29 to keep a single key.
  - The owner writes it to `/etc/radar/anthropic.env` (`root 600`, one line `ANTHROPIC_API_KEY=...`).
  - Only the drop-in `radar-job@classify.service.d/anthropic.conf` loads it.
  - Nobody else reads it, prints it or logs it. Claude never sees it.
- **No double payment.** A batch row is written before `batches.create`, with `maxRetries: 0`.
  - A 4xx answer deletes the row: no batch exists.
  - Any other error keeps the row without an id, and every later run refuses to submit until the owner settles it with the runbook.
- **Spend is capped twice:** 1,000 games per batch, and 6,000 requests in any 24 hours. Only one batch is open at a time.
- **The SDK client is built lazily, inside the classify run.** `new Anthropic()` throws without a key, and `createJobs()` runs for every job.
- **Database suites (`*.db.test.ts`) run only in CI**, since there is no local PostgreSQL. Push the branch to see them run on the pull request.
- **Before handing off,** run `npm run lint`, `npm run typecheck`, `npm run test` and `npm run build`.
- **Production changes only through the repository and the runbook.** A push to `main` deploys, and needs the owner's approval.

## Review Focus

- **A crash or timeout around `batches.create`.** No second batch may be submitted while the first one's id is unknown (Task 5).
- **A run while the previous batch is still processing.** It submits nothing (Task 5).
- **A game whose title changes only inside brackets.** It is not reclassified; a real title change is (Task 3).
- **A game the model keeps refusing.** It is retried after 24 hours and given up after 3 failures with the same title, so it cannot cost money every hour (Task 3).
- **Expired or canceled requests.** They are not billed and must not count as failures: their games go back to the pool (Task 5).
- **Other jobs.** They must keep starting without an Anthropic key (Task 6).
- **Overrides.** They win over every classification, including in the view (Tasks 2 and 4).

## Decisions taken in this plan (open to the owner's correction)

- **Reclassification compares titles, not content fingerprints.**
  - Each classification stores the title it classified. A game is stale when `titleKey(stored title)` differs from `titleKey(current title)`, where `titleKey` is the title part of the content fingerprint.
  - The design asks to reclassify on title changes only. A stored title also survives a later change of the normalizer, which a stored fingerprint and version would not, without reclassifying every game.
- **A prompt bump does not reclassify by itself.** `JOB_CONFIG.classify.minimumPromptVersion` names the oldest acceptable version. Raising it reclassifies the older classifications at the caps above, about $30 for the whole radar.
- **Batch size.** At most 1,000 games per batch and 6,000 a day.
  - The backfill of about 13,650 games takes about 2.5 days.
  - A runaway costs at most about $13 a day at Sonnet's measured $0.0022 a game.
  - 1,000 requests with JPEG thumbnails weigh about 70 MB, well under the 256 MB limit of a batch.
- **Order of the queue.** Never-classified games go first, then retitled games, then outdated ones. Within each group, the busiest go first, by `last_ccu`.
- **Failures.** A failed game waits 24 hours before a retry, and is given up after 3 failed attempts on the same title. A new title resets the count.
- **Expired and canceled requests** release their games at once, since nothing was classified or billed.
- **Overrides** are copied into `classification_overrides` at the start of every run, so a deploy applies them within the hour. The view applies them field by field. An override wins even after a reclassification.
- **The schedule.** The timer runs at `*:46:30`, a minute no other job uses. The job adds two Healthchecks checks, for 18 of the 20 free checks.
- **Spend limit.** With a single key, a spend limit in the Anthropic console would cap the owner's own use too. The caps above are the guard; a console limit remains the owner's option.

---

### Task 1: Shared pieces for the job

The trial's code is reused as it stands. This task only separates what the production job needs from what the trial sample carries, and pins the prompt.

**Files:**
- Modify: `src/lib/classify/types.ts`, `src/lib/classify/prompt.ts`, `src/lib/classify/request.ts`
- Create: `src/lib/classify/batches.ts` (`BatchApi` and `rejectedByApi`, moved from `trial.ts`)
- Modify: `src/lib/classify/trial.ts` (imports them)
- Modify: `src/lib/fingerprint.ts` (export `titleKey`)
- Test: `src/lib/classify/prompt.test.ts`, `src/lib/fingerprint.test.ts`

- [ ] **Step 1: Split the input type.** In `types.ts`, the model needs only the game's text and thumbnail:

```ts
// What the model is shown of a game.
export interface ClassifiedGame {
  universeId: number;
  name: string;
  description: string;
  genre: string | null;
  thumbnailUrl: string | null;
}

// A game of a trial sample: the classified game, plus what the sample drew it by.
export interface ClassificationInput extends ClassifiedGame {
  robloxCreatedAt: string; // ISO 8601
  peakCcu: number; // all-time daily peak in game_daily_all, 0 when the radar has none
  stratum: string; // the sample stratum that selected the game
}
```

`classificationUserContent` and `classificationRequest` take a `ClassifiedGame`. The trial keeps passing `ClassificationInput`, which extends it.

- [ ] **Step 2: Move `BatchApi` and `rejectedByApi`** from `trial.ts` to `batches.ts`, unchanged. Export both, and import them in `trial.ts`. `npx vitest run src/lib/classify` passes unchanged.

- [ ] **Step 3: Export `titleKey` from `fingerprint.ts`.** Make `contentFingerprint` use it; the value is unchanged, so `CONTENT_FINGERPRINT_VERSION` stays 2:

```ts
// The title as reclassification compares it: what contentFingerprint keeps of the title.
export function titleKey(name: string): string {
  return normalizeTitle(name).toLowerCase();
}
```

Test, in `fingerprint.test.ts`:
- `titleKey("[🎃] Steal a Brainrot [UPD 3]")` equals `titleKey("Steal a Brainrot")`;
- `titleKey("Steal a Brainrot")` differs from `titleKey("Steal an Egg")`.

- [ ] **Step 4: Pin the prompt.**
  - Production stores the prompt version with each classification, so an edit without a bump would mix two prompts under one number.
  - Compute the hash with `npx tsx -e 'import("./src/lib/classify/prompt.ts").then((m) => console.log(m.classificationPromptHash()))'`.
  - Add this test to `prompt.test.ts`:

```ts
// Changing the prompt or the schema changes this hash: bump CLASSIFICATION_PROMPT_VERSION in the same commit, then update
// the hash and the version here.
it("is the text of the current prompt version", () => {
  expect(CLASSIFICATION_PROMPT_VERSION).toBe(3);
  expect(classificationPromptHash()).toBe("<the printed hash>");
});
```

- [ ] **Step 5: Run and commit.**
  - Run `npx vitest run src/lib/classify src/lib/fingerprint.test.ts && npm run typecheck`. Expect PASS.
  - Commit `refactor(classify): share the classified game, the batch API and the title key with the job`.

### Task 2: Tables and the `game_classifications` view

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0011_classifications.sql` (generated), `drizzle/0012_game_classifications.sql` (custom), and the files drizzle-kit adds to `drizzle/meta`
- Test: `src/db/classifications.db.test.ts` (created in Task 4; the view's test goes there)

- [ ] **Step 1: Add the tables to `schema.ts`.** Use the file's helpers `timestamptz` and `id64`; import `ClassificationModel` and the field type from `@/lib/classify`:

```ts
export type ClassificationStatus = "pending" | "classified" | "failed";

// One row per batch, written before the batch is submitted: anthropic_id stays null until the API returns it, and a row
// left without one blocks later submissions (docs/operations.md, "Classification").
export const classificationBatches = pgTable(
  "classification_batches",
  {
    id: uuid("id").primaryKey(),
    anthropicId: text("anthropic_id").unique(),
    model: text("model").$type<ClassificationModel>().notNull(),
    promptVersion: integer("prompt_version").notNull(),
    requests: integer("requests").notNull(),
    submittedAt: timestamptz("submitted_at").notNull(),
    collectedAt: timestamptz("collected_at"),
    costUsd: real("cost_usd"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [index("classification_batches_submitted_idx").on(table.submittedAt)],
);

// One row per game and batch. The fields are null until the batch is collected, and stay null on a failure.
export const classifications = pgTable(
  "classifications",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => classificationBatches.id, { onDelete: "cascade" }),
    universeId: id64("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    // The title sent: reclassification compares its titleKey with the game's current one.
    name: text("name").notNull(),
    hadThumbnail: boolean("had_thumbnail").notNull(),
    status: text("status").$type<ClassificationStatus>().notNull(),
    error: text("error"),
    reason: text("reason"),
    family: text("family"),
    template: text("template"),
    rewardLoop: text("reward_loop"),
    coreAction: text("core_action"),
    theme: text("theme"),
    setting: text("setting"),
    progression: text("progression"),
    social: text("social"),
    confidence: text("confidence"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.universeId] }),
    index("classifications_game_idx").on(table.universeId, table.finishedAt),
  ],
);

// A copy of src/lib/classify/overrides.ts, rewritten by every classify run. No foreign key: a correction must survive
// whatever happens to the game row.
export const classificationOverrides = pgTable(
  "classification_overrides",
  {
    universeId: id64("universe_id").notNull(),
    field: text("field").$type<ClassificationOverride["field"]>().notNull(),
    value: text("value").notNull(),
    reason: text("reason").notNull(),
    decidedAt: text("decided_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.field] })],
);
```

- [ ] **Step 2: Generate the migration.** Run `npm run db:generate -- --name=classifications`. Expect `drizzle/0011_classifications.sql`, with three `CREATE TABLE` statements, their indexes and the two foreign keys.

- [ ] **Step 3: Write the view in a custom migration.** Run `npx drizzle-kit generate --custom --name=game_classifications`, then fill `drizzle/0012_game_classifications.sql` with:

```sql
-- The current classification of each game, with the owner's overrides applied field by field (src/lib/classify/overrides.ts,
-- copied into classification_overrides by every classify run). A game with overrides and no classification yet still
-- has a row. Analysis sessions and format_stats read this view, never the tables.
CREATE VIEW game_classifications AS
WITH latest AS (
  SELECT DISTINCT ON (c.universe_id)
    c.universe_id, c.name, c.reason, c.family, c.template, c.reward_loop, c.core_action, c.theme, c.setting,
    c.progression, c.social, c.confidence, c.finished_at, b.model, b.prompt_version
  FROM classifications c
  JOIN classification_batches b ON b.id = c.batch_id
  WHERE c.status = 'classified'
  ORDER BY c.universe_id, c.finished_at DESC
),
overridden AS (
  SELECT universe_id,
    max(value) FILTER (WHERE field = 'family') AS family,
    max(value) FILTER (WHERE field = 'template') AS template,
    max(value) FILTER (WHERE field = 'rewardLoop') AS reward_loop,
    max(value) FILTER (WHERE field = 'coreAction') AS core_action
  FROM classification_overrides
  GROUP BY universe_id
)
SELECT
  coalesce(l.universe_id, o.universe_id) AS universe_id,
  coalesce(o.family, l.family) AS family,
  coalesce(o.template, l.template) AS template,
  coalesce(o.reward_loop, l.reward_loop) AS reward_loop,
  coalesce(o.core_action, l.core_action) AS core_action,
  l.theme, l.setting, l.progression, l.social, l.confidence, l.reason,
  l.name AS classified_name, l.model, l.prompt_version, l.finished_at AS classified_at,
  o.universe_id IS NOT NULL AS overridden
FROM latest l
FULL JOIN overridden o ON o.universe_id = l.universe_id;
```

- [ ] **Step 4: Check and commit.**
  - Run `npm run typecheck`.
  - `src/db/migrate.db.test.ts` and `src/db/schema.db.test.ts` run in CI. Read them, and add the new tables where they list tables.
  - The analysis role receives `SELECT` on the new tables and the view through the default privileges in `ops/postgresql/database.sql`; nothing to grant.
  - Commit `feat(db): store classifications, their batches and the owner's overrides`.

### Task 3: Choosing the games to classify

A pure function, tested locally. The database returns every game with its classification history (Task 4); this function decides.

**Files:**
- Create: `src/lib/classify/selection.ts`
- Test: `src/lib/classify/selection.test.ts`
- Modify: `src/lib/config.ts` (add `JOB_CONFIG.classify`)

- [ ] **Step 1: Add the configuration** to `JOB_CONFIG`, after `thumbnails`:

```ts
  // The classify job (docs/plans/2026-10-29-radar-v2-classification-job.md). The owner chose Sonnet 5.5 and prompt v3 on
  // 2026-10-29: $0.0022 a game in batches, with the cached prompt read in 99 of 100 requests in every run.
  classify: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    model: "claude-sonnet-5-5",
    // 1,000 requests with their JPEG thumbnails weigh about 70 MB, under the 256 MB limit of a batch. One open batch at a
    // time, so at most one per hourly run.
    maximumGamesPerBatch: 1_000,
    // Over the last 24 hours of submissions: the backfill of about 13,650 games takes about 2.5 days, and a runaway costs
    // at most about $13 a day.
    maximumRequestsPerDay: 6_000,
    // Classifications from an older prompt count as outdated. Raising it reclassifies them at the caps above.
    minimumPromptVersion: 3,
    // A failed game waits this long, and is given up after this many failures with the same title.
    retryFailedAfterHours: 24,
    maximumFailedAttempts: 3,
    // A collected batch with a larger share of failed games degrades the run.
    maximumFailedShare: 0.05,
  },
```

- [ ] **Step 2: Write the failing tests.** In `selection.test.ts`, with `candidate(values)` building a `ClassificationCandidate`:
  - never-classified games come first, busiest first, then retitled games, then outdated ones;
  - a game classified with the same title (the brackets and update markers differ) is not chosen;
  - a pending game is never chosen;
  - the result stops at `limit`, and `counts` reports each group in full, before the cap;
  - a game whose last failure, under its current title, is younger than `retryFailedAfterHours` waits;
  - a game with `maximumFailedAttempts` failures under its current title is given up;
  - failures under an earlier title do not count;
  - a classification below `minimumPromptVersion` counts as outdated.

- [ ] **Step 3: Run them to see them fail.** `npx vitest run src/lib/classify/selection.test.ts`, FAIL.

- [ ] **Step 4: Implement `selection.ts`:**

```ts
import { titleKey } from "@/lib/fingerprint";
import type { ClassifiedGame } from "./types";

// A tracked game with what the radar knows of its classifications (src/db/classifications.ts).
export interface ClassificationCandidate extends ClassifiedGame {
  lastCcu: number;
  pending: boolean;
  // The latest successful classification, or null.
  classified: { name: string; promptVersion: number } | null;
  // Failures since the latest success, oldest first.
  failures: { name: string; finishedAt: Date }[];
}

export type SelectionReason = "new" | "retitled" | "outdated";

export interface SelectionOptions {
  now: Date;
  limit: number;
  minimumPromptVersion: number;
  retryFailedAfterHours: number;
  maximumFailedAttempts: number;
}

export interface Selection {
  games: ClassifiedGame[];
  // Every game due, before the limit, by reason; and the games held back by their failures.
  counts: Record<SelectionReason | "waitingRetry" | "givenUp", number>;
}

const order: Record<SelectionReason, number> = { new: 0, retitled: 1, outdated: 2 };

export function selectGamesToClassify(candidates: readonly ClassificationCandidate[], options: SelectionOptions): Selection {
  const counts: Selection["counts"] = { new: 0, retitled: 0, outdated: 0, waitingRetry: 0, givenUp: 0 };
  const due: { candidate: ClassificationCandidate; reason: SelectionReason }[] = [];
  for (const candidate of candidates) {
    if (candidate.pending) continue;
    const reason = dueReason(candidate, options.minimumPromptVersion);
    if (reason === null) continue;
    // Only failures under the current title count: a new title deserves a fresh try.
    const key = titleKey(candidate.name);
    const failures = candidate.failures.filter((failure) => titleKey(failure.name) === key);
    if (failures.length >= options.maximumFailedAttempts) {
      counts.givenUp += 1;
      continue;
    }
    const lastFailure = failures.at(-1);
    if (lastFailure && options.now.getTime() - lastFailure.finishedAt.getTime() < options.retryFailedAfterHours * 3_600_000) {
      counts.waitingRetry += 1;
      continue;
    }
    counts[reason] += 1;
    due.push({ candidate, reason });
  }
  due.sort(
    (left, right) =>
      order[left.reason] - order[right.reason] ||
      right.candidate.lastCcu - left.candidate.lastCcu ||
      left.candidate.universeId - right.candidate.universeId,
  );
  const games = due.slice(0, options.limit).map(({ candidate }) => ({
    universeId: candidate.universeId,
    name: candidate.name,
    description: candidate.description,
    genre: candidate.genre,
    thumbnailUrl: candidate.thumbnailUrl,
  }));
  return { games, counts };
}

function dueReason(candidate: ClassificationCandidate, minimumPromptVersion: number): SelectionReason | null {
  if (candidate.classified === null) return "new";
  if (titleKey(candidate.classified.name) !== titleKey(candidate.name)) return "retitled";
  if (candidate.classified.promptVersion < minimumPromptVersion) return "outdated";
  return null;
}
```

- [ ] **Step 5: Run and commit.**
  - Run the tests and `npm run typecheck`. Expect PASS.
  - Commit `feat(classify): choose the games to classify, retitled and failed ones included`.

### Task 4: Persistence

**Files:**
- Create: `src/db/classifications.ts`
- Test: `src/db/classifications.db.test.ts` (CI)

- [ ] **Step 1: Write the failing database tests.** Build them like `src/db/concept.db.test.ts`, with `upsertGameDetails` and `gameDetail` from `@/test/fixtures`:
  - `syncClassificationOverrides` writes the given overrides and, on a second call, removes the ones no longer given;
  - `readClassificationCandidates` returns every game with:
    - `classified` from its latest successful row (title and the batch's prompt version);
    - `pending` while a pending row exists;
    - `failures` only after the latest success, oldest first;
  - `insertSubmittingBatch` writes the batch without an id and one pending row per game, in one transaction;
  - `markBatchSubmitted` sets the id; `deleteBatch` removes the batch and its rows;
  - `readOpenBatches` lists the batches not collected, with and without an id;
  - `storeBatchResults` stores fields and usage for classified games, the error for failed ones, deletes released rows, and marks the batch collected with its cost and stats;
  - `requestsSubmittedSince` sums `requests` over batches submitted after the given time;
  - **the view:**
    - `game_classifications` returns the latest classified row, with the model and the prompt version;
    - an override replaces its field only, and sets `overridden`;
    - a game with an override and no classification still has a row.

- [ ] **Step 2: Typecheck fails** (module missing). The suite runs in CI.

- [ ] **Step 3: Implement `classifications.ts`.** Signatures and the candidate query:

```ts
export interface ClassificationBatchRow {
  id: string;
  anthropicId: string | null;
  model: ClassificationModel;
  requests: number;
  submittedAt: Date;
}

export interface BatchItem { universeId: number; name: string; hadThumbnail: boolean }

export type BatchItemResult =
  | { universeId: number; status: "classified"; classification: GameClassification; usage: ClassificationUsage }
  | { universeId: number; status: "failed"; error: string; usage: ClassificationUsage | null }
  | { universeId: number; status: "released" };

// Replaces the table's content with the given overrides, in one transaction. Returns their number.
export async function syncClassificationOverrides(db: Database, overrides: readonly ClassificationOverride[]): Promise<number>;

export async function readClassificationCandidates(db: Database): Promise<ClassificationCandidate[]>;

export async function insertSubmittingBatch(
  db: Database,
  batch: { id: string; model: ClassificationModel; promptVersion: number; submittedAt: Date },
  items: readonly BatchItem[],
): Promise<void>;

export async function markBatchSubmitted(db: Database, id: string, anthropicId: string): Promise<void>;
export async function deleteBatch(db: Database, id: string): Promise<void>;
export async function readOpenBatches(db: Database): Promise<ClassificationBatchRow[]>;

// Rows of the batch without a result are released, like expired ones: nothing was classified or billed.
export async function storeBatchResults(
  db: Database,
  id: string,
  results: readonly BatchItemResult[],
  collected: { at: Date; costUsd: number; stats: Record<string, unknown> },
): Promise<void>;

export async function requestsSubmittedSince(db: Database, since: Date): Promise<number>;
```

The candidate query reads every game once. The two lateral subqueries use `classifications_game_idx`:

```sql
select g.universe_id, g.name, g.description, g.genre, g.thumbnail_url, g.last_ccu,
  exists (select 1 from classifications p where p.universe_id = g.universe_id and p.status = 'pending') as pending,
  latest.name as classified_name, latest.prompt_version as classified_prompt_version,
  coalesce(failures.items, '[]'::jsonb) as failures
from games g
left join lateral (
  select c.name, b.prompt_version, c.finished_at
  from classifications c
  join classification_batches b on b.id = c.batch_id
  where c.universe_id = g.universe_id and c.status = 'classified'
  order by c.finished_at desc
  limit 1
) latest on true
left join lateral (
  select jsonb_agg(jsonb_build_object('name', f.name, 'finishedAt', f.finished_at) order by f.finished_at) as items
  from classifications f
  where f.universe_id = g.universe_id and f.status = 'failed'
    and (latest.finished_at is null or f.finished_at > latest.finished_at)
) failures on true
```

Map `bigint` columns with `Number(...)`, and `finishedAt` with `new Date(...)`. In `storeBatchResults`:
- update the classified and failed rows inside one transaction, setting `finished_at` to `collected.at`;
- delete the released rows and the rows still pending;
- set `collected_at`, `cost_usd` and `stats` on the batch.

A loop of updates is fine at 1,000 rows.

- [ ] **Step 4: Commit and push.**
  - Typecheck passes. Commit `feat(db): read classification candidates and record batches and their results`.
  - Push, and read the CI result of the suite.

### Task 5: The classify job

**Files:**
- Create: `src/lib/jobs/classify.ts`
- Test: `src/lib/jobs/classify.db.test.ts` (CI), `src/lib/jobs/classify.test.ts` (local, for what needs no database)

- [ ] **Step 1: Write the failing tests.** `classify.db.test.ts` uses a fake `BatchApi`: `create` records its requests and returns ids; `retrieve` reports `in_progress` until the test ends the batch; `results` yields the answers the test sets. Cases:
  - **First run:**
    - it submits the never-classified games, busiest first, at most `maximumGamesPerBatch`;
    - each request uses Sonnet's model, a custom id `u<id>`, and the thumbnail when the download works;
    - it records the batch with its id and the pending rows.
  - **A run while the batch is processing** submits nothing and reports `waitingBatches: 1`.
  - **Collection:**
    - once the batch has ended, the run stores the classifications and the batch's cost, then submits the next games;
    - a refused answer becomes a failed row;
    - an expired or canceled answer, or a game without a result, releases its game, which is submitted again in the same run.
  - **The run's status:** above `maximumFailedShare` failed games, the run is `degraded`.
  - **A retitled game** is classified again; a bracket-only change is not.
  - **The daily cap:** requests submitted in the last 24 hours cap the next batch at `maximumRequestsPerDay` minus them.
  - **A 4xx answer from `create`** (`{ status: 400 }`) deletes the batch and its rows and fails the run.
  - **An error without a status from `create`:**
    - the batch row stays without an id and the run fails;
    - the next run does not call `create`, is `degraded`, and reports `blockedBatch` with its submission time.
  - **Overrides:** the run copies the given overrides into `classification_overrides`.

  `classify.test.ts`: `createClassifyJob` does not call the `batches` factory when it is built, so `createJobs()` works without a key.

- [ ] **Step 2: Run them to see them fail** (locally: `classify.test.ts`, then typecheck).

- [ ] **Step 3: Implement `classify.ts`:**

```ts
export interface ClassifyDependencies {
  // Built inside the run: the SDK client throws without ANTHROPIC_API_KEY, which only the classify unit loads.
  batches: () => BatchApi;
  downloadThumbnail: (url: string | null) => Promise<Buffer | null>;
  overrides?: readonly ClassificationOverride[];
  newId?: () => string;
}

export function createClassifyJob(dependencies: ClassifyDependencies): JobDefinition {
  const config = JOB_CONFIG.classify;
  return {
    name: "classify",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const overrides = await syncClassificationOverrides(db, dependencies.overrides ?? CLASSIFICATION_OVERRIDES);
      const api = dependencies.batches();
      const open = await readOpenBatches(db);
      // A submission whose answer was lost may have created a batch: nothing is submitted until the owner settles it.
      const blocked = open.find((batch) => batch.anthropicId === null);
      const collected: CollectedBatch[] = [];
      let waitingBatches = 0;
      for (const batch of open) {
        if (batch.anthropicId === null) continue;
        const { processing_status: status } = await api.retrieve(batch.anthropicId);
        if (status === "ended") collected.push(await collectBatch(db, api, batch, now));
        else waitingBatches += 1;
      }
      if (blocked) logger.error("A classification batch submission was not confirmed", { batch: blocked.id, submittedAt: blocked.submittedAt });

      let submitted: SubmittedBatch | null = null;
      let selection: Selection["counts"] | null = null;
      if (!blocked && waitingBatches === 0) {
        const used = await requestsSubmittedSince(db, new Date(now.getTime() - 24 * 3_600_000));
        const limit = Math.min(config.maximumGamesPerBatch, config.maximumRequestsPerDay - used);
        const chosen = selectGamesToClassify(await readClassificationCandidates(db), {
          now,
          limit: Math.max(limit, 0),
          minimumPromptVersion: config.minimumPromptVersion,
          retryFailedAfterHours: config.retryFailedAfterHours,
          maximumFailedAttempts: config.maximumFailedAttempts,
        });
        selection = chosen.counts;
        if (chosen.games.length > 0) submitted = await submitBatch(db, api, chosen.games, now, dependencies);
      }
      const failedShare = Math.max(0, ...collected.map((batch) => batch.failed / Math.max(batch.requests, 1)));
      return {
        status: blocked || failedShare > config.maximumFailedShare ? "degraded" : "success",
        stats: {
          overrides,
          collected: collected.length,
          classified: sum(collected, "classified"),
          failed: sum(collected, "failed"),
          released: sum(collected, "released"),
          costUsd: sum(collected, "costUsd"),
          cacheReads: sum(collected, "cacheReads"),
          waitingBatches,
          submitted: submitted?.requests ?? 0,
          withoutThumbnail: submitted?.withoutThumbnail ?? 0,
          selection,
          blockedBatch: blocked ? { id: blocked.id, submittedAt: blocked.submittedAt.toISOString() } : null,
        },
      };
    },
  };
}
```

`submitBatch`:
- downloads the thumbnails, `CLASSIFICATION_CONFIG.thumbnailDownloadConcurrency` at a time (use `chunk` from `@/lib/arrays`), and builds one `classificationRequest(config.model, game, image)` per game;
- calls `insertSubmittingBatch` with a fresh UUID (`randomUUID` by default), then `api.create({ requests }, { maxRetries: 0 })`;
- on success, calls `markBatchSubmitted`. On a `rejectedByApi` error, calls `deleteBatch`. Either way, it rethrows the error, so the run fails and alerts;
- logs the batch id before `markBatchSubmitted`, as the trial does, so a paid batch's id is in the journal even if the write fails.

`collectBatch`:
- reads every response of `api.results(anthropicId)`. For a response whose `result.type` is `expired` or `canceled`, the game is released. Otherwise it uses `readBatchResult`: a success is classified, anything else failed;
- releases the games of the batch that got no response;
- sums the cost with `classificationCostUsd(batch.model, usage, { batch: true })` over the results that carry usage, and counts the results with `cacheReadInputTokens > 0`;
- calls `storeBatchResults`, and returns the counts.

- [ ] **Step 4: Run the local tests and the typecheck; push for the database suite.** Commit `feat(jobs): classify games with Claude through the Message Batches API`.

### Task 6: Wiring, units and monitoring

**Files:**
- Modify: `src/lib/jobs/types.ts` (`JOB_NAMES` gains `"classify"`), `src/lib/jobs/registry.ts`
- Create: `ops/systemd/radar-classify.timer`, `ops/systemd/radar-job@classify.service.d/timeout.conf`, `ops/systemd/radar-job@classify.service.d/anthropic.conf`
- Modify: `ops/bin/deploy.sh` (`job_timers`), `src/lib/status-report.ts` (`WATCHED_STATS.classify`)
- Test: `src/lib/ops/systemd.test.ts`, `src/lib/ops/healthchecks-provisioning.test.ts`, the status report test

- [ ] **Step 1: Register the job.** In `registry.ts`:

```ts
createClassifyJob({
  batches: () => new Anthropic().messages.batches,
  downloadThumbnail: (url) => downloadThumbnailJpeg(url),
}),
```

Add `"classify"` to `JOB_NAMES`.

- [ ] **Step 2: Add the units.**

`ops/systemd/radar-classify.timer`:

```ini
[Unit]
Description=Radar classification every hour

[Timer]
OnCalendar=*:46:30
AccuracySec=1s
Persistent=false
Unit=radar-job@classify.service

[Install]
WantedBy=timers.target
```

`radar-job@classify.service.d/timeout.conf`:

```ini
[Service]
TimeoutStartSec=1830
```

`radar-job@classify.service.d/anthropic.conf`. systemd reads the file as root before it starts the job as `radar`. No `-` prefix: a missing key fails the unit, and `radar-job-failed@classify` alerts.

```ini
[Service]
# The Anthropic key, for the classify job only (docs/operations.md, section 3).
EnvironmentFile=/etc/radar/anthropic.env
```

In `ops/bin/deploy.sh`, add `radar-classify.timer` to `job_timers`, so a migration pauses it like the others.

- [ ] **Step 3: Tests.** The existing systemd tests cover the timer and the timeout through `JOB_NAMES`. Add these:
  - `deploy.sh` lists `radar-<job>.timer` for every name of `JOB_NAMES`;
  - only `radar-job@classify.service.d` loads `/etc/radar/anthropic.env`, and no unit loads it with a `-` prefix.

  `healthchecks-provisioning.test.ts` counts the desired checks: 18 now.

- [ ] **Step 4: Watched stats.** Add a `classify` entry to `WATCHED_STATS`: `["submitted", "classified", "failed", "released", "costUsd", "cacheReads", "waitingBatches", "blockedBatch"]`. The job tests check that each path exists in a run's stats.

- [ ] **Step 5: Validate and commit.** Run `npm run validate`. Commit `feat(ops): run the classify job every hour with its Anthropic key`.

### Task 7: Runbook and README

**Files:**
- Modify: `docs/operations.md`, `README.md`

- [ ] **Step 1: `docs/operations.md`.**
  - **Units and timer schedule.** Add the `classify` job and `radar-classify.timer` at `*:46:30`.
  - **Healthchecks checks.** Now 18 of the 20 free checks. In the provisioning section, expect 18 lines.
  - **Secrets inventory.** Add `/etc/radar/anthropic.env`: `root 600`, holds `ANTHROPIC_API_KEY=...` (the key the owner also uses on their machine), written by the owner.
  - **A new "Classification" section:**
    - **What a run does.** It copies the overrides, collects the ended batch, then submits up to 1,000 games, with 6,000 a day at most.
    - **Cost.** About $0.0022 a game, and how to read it per batch:
      `select submitted_at, requests, cost_usd, stats from classification_batches order by submitted_at desc limit 10;`.
    - **Changing a classification.** Edit `src/lib/classify/overrides.ts` and deploy; the next run applies it.
    - **Reclassifying after a prompt change.** Bump `CLASSIFICATION_PROMPT_VERSION`, update the hash test, and raise `JOB_CONFIG.classify.minimumPromptVersion`.
    - **A blocked submission** (`blockedBatch` in the run's stats, and the quality check alerts):
      1. In the Anthropic console, look for a batch created at `submittedAt`.
      2. If one exists, the owner records its id from the server shell: `sudo -u radar psql radar -c "update classification_batches set anthropic_id = '<id>' where id = '<batch>'"`. The next run collects it.
      3. If none exists: `sudo -u radar psql radar -c "delete from classification_batches where id = '<batch>'"`. Its pending rows go with it.
    - **Pausing it.** `systemctl disable --now radar-classify.timer`.
  - **Analysis sessions.** List the read queries on `game_classifications`: a game's format, the games of a family, and the share of games classified.

- [ ] **Step 2: `README.md`.** Add the job to the list of collectors and point to the runbook section.

- [ ] **Step 3: Commit.** `docs: run and recover the classify job`.

---

## Sessions after the merge

- [ ] **S1: Merge.** CI green, then the owner approves. A push to `main` deploys, and the migration pauses the job timers while it runs.
  Check:
  - the release is live (`readlink -f /opt/radar/current`);
  - `classification_batches` exists, read through the analysis tunnel.
- [ ] **S2: The key.** The owner writes the key from their own terminal: `ssh radar-prod`, then
  `sudo install -m 600 -o root -g root /dev/null /etc/radar/anthropic.env && sudo nano /etc/radar/anthropic.env`. The file holds one line, `ANTHROPIC_API_KEY=...`, the same value as `~/.config/radar/anthropic.env`.
- [ ] **S3: Checks.** The owner runs `npm run provision:healthchecks` (runbook, section 8). Expect 18 lines.
- [ ] **S4: First run, by hand.** `sudo systemctl start radar-job@classify.service`, then read its `job_runs` row:
  - it submitted 1,000 games, with about 2 % without a thumbnail (3 of 100 in review-2).
  - Then `sudo systemctl enable --now radar-classify.timer`.
- [ ] **S5: Backfill.** For about 2.5 days, read each batch's `cost_usd`, `stats` and cache reads.
  - **Expected:** about $2.2 for 1,000 games, cache reads in about 99% of requests, and less than 5% failed.
  - **If the cache falls below 50%,** compare with the trial and tell the owner before the next day.
- [ ] **S6: Notes.** The execution notes record:
  - the backfill's cost and duration;
  - the failures and their causes;
  - the new values the model proposed;
  - a check of 20 random classifications against their titles and thumbnails, shown to the owner.

  Then the `format_stats` plan.

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)

- **Late submission.** The runner's timeout is a bare `Promise.race` and does not stop a run. So the job refuses to submit more than `latestSubmissionMs` (20 min) after its start: a create cut by the process exit would lose a paid batch's id.
- **Short result streams.** Collection compares the responses read with the batch's `request_counts` and throws when fewer arrive. Otherwise a stream cut short would release, and pay again for, games already answered.
- **Duplicate answers.** The first answer per game wins.
- **Collection pass.** `npm run collect` leaves classify out on purpose (`LEFT_OUT` in `scripts/collect.ts`): it is paid and needs a key that script never loads. `orderJobs` still refuses a job that is neither ordered nor left out.
- **SDK credentials.** The installed SDK does not throw without `ANTHROPIC_API_KEY`. It falls back to a credentials profile (`~/.config/anthropic/credentials/default.json`) and fails at the first request. On the server, the drop-in has no `-`, so a missing key file fails the unit first.
- **Test isolation.** The job's DB tests initially leaked games between tests. `beforeEach` now deletes `games`, and the deletion cascades.
- **Create timeout.** `submitBatch` passes `createTimeoutMs` (5 min) as the SDK's `timeout`, so a create started at `latestSubmissionMs` ends before the runner's 30 min. A timeout is an `APIConnectionTimeoutError` with no status: `rejectedByApi` is false, the row keeps a null id and blocks, as designed. A test pins both.
- **One open batch.** A unique partial index (`classification_batches_one_open_idx`, `((true)) where collected_at is null`, migration 0013) makes the invariant structural: a second `insertSubmittingBatch` fails before `api.create`. Tests that held two open batches now collect the first, or list a single one.
- **Thumbnail wait.** A never classified game is held back while `thumbnails_checked_at` is null and its `first_observed_at` is under `thumbnailWaitHours` (6) old; `selection.waitingThumbnail` counts them. Retitled and outdated games do not wait: they were classified once already, a thumbnail was not what made them due, and the thumbnail URL is read fresh when they are submitted.
