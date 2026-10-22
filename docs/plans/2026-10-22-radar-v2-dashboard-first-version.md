# Radar v2 Dashboard First Version Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for Tasks 1–14 (repository work). Tasks 15–16 touch production and are run by the controller session itself, never by subagents.

**Goal:** Give the owner a working dashboard on `https://radar-prod.tail6e77de.ts.net` as soon as phase 1b closes, before classification: a Radar page of rising games, a Game page and a Health page, plus two collection fixes found in the 2026-10-21 checkup.

**Architecture:** Server components read PostgreSQL directly through a read-only session (`src/db/dashboard.ts`). The Radar page calls a new SQL function, `rising_games(...)` (migration `0007`), that computes the design's section 5A metrics from the hourly aggregates for any `as_of`, so analysis sessions and the dashboard share one definition. The Game page composes small queries in `src/db/game-view.ts` and pure helpers in `src/lib/dashboard`. The Health page reuses the `radar status` queries and the system check. Every threshold lives in `src/lib/config.ts`.

**Tech Stack:** Next.js 16.3 (App Router, server components, `connection()` for request-time rendering, `params`/`searchParams` as promises), React 19, drizzle-orm 0.45 over node-postgres, PostgreSQL 18 + TimescaleDB 2.30.2 (continuous aggregates `game_hourly`, `census_hourly`, view `game_daily_all`), Vitest, lucide-react.

---

## Context

- Decided with the owner on 2026-10-22: ship a first dashboard right after phase 1b instead of waiting for phases 2–3. Clusters, the classification card, similar games, the watchlist and the global date selector wait for phase 2 and later. The Radar page still takes an `asOf` for backtests (for example `+1 Stone Skipping`, universe 10765298801, first seen by v1 on 2026-09-28).
- Production checkup of 2026-10-21 23:13 UTC (7.5 h into the B7 observation): every job succeeds, coverage 96.3%, games at or above 1k CCU sampled every 10 minutes without gaps. Two defects:
  1. Rolimon's served the list of the previous slot again in 2 of 44 census runs (16:40 and 23:00 UTC): 0% of the 7,822 places changed, against about 78% in every other slot. Those CCU were stored as a new sample and the run counted as successful. A frozen Rolimon's list would pass every gate forever.
  2. `oldestTailDetailsMinutes` swings between 30 and 41,260 minutes: a game re-entering the active set brings the details of its last active day. The tail rotation itself is fine (20–30 minutes per game, measured from the observations).
- The week-over-week baseline comes from sparse v1 samples (about 6–7 hours a day, 54% coverage) until a full week of v2 data exists on 2026-10-28; games v1 never tracked have none. The Radar page shows sample sizes and says so per row.
- Branch: `dashboard`, in the worktree `/home/playfade/dev/roblox-trends/.worktrees/dashboard`, created from `radar-v2` at `4094e16`. **A push to `radar-v2` deploys to production within about 10 minutes; nothing in Tasks 1–14 pushes there.** A draft pull request `dashboard → radar-v2` runs CI on every push of `dashboard`.

# Part A: repository work (Tasks 1–14)

Rules for every task:

- Run every command from `/home/playfade/dev/roblox-trends/.worktrees/dashboard`. Stage files by name only (never `git add -A`, `git add .` or `commit -a`). Never use bare `git stash`. Never read `.env.local`. Never connect to any database: the `*.db.test.ts` suites run only in CI, against its disposable TimescaleDB service. Never push to `radar-v2` or `main`; push only `git push origin dashboard`.
- Conventional Commits, one logical change per commit.
- Locally, `npm run test` skips the database suites. After each commit: `git push origin dashboard`, then `npm run validate` (lint, typecheck, unit tests, build; it also gives CI time to register the run), then wait for CI on the pushed commit:
  ```bash
  sha=$(git rev-parse HEAD)
  id=$(gh run list --commit "$sha" --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')
  gh run watch "$id" --exit-status
  ```
  If `id` is empty, run the `gh run list` line again. A task is done only when CI is green and the log of its `npm run test` step shows the task's `*.db.test.ts` suites ran (not skipped).

### Task 1: Census stops storing a repeated Rolimon's list

**Files:**
- Modify: `src/db/job-runs.ts` (`latestRunWithStat`: optional value)
- Modify: `src/lib/jobs/census.ts`
- Test: `src/lib/jobs/census.test.ts`, `src/lib/jobs/census.db.test.ts`
- Modify: `README.md` (census quality gate), `docs/operations.md` (quality check table)

**Step 1: Write the failing unit tests**

In `src/lib/jobs/census.test.ts`, import `censusListFingerprint` with the other names from `./census` and add:

```ts
describe("censusListFingerprint", () => {
  it("does not depend on the order of the places", () => {
    expect(censusListFingerprint([listed("2", 20), listed("1", 10)])).toBe(
      censusListFingerprint([listed("1", 10), listed("2", 20)]),
    );
  });

  it("changes when a CCU, a place or the size of the list changes", () => {
    const base = censusListFingerprint([listed("1", 10), listed("2", 20)]);
    expect(censusListFingerprint([listed("1", 10), listed("2", 21)])).not.toBe(base);
    expect(censusListFingerprint([listed("1", 10), listed("3", 20)])).not.toBe(base);
    expect(censusListFingerprint([listed("1", 10)])).not.toBe(base);
  });
});
```

**Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/jobs/census.test.ts`
Expected: FAIL, `censusListFingerprint` is not exported.

**Step 3: Write the failing database tests**

In `src/lib/jobs/census.db.test.ts`, add inside the `census job` suite:

```ts
  it("does not store a list identical to the previous run's and degrades the run", async () => {
    const listed = [place(1, 500), ...filler()];
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    expect(await executeJob(censusJob(listed), database.db, minutesLater(10))).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "repeated", listed: listed.length });
    // Only the first slot holds rows: the repeated list is not a new sample.
    const rows = await database.db.select({ observedAt: censusObservations.observedAt }).from(censusObservations);
    expect(rows).toHaveLength(listed.length);
    expect(new Set(rows.map((row) => row.observedAt.toISOString()))).toEqual(new Set(["2026-10-20T14:10:00.000Z"]));
    // A list that changed is stored again.
    expect(await executeJob(censusJob([place(1, 501), ...filler()]), database.db, minutesLater(20))).toBe("success");
  });

  it("compares with the latest list read, across a failed request", async () => {
    const listed = [place(1, 500), ...filler()];
    expect(await executeJob(censusJob(listed), database.db, now)).toBe("success");
    const outage = censusJob([], {
      fetchGames: async () => {
        throw new HttpError(503, "Service Unavailable", rolimonsUrl);
      },
    });
    expect(await executeJob(outage, database.db, minutesLater(10))).toBe("degraded");
    expect(await executeJob(censusJob(listed), database.db, minutesLater(20))).toBe("degraded");
    expect(await lastRunStats()).toMatchObject({ listQuality: "repeated" });
  });
```

Add this helper next to `hoursAgo`:

```ts
  function minutesLater(minutes: number): Date {
    return new Date(now.getTime() + minutes * 60_000);
  }
```

In the existing test `degrades the run on a Rolimon's outage and keeps the last good list as the reference`, the exact `toEqual` of the outage stats gains `listFingerprint: null` (after `rejected: null`).

**Step 4: Implement**

`src/db/job-runs.ts`, replace `latestRunWithStat` (keep its callers unchanged):

```ts
// A run degraded for one reason can still hold a measurement that passed its own check, so the stat selects the run,
// not the status. Without a value, any string value of the stat selects the run. Running runs have no stats yet, and
// the stats of failed runs are not trusted.
export async function latestRunWithStat(
  db: Database,
  job: JobName,
  since: Date,
  key: string,
  value?: string,
): Promise<{ slot: Date; stats: Record<string, unknown> } | null> {
  const [run] = await db
    .select({ slot: jobRuns.slot, stats: jobRuns.stats })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, job),
        inArray(jobRuns.status, ["success", "degraded"]),
        gte(jobRuns.startedAt, since),
        value === undefined
          ? sql`jsonb_typeof(${jobRuns.stats} -> ${key}::text) = 'string'`
          : sql`${jobRuns.stats} ->> ${key}::text = ${value}::text`,
      ),
    )
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return run ?? null;
}
```

`src/lib/jobs/census.ts`:

1. Add `import { createHash } from "node:crypto";` at the top and this export after `evaluateCensusQuality`:

```ts
// The content of a Rolimon's list: its places and their CCU, in place order. Rolimon's sometimes serves the list of
// the previous slot again (2 of the first 44 runs on 2026-10-21, while about 78% of the places change between two
// slots); storing it would record those CCU as a new sample.
export function censusListFingerprint(games: readonly RolimonsGame[]): string {
  const hash = createHash("sha1");
  for (const game of [...games].sort((left, right) => Number(left.placeId) - Number(right.placeId))) {
    hash.update(`${game.placeId}:${game.ccu}\n`);
  }
  return hash.digest("hex");
}
```

2. In the outage branch's stats, add `listFingerprint: null,` after `rejected: null,`.

3. Replace the block from `const { games: listed, rejected } = list;` down to and including `const listQuality = evaluateCensusQuality(...)` with:

```ts
      // The parser only accepts canonical place ids, so Number(placeId) is exact.
      const { games: listed, rejected } = list;
      // job_runs.started_at holds wall-clock time, so the windows start from Date.now(), not from the injectable `now`.
      const baselineSince = new Date(Date.now() - config.baselineMaxAgeHours * 60 * 60 * 1000);
      // The same list as the latest one read is Rolimon's serving it again: its CCU are not a new sample, so they are
      // not stored and the run is degraded (a list frozen for an hour alerts through the quality check). Promotion
      // still uses it: its places and their CCU are real.
      const listFingerprint = censusListFingerprint(listed);
      const latestList = await latestRunWithStat(db, "census", baselineSince, "listFingerprint");
      const repeated = latestList?.stats.listFingerprint === listFingerprint;
      if (!repeated) {
        await writeCensusObservations(
          db,
          listed.map((game) => ({ placeId: Number(game.placeId), observedAt: slot, ccu: Math.round(game.ccu) })),
        );
      }
      // Baseline: the latest list of the last hours that passed this check, even in a run degraded for another reason,
      // so one truncated list never becomes the reference.
      const previous = await latestRunWithStat(db, "census", baselineSince, "listQuality", "success");
      const previousListed = typeof previous?.stats.listed === "number" ? previous.stats.listed : null;
      const listQuality = repeated
        ? "repeated"
        : evaluateCensusQuality({ listed: listed.length, rejected }, previousListed, config);
```

4. The final status becomes `listQuality !== "success" || resolutionStalled || promotionError !== undefined ? "degraded" : "success"`, and the stats gain `listFingerprint,` right after `rejected,`. Update the `listQuality` comment in the stats: `// The list check alone ("success", "degraded" or "repeated"): analysis keeps the census slots whose list passed it, and later runs compare with them.`

**Step 5: Run the unit tests**

Run: `npx vitest run src/lib/jobs/census.test.ts`
Expected: PASS.

**Step 6: Update the docs**

- `README.md`, the `census` quality gate bullet: after `…from the latest list of the last 6 hours that passed this check;` insert ` a list identical to the latest one read (Rolimon's serving the previous slot again, \`listQuality\` \`repeated\`), which is not stored;`.
- `docs/operations.md`, the `radar-<job>-quality` row of the alerts table: `a short or malformed Rolimon's list` becomes `a short, malformed or repeated Rolimon's list`.

**Step 7: Commit, push, validate, CI**

```bash
git add src/db/job-runs.ts src/lib/jobs/census.ts src/lib/jobs/census.test.ts src/lib/jobs/census.db.test.ts README.md docs/operations.md
git commit -m "fix(census): skip a Rolimon's list repeated from the previous run"
```

Then push, `npm run validate` and CI as in the rules. Expected: green, `census.db.test.ts` ran.

### Task 2: Poll reports the median tail details age

**Files:**
- Modify: `src/lib/jobs/poll.ts`, `src/lib/status-report.ts`
- Test: `src/lib/jobs/poll.test.ts`, `src/lib/jobs/poll.db.test.ts`, `src/lib/status-report.test.ts`
- Modify: `docs/operations.md` (line about `oldestTailDetailsMinutes`)

**Step 1: Write the failing unit tests**

In `src/lib/jobs/poll.test.ts`, import `medianTailDetailsMinutes` instead of `oldestTailDetailsMinutes` and replace the `oldestTailDetailsMinutes` suite with:

```ts
describe("medianTailDetailsMinutes", () => {
  const tailRequested = [
    game(5, 500, null),
    game(8, 450, minutesAgo(26 * 24 * 60), minutesAgo(30)),
    game(4, 600, minutesAgo(50)),
    game(7, 300, minutesAgo(40)),
  ];

  it("reports the median age of the details among the tail games requested, skipping never-detailed games", () => {
    expect(medianTailDetailsMinutes(tailRequested, new Set(), now)).toBe(50);
    expect(medianTailDetailsMinutes(tailRequested.slice(2), new Set(), now)).toBe(45);
    expect(medianTailDetailsMinutes(tailRequested.slice(0, 1), new Set(), now)).toBeNull();
    expect(medianTailDetailsMinutes([], new Set(), now)).toBeNull();
  });

  it("is not pinned by a game that re-enters the active set with old details", () => {
    const rotation = [20, 22, 24, 26, 28].map((minutes, index) => game(10 + index, 100, minutesAgo(minutes)));
    expect(medianTailDetailsMinutes([...rotation, game(9, 100, minutesAgo(41_260))], new Set(), now)).toBe(25);
  });

  it("leaves out the games Roblox did not answer, whose details stay old forever", () => {
    expect(medianTailDetailsMinutes(tailRequested, new Set([8]), now)).toBe(45);
    expect(medianTailDetailsMinutes(tailRequested, new Set([8, 4]), now)).toBe(40);
    expect(medianTailDetailsMinutes(tailRequested, new Set([8, 4, 7]), now)).toBeNull();
  });

  it("never reports a negative age", () => {
    expect(medianTailDetailsMinutes([game(9, 100, new Date(now.getTime() + 60_000))], new Set(), now)).toBe(0);
  });
});
```

**Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/jobs/poll.test.ts`
Expected: FAIL, `medianTailDetailsMinutes` is not exported.

**Step 3: Implement**

In `src/lib/jobs/poll.ts`, replace `oldestTailDetailsMinutes` and its comment with:

```ts
// How long the tail waits between two refreshes: the median age of the details of the tail games requested. Games
// whose details were never stored have no age, and the games Roblox did not answer are left out: their details stay old
// however often they are requested. A median, not a maximum: a game that re-enters the active set brings the details
// of its last active day (41,260 minutes on 2026-10-21), which would pin a maximum. Null when no other requested tail
// game has details.
export function medianTailDetailsMinutes(
  tailRequested: readonly ActiveUniverse[],
  unanswered: ReadonlySet<number>,
  now: Date,
): number | null {
  const ages = tailRequested
    .flatMap((game) => (game.lastDetailsAt === null || unanswered.has(game.universeId) ? [] : [game.lastDetailsAt]))
    .map((at) => Math.max(0, (now.getTime() - at.getTime()) / 60_000))
    .sort((left, right) => left - right);
  if (ages.length === 0) return null;
  const middle = Math.floor(ages.length / 2);
  return Math.round(ages.length % 2 ? ages[middle] : (ages[middle - 1] + ages[middle]) / 2);
}
```

In the run's stats, `oldestTailDetailsMinutes: oldestTailDetailsMinutes(...)` becomes `medianTailDetailsMinutes: medianTailDetailsMinutes(plan.tailRequested, new Set(missing), now)`.

In `src/lib/status-report.ts`, `WATCHED_STATS.poll.values` renames the entry to `"medianTailDetailsMinutes"`, and the comment line becomes `// medianTailDetailsMinutes shows how long the tail games wait between two refreshes; http.endpointIntervalMs shows the game`.

**Step 4: Update the other tests**

- `src/lib/status-report.test.ts`: rename every `oldestTailDetailsMinutes` to `medianTailDetailsMinutes` (fixtures and expected lines). Both names have the same length, so the wrapped lines keep their layout.
- `src/lib/jobs/poll.db.test.ts`: rename the stat everywhere; in the sorted key list, `"medianTailDetailsMinutes"` goes right after `"http"`. Recompute every expected value as a median of the requested tail games' details ages:
  - `counts only the requested games…`: only game 204 has details (50 minutes): still `50`.
  - `moves the tail games it polled behind the others…`: run 2 requests 203 (40 minutes old at that run) and 206 (20): median `30`. Expected `[50, 30, 20]`.
  - `moves a requested game that Roblox did not answer…`: run 2 again has 40 and 20: expected `[40, 30, 20]`; update the comment above it (`the second run reports the median of 203's 40 and 206's 20 minutes`).
  - The deadline test at about line 170 (`oldestTailDetailsMinutes: 30`): read its fixture; if every requested tail game holds details 30 minutes old the value stays `30`, otherwise compute the median.

**Step 5: Run the unit tests**

Run: `npx vitest run src/lib/jobs/poll.test.ts src/lib/status-report.test.ts`
Expected: PASS.

**Step 6: Update the runbook**

`docs/operations.md`, the bullet about `oldestTailDetailsMinutes` (about line 365) becomes:
`- \`medianTailDetailsMinutes\`, the median age of the details of the tail games requested (games Roblox did not answer left out), rises above its usual 20–30 minutes: the tail rotation falls behind.`

**Step 7: Commit, push, validate, CI**

```bash
git add src/lib/jobs/poll.ts src/lib/jobs/poll.test.ts src/lib/jobs/poll.db.test.ts src/lib/status-report.ts src/lib/status-report.test.ts docs/operations.md
git commit -m "fix(poll): report the median tail details age instead of the oldest"
```

### Task 3: Shared display formatting

`radar status` and the dashboard format ages and times the same way; the dashboard also needs counts, percentages and multipliers.

**Files:**
- Create: `src/lib/format.ts`
- Test: `src/lib/format.test.ts`
- Modify: `src/lib/status-report.ts` (use `formatElapsed` and `formatUtc`)

**Step 1: Write the failing tests**

`src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatCount,
  formatDay,
  formatElapsed,
  formatHours,
  formatMultiplier,
  formatPercent,
  formatUtc,
} from "./format";

const now = new Date("2026-10-22T10:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("format", () => {
  it("formats counts and shows a dash for missing values", () => {
    expect(formatCount(12_345.6)).toBe("12,346");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("formats compact numbers", () => {
    expect(formatCompact(1_000)).toBe("1K");
    expect(formatCompact(12_345)).toBe("12.3K");
    expect(formatCompact(null)).toBe("—");
  });

  it("formats multipliers with the precision their size needs", () => {
    expect(formatMultiplier(3.006)).toBe("×3.0");
    expect(formatMultiplier(0.7516)).toBe("×0.75");
    expect(formatMultiplier(12.4)).toBe("×12");
    expect(formatMultiplier(null)).toBe("—");
  });

  it("formats shares as percentages", () => {
    expect(formatPercent(0.9633)).toBe("96.3%");
    expect(formatPercent(0.003, 2)).toBe("0.30%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats elapsed time like radar status", () => {
    expect(formatElapsed(minutesAgo(3), now)).toBe("3m");
    expect(formatElapsed(minutesAgo(119), now)).toBe("119m");
    expect(formatElapsed(minutesAgo(120), now)).toBe("2h");
    expect(formatElapsed(minutesAgo(47 * 60), now)).toBe("47h");
    expect(formatElapsed(minutesAgo(48 * 60), now)).toBe("2d");
    // A clock skew never prints a negative age.
    expect(formatElapsed(new Date(now.getTime() + 60_000), now)).toBe("0m");
  });

  it("formats durations in hours", () => {
    expect(formatHours(8)).toBe("8h");
    expect(formatHours(47.6)).toBe("48h");
    expect(formatHours(72)).toBe("3.0d");
    expect(formatHours(null)).toBe("—");
  });

  it("formats instants in UTC", () => {
    expect(formatUtc(new Date("2026-10-21T23:13:30Z"))).toBe("2026-10-21 23:13 UTC");
    expect(formatDay(new Date("2026-10-21T23:13:30Z"))).toBe("Oct 21");
  });
});
```

**Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL, the module does not exist.

**Step 3: Implement**

`src/lib/format.ts`:

```ts
// Display formatting shared by `radar status` and the dashboard. Missing values show as a dash; times are UTC.
const dash = "—";
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function present(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function formatCount(value: number | null | undefined): string {
  return present(value) ? integer.format(Math.round(value)) : dash;
}

export function formatCompact(value: number | null | undefined): string {
  return present(value) ? compact.format(value) : dash;
}

// Growth ratios: two decimals below 1, one up to 10, none above.
export function formatMultiplier(value: number | null | undefined): string {
  if (!present(value)) return dash;
  return `×${value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0)}`;
}

export function formatPercent(share: number | null | undefined, digits = 1): string {
  return present(share) ? `${(share * 100).toFixed(digits)}%` : dash;
}

// Minutes up to 2 hours, hours up to 2 days, then days. A clock skew between two hosts never prints a negative age.
export function formatElapsed(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function formatHours(hours: number | null | undefined): string {
  if (!present(hours)) return dash;
  return hours < 48 ? `${Math.round(hours)}h` : `${(hours / 24).toFixed(1)}d`;
}

export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDay(date: Date): string {
  return day.format(date);
}
```

In `src/lib/status-report.ts`: import `formatElapsed` and `formatUtc` from `@/lib/format`, delete the local `elapsed` and `formatTime` functions, and replace every `elapsed(now, X)` with `formatElapsed(X, now)` (the argument order changes) and `formatTime(` with `formatUtc(`.

**Step 4: Run the tests**

Run: `npx vitest run src/lib/format.test.ts src/lib/status-report.test.ts`
Expected: PASS, with the status report output unchanged.

**Step 5: Commit, push, validate, CI**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/lib/status-report.ts
git commit -m "refactor(status): share display formatting with the dashboard"
```

### Task 4: Read-only dashboard database session

**Files:**
- Modify: `src/lib/config.ts` (`DATABASE_SESSION_CONFIG`)
- Create: `src/db/dashboard.ts`
- Test: `src/db/dashboard.db.test.ts`

**Step 1: Write the failing test**

`src/db/dashboard.db.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/logger";
import { createDatabase } from "./client";
import { DASHBOARD_DATABASE_OPTIONS } from "./dashboard";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("dashboard database session", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("reads but refuses every write", async () => {
    const { db, pool } = createDatabase(database.url, DASHBOARD_DATABASE_OPTIONS);
    try {
      const result = await db.execute<{ games: number }>(sql`select count(*)::int as games from games`);
      expect(result.rows).toEqual([{ games: 0 }]);
      const failure = await db
        .execute(sql`insert into job_runs (id, job, slot, status, started_at) values (gen_random_uuid(), 'poll', now(), 'running', now())`)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).not.toBeNull();
      expect(errorMessage(failure)).toContain("read-only transaction");
    } finally {
      await pool.end();
    }
  });
});
```

**Step 2: Implement**

In `src/lib/config.ts`, add to `DATABASE_SESSION_CONFIG` (before `closeTimeoutMs`):

```ts
  // The dashboard (radar-web) only reads: its sessions are read-only, a slow page gives up instead of holding a
  // connection, and its pool stays small beside the jobs' connections.
  dashboardStatementTimeoutMs: 15_000,
  dashboardLockTimeoutMs: 5_000,
  dashboardMaxConnections: 5,
```

`src/db/dashboard.ts`:

```ts
import { DATABASE_SESSION_CONFIG } from "@/lib/config";
import { type Database, type DatabaseOptions, getDatabase } from "./client";

// Every dashboard query runs in a read-only session: a page can never write, whatever it calls.
export const DASHBOARD_DATABASE_OPTIONS = {
  applicationName: "radar-web",
  maxConnections: DATABASE_SESSION_CONFIG.dashboardMaxConnections,
  statementTimeoutMs: DATABASE_SESSION_CONFIG.dashboardStatementTimeoutMs,
  lockTimeoutMs: DATABASE_SESSION_CONFIG.dashboardLockTimeoutMs,
  settings: { default_transaction_read_only: "on" },
} as const satisfies DatabaseOptions;

// The dashboard process opens no other database: this is the first and only getDatabase call in radar-web.
export function dashboardDatabase(): Database {
  const { applicationName, ...options } = DASHBOARD_DATABASE_OPTIONS;
  return getDatabase(applicationName, options);
}
```

**Step 3: Typecheck, commit, push, validate, CI**

Run: `npm run typecheck` (Expected: no error).

```bash
git add src/lib/config.ts src/db/dashboard.ts src/db/dashboard.db.test.ts
git commit -m "feat(dashboard): add a read-only database session"
```

Expected in CI: `dashboard.db.test.ts` ran and passed. If drizzle wraps the error so that `errorMessage` misses the server message, assert on `errorMessage(failure)` anyway: it appends causes (see `src/lib/logger.ts`); fix the assertion only if the message really lives elsewhere, and say so in the commit body.

### Task 5: `rising_games` SQL function and its query

**Files:**
- Modify: `src/lib/config.ts` (add `RADAR_CONFIG`)
- Create: `drizzle/0007_rising_games.sql` (custom migration, plus the files drizzle-kit adds to `drizzle/meta`)
- Create: `src/db/radar.ts`
- Test: `src/db/radar.db.test.ts`

**Step 1: Add the configuration**

In `src/lib/config.ts`, after `STATUS_CONFIG`:

```ts
// The Radar page and rising_games (drizzle/0007_rising_games.sql, design section 5A). The SQL function takes every
// value below as a parameter; docs/operations.md shows a call with them for analysis sessions.
export const RADAR_CONFIG = {
  // Filters on the real age, from the Roblox creation date.
  ageOptionsDays: [14, 30, 90],
  defaultAgeDays: 30,
  minimumCcuOptions: [50, 100, 500, 1_000, 5_000],
  defaultMinimumCcu: 100,
  // The current window: the whole UTC hours before as_of. Acceleration compares its average CCU with the window
  // before it; weekday-safe growth compares the game's share of tracked CCU with the same window one week earlier.
  windowHours: 24,
  // The growth score is ln((share now × market + k) / (share a week ago × market + k)), in CCU at the current market
  // size: k keeps a game going from 5 to 50 CCU from outranking real risers. A game created after the start of the
  // week-ago window counts from 0; one that existed but was not tracked then has no score.
  smoothingCcu: 100,
  // An hour whose peak reaches this multiple of the window's median hourly CCU is an event (admin abuse, a promotion)
  // rather than organic growth. The median of the same window, not of seven days: a game rising tenfold in a week
  // would otherwise flag every hour of its rise.
  eventPeakToMedianRatio: 3,
  eventMinimumSamples: 12,
  // Velocity: hours from the start to the middle threshold and from the middle to the end one, measured only when
  // the radar (poll or census) saw the game below the threshold it starts from.
  velocityThresholds: { start: 100, middle: 1_000, end: 10_000 },
  pageSize: 100,
} as const;
```

**Step 2: Generate the custom migration**

Run: `npx drizzle-kit generate --custom --name=rising_games`
Expected: `drizzle/0007_rising_games.sql`, a new snapshot `drizzle/meta/0007_snapshot.json` and a journal entry. Replace the SQL file's content with:

```sql
-- Rising games (design section 5A), computed on demand from the hourly aggregates for any as_of, so the dashboard,
-- analysis sessions and backtests share one definition. Every threshold is a parameter: src/lib/config.ts
-- (RADAR_CONFIG) holds the values. Windows are whole UTC hours before as_of: the current window, the window before it
-- (acceleration) and the current window one week earlier (weekday-safe growth). Every metric comes with its sample
-- size, in hourly buckets.
CREATE FUNCTION rising_games(
  as_of timestamptz,
  max_age_days int,
  min_ccu int,
  window_hours int,
  smoothing_ccu double precision,
  event_peak_ratio double precision,
  event_min_samples int,
  velocity_start int,
  velocity_middle int,
  velocity_end int
)
RETURNS TABLE (
  universe_id bigint,
  name text,
  icon_url text,
  roblox_created_at timestamptz,
  first_observed_at timestamptz,
  ccu_last int,
  ccu_avg double precision,
  ccu_peak int,
  window_peak int,
  window_median double precision,
  is_event boolean,
  week_growth double precision,
  week_growth_score double precision,
  day_growth double precision,
  first_seen_ccu int,
  hours_to_middle double precision,
  hours_to_end double precision,
  samples int,
  previous_samples int,
  week_samples int
)
LANGUAGE sql
STABLE
AS $$
WITH candidates AS (
  SELECT g.universe_id, g.name, g.icon_url, g.roblox_created_at, g.first_observed_at
  FROM games g
  WHERE g.roblox_created_at > rising_games.as_of - make_interval(days => rising_games.max_age_days)
    AND g.roblox_created_at <= rising_games.as_of
),
-- The candidates' hourly CCU in the three windows. The week-ago window sits seven days (one week) before the current
-- one, so both cover the same weekdays and hours.
hourly AS (
  SELECT h.universe_id, h.bucket, h.ccu_avg, h.ccu_max,
    CASE
      WHEN h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
        THEN 'current'
      WHEN h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 2 * rising_games.window_hours)
        THEN 'previous'
      ELSE 'week'
    END AS period
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 2 * rising_games.window_hours)
      OR (
        h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(days => 7, hours => rising_games.window_hours)
        AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(days => 7)
      )
    )
),
-- Tracked CCU of every game, of any age, per hour of the current and week-ago windows: the denominator of the shares,
-- which cancels the weekday and hour-of-day swings of the whole market.
market AS (
  SELECT h.bucket, sum(h.ccu_avg) AS total
  FROM game_hourly h
  WHERE (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
      AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    ) OR (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(days => 7, hours => rising_games.window_hours)
      AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(days => 7)
    )
  GROUP BY h.bucket
),
market_size AS (
  SELECT avg(m.total) AS total
  FROM market m
  WHERE m.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
),
windows AS (
  SELECT h.universe_id,
    avg(h.ccu_avg) FILTER (WHERE h.period = 'current') AS ccu_avg,
    avg(h.ccu_avg) FILTER (WHERE h.period = 'previous') AS previous_avg,
    avg(h.ccu_avg / nullif(m.total, 0)) FILTER (WHERE h.period = 'current') AS share,
    avg(h.ccu_avg / nullif(m.total, 0)) FILTER (WHERE h.period = 'week') AS week_share,
    max(h.ccu_max) FILTER (WHERE h.period = 'current') AS window_peak,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY h.ccu_avg) FILTER (WHERE h.period = 'current') AS window_median,
    count(*) FILTER (WHERE h.period = 'current') AS samples,
    count(*) FILTER (WHERE h.period = 'previous') AS previous_samples,
    count(*) FILTER (WHERE h.period = 'week') AS week_samples
  FROM hourly h
  LEFT JOIN market m ON m.bucket = h.bucket
  GROUP BY h.universe_id
),
-- The freshest CCU, from the observations themselves: the current hour is not whole yet.
latest AS (
  SELECT DISTINCT ON (o.universe_id) o.universe_id, o.ccu
  FROM game_observations o
  JOIN candidates c ON c.universe_id = o.universe_id
  WHERE o.observed_at <= rising_games.as_of
    AND o.observed_at > rising_games.as_of - make_interval(hours => rising_games.window_hours)
  ORDER BY o.universe_id, o.observed_at DESC
),
-- Every hourly reading of the candidates, from poll and from the census of their places: census lists a place long
-- before its CCU earns it a poll, which dates the threshold crossings.
series AS (
  SELECT h.universe_id, h.bucket, h.ccu_max
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND h.bucket >= rising_games.as_of - make_interval(days => rising_games.max_age_days + 1)
  UNION ALL
  SELECT p.universe_id, ch.bucket, ch.ccu_max
  FROM census_hourly ch
  JOIN places p ON p.place_id = ch.place_id
  JOIN candidates c ON c.universe_id = p.universe_id
  WHERE ch.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND ch.bucket >= rising_games.as_of - make_interval(days => rising_games.max_age_days + 1)
),
crossings AS (
  SELECT s.universe_id,
    min(s.bucket) AS first_bucket,
    (array_agg(s.ccu_max ORDER BY s.bucket, s.ccu_max DESC))[1] AS first_seen_ccu,
    max(s.ccu_max) AS peak,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_start) AS at_start,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_middle) AS at_middle,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_end) AS at_end
  FROM series s
  GROUP BY s.universe_id
),
-- v1 daily peaks (2026-08-24 to 2026-09-19), older than the hourly history.
legacy_peaks AS (
  SELECT l.universe_id, max(l.ccu_peak) AS peak
  FROM game_daily_legacy l
  JOIN candidates c ON c.universe_id = l.universe_id
  WHERE l.day + INTERVAL '1 day' <= rising_games.as_of
  GROUP BY l.universe_id
)
SELECT
  c.universe_id::bigint,
  c.name,
  c.icon_url,
  c.roblox_created_at,
  c.first_observed_at,
  l.ccu::int,
  w.ccu_avg::double precision,
  greatest(x.peak, l.ccu, lp.peak)::int,
  w.window_peak::int,
  w.window_median::double precision,
  (w.samples >= rising_games.event_min_samples AND w.window_peak >= rising_games.event_peak_ratio * w.window_median),
  (w.share / nullif(w.week_share, 0))::double precision,
  (CASE
    WHEN w.week_samples > 0 THEN
      ln((w.share * ms.total + rising_games.smoothing_ccu) / (w.week_share * ms.total + rising_games.smoothing_ccu))
    -- Created after the start of the week-ago window: the game had no players to compare with.
    WHEN c.roblox_created_at >= time_bucket(INTERVAL '1 hour', rising_games.as_of)
      - make_interval(days => 7, hours => rising_games.window_hours) THEN
      ln((w.share * ms.total + rising_games.smoothing_ccu) / rising_games.smoothing_ccu)
  END)::double precision,
  (w.ccu_avg / nullif(w.previous_avg, 0))::double precision,
  x.first_seen_ccu::int,
  (CASE WHEN x.at_start > x.first_bucket THEN extract(epoch FROM x.at_middle - x.at_start) / 3600 END)::double precision,
  (CASE WHEN x.at_middle > x.first_bucket THEN extract(epoch FROM x.at_end - x.at_middle) / 3600 END)::double precision,
  w.samples::int,
  w.previous_samples::int,
  w.week_samples::int
FROM candidates c
JOIN windows w ON w.universe_id = c.universe_id
CROSS JOIN market_size ms
LEFT JOIN latest l ON l.universe_id = c.universe_id
LEFT JOIN crossings x ON x.universe_id = c.universe_id
LEFT JOIN legacy_peaks lp ON lp.universe_id = c.universe_id
WHERE w.samples > 0 AND w.ccu_avg >= rising_games.min_ccu
$$;
```

Notes for the implementer: arguments are referenced as `rising_games.<name>` because column names take precedence over argument names in SQL functions; keep every table column qualified by its alias. The `hourly` CTE only holds the three windows, so its `ELSE 'week'` is safe while `2 × window_hours` stays below 6 days.

**Step 3: Write the failing database test**

`src/db/radar.db.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RADAR_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { type RadarSort, type RisingGame, risingGames } from "./radar";
import { censusObservations, gameDailyLegacy, gameObservations, games, places } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
// as_of falls 30 minutes into an hour: the current window is the 24 whole hours before 12:00.
const asOf = new Date("2026-10-28T12:30:00Z");
const windowEnd = Date.parse("2026-10-28T12:00:00Z");
const week = 7 * 24;

describe.skipIf(!hasTestDatabase)("rising_games", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(gameObservations);
    await database.db.delete(censusObservations);
    await database.db.delete(gameDailyLegacy);
    await database.db.delete(places);
    await database.db.delete(games);
  });

  async function game(universeId: number, createdDaysBefore: number): Promise<void> {
    const created = new Date(asOf.getTime() - createdDaysBefore * dayMs);
    await upsertGameDetails(database.db, [gameDetail(universeId, { created })], new Date(created.getTime() + hourMs));
  }

  // One observation 10 minutes into each hour, from `from` down to `to` (exclusive) hours before the window end.
  async function hourly(universeId: number, from: number, to: number, ccu: number | ((hour: number) => number)) {
    const rows = [];
    for (let hour = from; hour > to; hour -= 1) {
      rows.push({
        universeId,
        observedAt: new Date(windowEnd - hour * hourMs + 10 * 60_000),
        ccu: typeof ccu === "number" ? ccu : ccu(hour),
        visits: 1_000,
        favorites: 10,
      });
    }
    await writeGameObservations(database.db, rows);
  }

  const current = (universeId: number, ccu: number | ((hour: number) => number)) => hourly(universeId, 24, 0, ccu);
  const previous = (universeId: number, ccu: number) => hourly(universeId, 48, 24, ccu);
  const weekAgo = (universeId: number, ccu: number) => hourly(universeId, week + 24, week, ccu);

  function query(sort: RadarSort, overrides: Partial<Parameters<typeof risingGames>[1]> = {}) {
    return risingGames(database.db, {
      asOf,
      maxAgeDays: 30,
      minimumCcu: 100,
      sort,
      limit: RADAR_CONFIG.pageSize,
      ...overrides,
    });
  }

  function byId(rows: RisingGame[]): Map<number, RisingGame> {
    return new Map(rows.map((row) => [row.universeId, row]));
  }

  // 1 is an old game that dominates the market; 2 is flat; 3 quadrupled its CCU; 4 is new; 5 was not tracked a week ago.
  async function market(): Promise<void> {
    await game(1, 200);
    await current(1, 10_000);
    await weekAgo(1, 10_000);
    await game(2, 20);
    await current(2, 1_000);
    await weekAgo(2, 1_000);
    await game(3, 20);
    await current(3, 2_000);
    await previous(3, 1_000);
    await weekAgo(3, 500);
    await game(4, 3);
    await current(4, 1_500);
    await game(5, 20);
    await current(5, 800);
  }

  it("ranks young games by weekday-safe growth, new games from zero, untracked ones last", async () => {
    await market();
    const rows = await query("growth");
    expect(rows.map((row) => row.universeId)).toEqual([4, 3, 2, 5]);
    const found = byId(rows);
    // Tracked CCU per hour: 15,300 now and 11,500 a week ago.
    expect(found.get(3)).toMatchObject({ ccuAverage: 2_000, samples: 24, previousSamples: 24, weekSamples: 24, dayGrowth: 2 });
    expect(found.get(3)?.weekGrowth).toBeCloseTo((2_000 / 15_300) / (500 / 11_500), 4);
    expect(found.get(3)?.weekGrowthScore).toBeCloseTo(Math.log(2_100 / ((500 / 11_500) * 15_300 + 100)), 4);
    expect(found.get(2)?.weekGrowth).toBeCloseTo(11_500 / 15_300, 4);
    expect(found.get(2)).toMatchObject({ dayGrowth: null, previousSamples: 0 });
    expect(found.get(4)).toMatchObject({ weekGrowth: null, weekSamples: 0 });
    expect(found.get(4)?.weekGrowthScore).toBeCloseTo(Math.log(1_600 / 100), 4);
    expect(found.get(5)).toMatchObject({ weekGrowth: null, weekGrowthScore: null });
  });

  it("sorts by acceleration, CCU or age, ending with the CCU then the universe id", async () => {
    await market();
    expect((await query("acceleration")).map((row) => row.universeId)).toEqual([3, 4, 2, 5]);
    expect((await query("ccu")).map((row) => row.universeId)).toEqual([3, 4, 2, 5]);
    // Games 2, 3 and 5 share their creation time: the CCU breaks the tie.
    expect((await query("age")).map((row) => row.universeId)).toEqual([4, 3, 2, 5]);
  });

  it("filters on the real age and on the average CCU of the window", async () => {
    await market();
    expect((await query("growth", { maxAgeDays: 14 })).map((row) => row.universeId)).toEqual([4]);
    expect((await query("growth", { minimumCcu: 1_600 })).map((row) => row.universeId)).toEqual([3]);
  });

  it("takes the freshest observation as the current CCU and never reads past as_of", async () => {
    await market();
    await writeGameObservations(database.db, [
      { universeId: 3, observedAt: new Date(windowEnd + 20 * 60_000), ccu: 2_500, visits: 1_000, favorites: 10 },
      { universeId: 3, observedAt: new Date(windowEnd + 40 * 60_000), ccu: 9_000, visits: 1_000, favorites: 10 },
    ]);
    expect(byId(await query("growth")).get(3)).toMatchObject({ ccuLast: 2_500, ccuPeak: 2_500 });
    // At the main window's start, the current window is the previous one of the main test, and the main window's
    // first observation (10 minutes later) is not read.
    const dayEarlier = byId(await query("growth", { asOf: new Date(windowEnd - dayMs) })).get(3);
    expect(dayEarlier).toMatchObject({ ccuAverage: 1_000, samples: 24, ccuLast: 1_000, ccuPeak: 1_000 });
  });

  it("counts the v1 daily peaks in the peak CCU", async () => {
    await market();
    await database.db.insert(gameDailyLegacy).values({
      universeId: 2,
      day: new Date(asOf.getTime() - 15 * dayMs),
      ccuAvg: 20_000,
      ccuPeak: 50_000,
      visits: 1,
      favorites: 1,
    });
    expect(byId(await query("growth")).get(2)?.ccuPeak).toBe(50_000);
  });

  it("flags an hourly peak far above the window's median as an event", async () => {
    await game(6, 10);
    await current(6, (hour) => (hour === 5 ? 4_000 : 1_000));
    await game(7, 10);
    await current(7, 1_000);
    // Too few hours to tell an event from noise.
    await game(8, 10);
    await hourly(8, 6, 0, (hour) => (hour === 3 ? 9_000 : 1_000));
    const rows = byId(await query("ccu"));
    expect(rows.get(6)).toMatchObject({ isEvent: true, windowPeak: 4_000, windowMedian: 1_000 });
    expect(rows.get(7)?.isEvent).toBe(false);
    expect(rows.get(8)?.isEvent).toBe(false);
  });

  it("measures velocity from the first reading below each threshold, census included", async () => {
    await game(9, 5);
    await savePlaceResolution(database.db, { placeId: 90, universeId: 9, resolvedAt: asOf, error: null });
    await writeCensusObservations(database.db, [
      { placeId: 90, observedAt: new Date(windowEnd - 60 * hourMs), ccu: 50 },
      { placeId: 90, observedAt: new Date(windowEnd - 58 * hourMs), ccu: 150 },
    ]);
    await hourly(9, 50, 49, 1_200);
    await hourly(9, 30, 29, 12_000);
    await current(9, 8_000);
    // First seen above the middle threshold: neither velocity is known.
    await game(10, 5);
    await current(10, 3_000);
    const rows = byId(await query("ccu"));
    expect(rows.get(9)).toMatchObject({ firstSeenCcu: 50, hoursToMiddle: 8, hoursToEnd: 20 });
    expect(rows.get(10)).toMatchObject({ firstSeenCcu: 3_000, hoursToMiddle: null, hoursToEnd: null });
  });
});
```

**Step 4: Implement the query**

`src/db/radar.ts`:

```ts
import { sql } from "drizzle-orm";
import { RADAR_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export const RADAR_SORTS = ["growth", "acceleration", "ccu", "age"] as const;
export type RadarSort = (typeof RADAR_SORTS)[number];

// One row of rising_games (drizzle/0007_rising_games.sql). Sample counts are hourly buckets.
export interface RisingGame {
  universeId: number;
  name: string;
  iconUrl: string | null;
  robloxCreatedAt: Date;
  firstObservedAt: Date;
  // The latest observation of the window; null when none is that recent.
  ccuLast: number | null;
  // Average hourly CCU of the current window.
  ccuAverage: number;
  ccuPeak: number;
  windowPeak: number;
  windowMedian: number;
  isEvent: boolean;
  // Share of tracked CCU now against the same window a week earlier; null without week-ago samples.
  weekGrowth: number | null;
  // The sort key of "growth": null when the game existed a week ago but was not tracked.
  weekGrowthScore: number | null;
  // Average CCU of the window against the window before it.
  dayGrowth: number | null;
  firstSeenCcu: number | null;
  hoursToMiddle: number | null;
  hoursToEnd: number | null;
  samples: number;
  previousSamples: number;
  weekSamples: number;
}

export interface RisingGamesQuery {
  asOf: Date;
  maxAgeDays: number;
  minimumCcu: number;
  sort: RadarSort;
  limit: number;
}

// Every sort ends with the window's average CCU, then the universe id, so the order is stable.
const orderBy: Record<RadarSort, string> = {
  growth: "week_growth_score desc nulls last, ccu_avg desc, universe_id",
  acceleration: "day_growth desc nulls last, ccu_avg desc, universe_id",
  ccu: "ccu_avg desc, universe_id",
  age: "roblox_created_at desc, ccu_avg desc, universe_id",
};

interface RisingGameRow {
  universe_id: string;
  name: string;
  icon_url: string | null;
  roblox_created_at: Date | string;
  first_observed_at: Date | string;
  ccu_last: number | null;
  ccu_avg: number;
  ccu_peak: number | null;
  window_peak: number;
  window_median: number;
  is_event: boolean;
  week_growth: number | null;
  week_growth_score: number | null;
  day_growth: number | null;
  first_seen_ccu: number | null;
  hours_to_middle: number | null;
  hours_to_end: number | null;
  samples: number;
  previous_samples: number;
  week_samples: number;
}

export async function risingGames(db: Database, query: RisingGamesQuery, config = RADAR_CONFIG): Promise<RisingGame[]> {
  const result = await db.execute<RisingGameRow>(sql`
    select * from rising_games(
      as_of => ${query.asOf.toISOString()}::timestamptz,
      max_age_days => ${query.maxAgeDays}::int,
      min_ccu => ${query.minimumCcu}::int,
      window_hours => ${config.windowHours}::int,
      smoothing_ccu => ${config.smoothingCcu}::double precision,
      event_peak_ratio => ${config.eventPeakToMedianRatio}::double precision,
      event_min_samples => ${config.eventMinimumSamples}::int,
      velocity_start => ${config.velocityThresholds.start}::int,
      velocity_middle => ${config.velocityThresholds.middle}::int,
      velocity_end => ${config.velocityThresholds.end}::int
    )
    order by ${sql.raw(orderBy[query.sort])}
    limit ${query.limit}::int
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    iconUrl: row.icon_url,
    robloxCreatedAt: new Date(row.roblox_created_at),
    firstObservedAt: new Date(row.first_observed_at),
    ccuLast: row.ccu_last,
    ccuAverage: row.ccu_avg,
    ccuPeak: row.ccu_peak ?? 0,
    windowPeak: row.window_peak,
    windowMedian: row.window_median,
    isEvent: row.is_event,
    weekGrowth: row.week_growth,
    weekGrowthScore: row.week_growth_score,
    dayGrowth: row.day_growth,
    firstSeenCcu: row.first_seen_ccu,
    hoursToMiddle: row.hours_to_middle,
    hoursToEnd: row.hours_to_end,
    samples: row.samples,
    previousSamples: row.previous_samples,
    weekSamples: row.week_samples,
  }));
}
```

**Step 5: Commit, push, validate, CI**

```bash
git add src/lib/config.ts drizzle/0007_rising_games.sql drizzle/meta/_journal.json drizzle/meta/0007_snapshot.json src/db/radar.ts src/db/radar.db.test.ts
git commit -m "feat(analysis): add the rising_games function"
```

Expected in CI: `radar.db.test.ts`, `migrate.db.test.ts` and `production-roles.db.test.ts` pass (the function is created by the non-superuser owner, and `radar_analysis` may execute it through `PUBLIC`). If an expectation fails, find the cause in the SQL (types, window bounds, nulls) before touching the test, and keep the test's numbers derived from the fixture.

### Task 6: Radar query parsing

**Files:**
- Create: `src/lib/dashboard/radar-query.ts`
- Test: `src/lib/dashboard/radar-query.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { RADAR_CONFIG } from "@/lib/config";
import { parseRadarQuery, toDateTimeInput } from "./radar-query";

const now = new Date("2026-10-22T18:00:00Z");

describe("parseRadarQuery", () => {
  it("falls back to the defaults", () => {
    expect(parseRadarQuery({}, now)).toEqual({
      maxAgeDays: RADAR_CONFIG.defaultAgeDays,
      minimumCcu: RADAR_CONFIG.defaultMinimumCcu,
      sort: "growth",
      asOf: null,
    });
  });

  it("accepts the configured options", () => {
    expect(parseRadarQuery({ age: "90", minCcu: "1000", sort: "acceleration", asOf: "2026-09-29T12:00" }, now)).toEqual({
      maxAgeDays: 90,
      minimumCcu: 1_000,
      sort: "acceleration",
      asOf: new Date("2026-09-29T12:00:00Z"),
    });
  });

  it("ignores values outside the options and takes the first of repeated parameters", () => {
    expect(parseRadarQuery({ age: "7", minCcu: "-1", sort: "score" }, now)).toMatchObject({
      maxAgeDays: RADAR_CONFIG.defaultAgeDays,
      minimumCcu: RADAR_CONFIG.defaultMinimumCcu,
      sort: "growth",
    });
    expect(parseRadarQuery({ age: ["14", "90"] }, now).maxAgeDays).toBe(14);
  });

  it("reads asOf as UTC and refuses malformed or future instants", () => {
    expect(parseRadarQuery({ asOf: "2026-10-22T19:00" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "2026-02-30T10:00" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "yesterday" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "" }, now).asOf).toBeNull();
  });

  it("formats an instant for a datetime-local input", () => {
    expect(toDateTimeInput(new Date("2026-09-29T12:05:41Z"))).toBe("2026-09-29T12:05");
  });
});
```

**Step 2: Run them to see them fail**, then implement `src/lib/dashboard/radar-query.ts`:

```ts
import { RADAR_SORTS, type RadarSort } from "@/db/radar";
import { RADAR_CONFIG } from "@/lib/config";

export interface RadarQuery {
  maxAgeDays: number;
  minimumCcu: number;
  sort: RadarSort;
  // Null means now.
  asOf: Date | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function option(value: string | undefined, options: readonly number[], fallback: number): number {
  const parsed = Number(value);
  return options.includes(parsed) ? parsed : fallback;
}

// The Radar filters come from a GET form; anything outside the configured options falls back to the default.
export function parseRadarQuery(params: SearchParams, now: Date, config = RADAR_CONFIG): RadarQuery {
  const sort = first(params.sort);
  return {
    maxAgeDays: option(first(params.age), config.ageOptionsDays, config.defaultAgeDays),
    minimumCcu: option(first(params.minCcu), config.minimumCcuOptions, config.defaultMinimumCcu),
    sort: RADAR_SORTS.find((candidate) => candidate === sort) ?? "growth",
    asOf: parseAsOf(first(params.asOf), now),
  };
}

// A datetime-local value, read as UTC like every time the dashboard shows. A day that does not exist rolls over in
// Date.UTC, so the parsed fields must round-trip.
function parseAsOf(value: string | undefined, now: Date): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (toDateTimeInput(date) !== value) return null;
  return date < now ? date : null;
}

export function toDateTimeInput(date: Date): string {
  return date.toISOString().slice(0, 16);
}
```

**Step 3: Run the tests**: `npx vitest run src/lib/dashboard/radar-query.test.ts` → PASS.

**Step 4: Commit, push, validate, CI**

```bash
git add src/lib/dashboard/radar-query.ts src/lib/dashboard/radar-query.test.ts
git commit -m "feat(dashboard): parse the radar filters"
```

### Task 7: Game view queries

**Files:**
- Modify: `src/lib/config.ts` (add `GAME_VIEW_CONFIG`)
- Create: `src/db/game-view.ts`
- Test: `src/db/game-view.db.test.ts`

**Step 1: Add the configuration** after `RADAR_CONFIG`:

```ts
// The game page (src/app/games/[universeId]).
export const GAME_VIEW_CONFIG = {
  // The detailed curve: every observation of these last days.
  recentDays: 14,
  // Session length and favorites per visit come from the visits, favorites and hourly CCU of this window, and only
  // when its observations span the minimum: a few hours of a new game say little about its sessions.
  engagementDays: 7,
  engagementMinimumHours: 24,
  // Chart presence: the best rank over the last hours (monetization: Top Earning against Top Playing Now), and the
  // hours ranked over the last days (retention: Top Revisited).
  chartBestRankHours: 24,
  chartRecentDays: 7,
  timelineEntries: 40,
} as const;
```

**Step 2: Write the failing test**

`src/db/game-view.db.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { upsertGameDetails } from "./games";
import { readGameView } from "./game-view";
import { writeChartPlacements, writeGameObservations, writeVoteObservations } from "./observations";
import { chartPlacements, discoverySources, gameObservations, games, voteObservations } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const hourMs = 60 * 60 * 1000;
const now = new Date("2026-10-21T12:00:00Z");
const firstSeen = new Date("2026-10-20T10:00:00Z");

describe.skipIf(!hasTestDatabase)("readGameView", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(gameObservations);
    await database.db.delete(voteObservations);
    await database.db.delete(chartPlacements);
    // Deleting games cascades to discovery_sources and game_versions.
    await database.db.delete(games);
  });

  async function fixture(): Promise<void> {
    const created = new Date("2026-10-01T00:00:00Z");
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Game 1", created })], firstSeen);
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Game 1 [UPD]", created })], new Date("2026-10-21T10:00:00Z"));
    await database.db.insert(discoverySources).values({
      universeId: 1,
      source: "chart",
      detail: "top-trending",
      firstSeenAt: firstSeen,
      lastSeenAt: now,
    });
    // An old observation outside the 14-day curve and the 7-day engagement window, then 48 hours at 1,000 CCU with
    // 2,000 new visits and 10 new favorites per hour.
    const rows = [{ universeId: 1, observedAt: new Date("2026-10-01T06:00:00Z"), ccu: 300, visits: 50_000, favorites: 4_000 }];
    for (let hour = 0; hour <= 48; hour += 1) {
      rows.push({
        universeId: 1,
        observedAt: new Date(Date.parse("2026-10-19T00:00:00Z") + hour * hourMs),
        ccu: 1_000,
        visits: 100_000 + hour * 2_000,
        favorites: 5_000 + hour * 10,
      });
    }
    await writeGameObservations(database.db, rows);
    await writeVoteObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-10-20T00:00:00Z"), upVotes: 900, downVotes: 100 },
      { universeId: 1, observedAt: new Date("2026-10-21T00:00:00Z"), upVotes: 950, downVotes: 50 },
    ]);
    await writeChartPlacements(database.db, [
      { sortId: "top-earning", universeId: 1, observedAt: new Date("2026-10-15T08:00:00Z"), rank: 5, playerCount: 1_000, isSponsored: false },
      { sortId: "top-earning", universeId: 1, observedAt: new Date("2026-10-20T23:00:00Z"), rank: 12, playerCount: 1_000, isSponsored: false },
      { sortId: "top-playing-now", universeId: 1, observedAt: new Date("2026-10-21T11:00:00Z"), rank: 30, playerCount: 1_000, isSponsored: false },
    ]);
  }

  it("returns null for an unknown game", async () => {
    expect(await readGameView(database.db, 999, now)).toBeNull();
  });

  it("gathers the game, its curves, versions, charts, votes and engagement window", async () => {
    await fixture();
    const view = await readGameView(database.db, 1, now);
    expect(view?.game).toMatchObject({ universeId: 1, name: "Game 1 [UPD]", firstObservedAt: firstSeen });
    expect(view?.discovery).toEqual({ source: "chart", detail: "top-trending", firstSeenAt: firstSeen });
    expect(view?.recent).toHaveLength(49);
    expect(view?.recent[0]).toEqual({ at: new Date("2026-10-19T00:00:00Z"), ccu: 1_000 });
    expect(view?.daily.map((day) => [day.day.toISOString().slice(0, 10), day.peak, day.origin])).toEqual([
      ["2026-10-01", 300, "observed"],
      ["2026-10-19", 1_000, "observed"],
      ["2026-10-20", 1_000, "observed"],
      ["2026-10-21", 1_000, "observed"],
    ]);
    expect(view?.versions.filter((version) => version.kind === "metadata").map((version) => version.name)).toEqual([
      "Game 1",
      "Game 1 [UPD]",
    ]);
    expect(view?.votes).toEqual({ upVotes: 950, downVotes: 50, observedAt: new Date("2026-10-21T00:00:00Z") });
    expect(view?.charts).toEqual([
      {
        sortId: "top-earning",
        firstSeenAt: new Date("2026-10-15T08:00:00Z"),
        lastSeenAt: new Date("2026-10-20T23:00:00Z"),
        bestRank: 5,
        bestRankRecent: 12,
        hoursRecent: 2,
      },
      {
        sortId: "top-playing-now",
        firstSeenAt: new Date("2026-10-21T11:00:00Z"),
        lastSeenAt: new Date("2026-10-21T11:00:00Z"),
        bestRank: 30,
        bestRankRecent: 30,
        hoursRecent: 1,
      },
    ]);
    expect(view?.engagement).toEqual({
      firstAt: new Date("2026-10-19T00:00:00Z"),
      lastAt: new Date("2026-10-21T00:00:00Z"),
      firstVisits: 100_000,
      lastVisits: 196_000,
      firstFavorites: 5_000,
      lastFavorites: 5_480,
      ccuAverage: 1_000,
    });
  });
});
```

Check `src/db/games.db.test.ts` first: if `upsertGameDetails` does not record a version on the first insert, the expected metadata names are `["Game 1 [UPD]"]`; keep whatever the real behavior is and say so in a comment.

**Step 3: Implement** `src/db/game-view.ts`:

```ts
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { GAME_VIEW_CONFIG } from "@/lib/config";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoverySources, gameObservations, games, gameVersions, voteObservations } from "./schema";

const dayMs = 24 * 60 * 60 * 1000;

export interface GameRecord {
  universeId: number;
  rootPlaceId: number;
  name: string;
  description: string;
  creatorName: string;
  creatorType: string;
  genre: string | null;
  robloxCreatedAt: Date;
  firstObservedAt: Date;
  lastCcu: number;
  lastCcuAt: Date | null;
  thumbnailUrl: string | null;
  iconUrl: string | null;
}

export interface Discovery {
  source: DiscoverySource;
  detail: string;
  firstSeenAt: Date;
}

export interface CcuPoint {
  at: Date;
  ccu: number;
}

export interface DailyPoint {
  day: Date;
  peak: number;
  average: number;
  origin: "observed" | "legacy";
}

export interface VersionRecord {
  kind: "metadata" | "thumbnail";
  name: string | null;
  observedAt: Date;
}

export interface ChartPresence {
  sortId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  bestRank: number;
  // The best rank over GAME_VIEW_CONFIG.chartBestRankHours; null when the game was not ranked then.
  bestRankRecent: number | null;
  // Hours ranked over GAME_VIEW_CONFIG.chartRecentDays.
  hoursRecent: number;
}

export interface VoteReading {
  upVotes: number;
  downVotes: number;
  observedAt: Date;
}

// The first and last observations of the engagement window, and the average hourly CCU between them.
export interface EngagementWindow {
  firstAt: Date;
  lastAt: Date;
  firstVisits: number;
  lastVisits: number;
  firstFavorites: number;
  lastFavorites: number;
  ccuAverage: number | null;
}

export interface GameView {
  game: GameRecord;
  // How the radar first found the game; null for games found before v2 recorded discoveries.
  discovery: Discovery | null;
  recent: CcuPoint[];
  daily: DailyPoint[];
  // Oldest first.
  versions: VersionRecord[];
  charts: ChartPresence[];
  votes: VoteReading | null;
  engagement: EngagementWindow | null;
}

export async function readGameView(
  db: Database,
  universeId: number,
  now: Date,
  config = GAME_VIEW_CONFIG,
): Promise<GameView | null> {
  const game = await readGame(db, universeId);
  if (!game) return null;
  const [discovery, recent, daily, versions, charts, votes, engagement] = await Promise.all([
    readDiscovery(db, universeId),
    readRecentCcu(db, universeId, now, config.recentDays),
    readDailyHistory(db, universeId, now),
    readVersions(db, universeId),
    readChartPresence(db, universeId, now, config),
    readLatestVotes(db, universeId, now),
    readEngagementWindow(db, universeId, now, config.engagementDays),
  ]);
  return { game, discovery, recent, daily, versions, charts, votes, engagement };
}

async function readGame(db: Database, universeId: number): Promise<GameRecord | null> {
  const [row] = await db.select().from(games).where(eq(games.universeId, universeId));
  if (!row) return null;
  return {
    universeId: row.universeId,
    rootPlaceId: row.rootPlaceId,
    name: row.name,
    description: row.description,
    creatorName: row.creatorName,
    creatorType: row.creatorType,
    genre: row.genre,
    robloxCreatedAt: row.robloxCreatedAt,
    firstObservedAt: row.firstObservedAt,
    lastCcu: row.lastCcu,
    lastCcuAt: row.lastCcuAt,
    thumbnailUrl: row.thumbnailUrl,
    iconUrl: row.iconUrl,
  };
}

async function readDiscovery(db: Database, universeId: number): Promise<Discovery | null> {
  const [row] = await db
    .select({ source: discoverySources.source, detail: discoverySources.detail, firstSeenAt: discoverySources.firstSeenAt })
    .from(discoverySources)
    .where(eq(discoverySources.universeId, universeId))
    .orderBy(asc(discoverySources.firstSeenAt), asc(discoverySources.source), asc(discoverySources.detail))
    .limit(1);
  return row ?? null;
}

async function readRecentCcu(db: Database, universeId: number, now: Date, days: number): Promise<CcuPoint[]> {
  const rows = await db
    .select({ at: gameObservations.observedAt, ccu: gameObservations.ccu })
    .from(gameObservations)
    .where(
      and(
        eq(gameObservations.universeId, universeId),
        gt(gameObservations.observedAt, new Date(now.getTime() - days * dayMs)),
        lte(gameObservations.observedAt, now),
      ),
    )
    .orderBy(asc(gameObservations.observedAt));
  return rows;
}

// game_daily_all merges the v1 daily rows with the daily aggregate of the observations.
async function readDailyHistory(db: Database, universeId: number, now: Date): Promise<DailyPoint[]> {
  const result = await db.execute<{ day: Date | string; ccu_peak: number; ccu_avg: number; origin: "observed" | "legacy" }>(sql`
    select day, ccu_peak, ccu_avg, origin from game_daily_all
    where universe_id = ${universeId}::bigint and day <= ${now.toISOString()}::timestamptz
    order by day
  `);
  return result.rows.map((row) => ({
    day: new Date(row.day),
    peak: Number(row.ccu_peak),
    average: Number(row.ccu_avg),
    origin: row.origin,
  }));
}

async function readVersions(db: Database, universeId: number): Promise<VersionRecord[]> {
  return db
    .select({ kind: gameVersions.kind, name: gameVersions.name, observedAt: gameVersions.observedAt })
    .from(gameVersions)
    .where(eq(gameVersions.universeId, universeId))
    .orderBy(asc(gameVersions.observedAt), asc(gameVersions.id));
}

async function readChartPresence(
  db: Database,
  universeId: number,
  now: Date,
  config: typeof GAME_VIEW_CONFIG,
): Promise<ChartPresence[]> {
  const at = now.toISOString();
  const result = await db.execute<{
    sort_id: string;
    first_seen_at: Date | string;
    last_seen_at: Date | string;
    best_rank: number;
    best_rank_recent: number | null;
    hours_recent: number;
  }>(sql`
    select sort_id, min(observed_at) as first_seen_at, max(observed_at) as last_seen_at, min(rank)::int as best_rank,
      (min(rank) filter (
        where observed_at > ${at}::timestamptz - make_interval(hours => ${config.chartBestRankHours}::int)
      ))::int as best_rank_recent,
      (count(*) filter (
        where observed_at > ${at}::timestamptz - make_interval(days => ${config.chartRecentDays}::int)
      ))::int as hours_recent
    from chart_placements
    where universe_id = ${universeId}::bigint and observed_at <= ${at}::timestamptz
    group by sort_id
    order by first_seen_at, sort_id
  `);
  return result.rows.map((row) => ({
    sortId: row.sort_id,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    bestRank: row.best_rank,
    bestRankRecent: row.best_rank_recent,
    hoursRecent: row.hours_recent,
  }));
}

async function readLatestVotes(db: Database, universeId: number, now: Date): Promise<VoteReading | null> {
  const [row] = await db
    .select({ upVotes: voteObservations.upVotes, downVotes: voteObservations.downVotes, observedAt: voteObservations.observedAt })
    .from(voteObservations)
    .where(and(eq(voteObservations.universeId, universeId), lte(voteObservations.observedAt, now)))
    .orderBy(desc(voteObservations.observedAt))
    .limit(1);
  return row ?? null;
}

async function readEngagementWindow(db: Database, universeId: number, now: Date, days: number): Promise<EngagementWindow | null> {
  const at = now.toISOString();
  const result = await db.execute<{
    first_at: Date | string | null;
    last_at: Date | string | null;
    first_visits: string | null;
    last_visits: string | null;
    first_favorites: string | null;
    last_favorites: string | null;
    ccu_average: number | null;
  }>(sql`
    with window_observations as (
      select observed_at, visits, favorites from game_observations
      where universe_id = ${universeId}::bigint
        and observed_at > ${at}::timestamptz - make_interval(days => ${days}::int)
        and observed_at <= ${at}::timestamptz
    ),
    bounds as (
      select min(observed_at) as first_at, max(observed_at) as last_at,
        (array_agg(visits order by observed_at))[1] as first_visits,
        (array_agg(visits order by observed_at desc))[1] as last_visits,
        (array_agg(favorites order by observed_at))[1] as first_favorites,
        (array_agg(favorites order by observed_at desc))[1] as last_favorites
      from window_observations
    )
    select b.*, (
      select avg(h.ccu_avg) from game_hourly h
      where h.universe_id = ${universeId}::bigint
        and h.bucket >= time_bucket(interval '1 hour', b.first_at) and h.bucket <= b.last_at
    ) as ccu_average
    from bounds b
  `);
  const row = result.rows[0];
  if (!row?.first_at || !row.last_at) return null;
  return {
    firstAt: new Date(row.first_at),
    lastAt: new Date(row.last_at),
    firstVisits: Number(row.first_visits),
    lastVisits: Number(row.last_visits),
    firstFavorites: Number(row.first_favorites),
    lastFavorites: Number(row.last_favorites),
    ccuAverage: row.ccu_average === null ? null : Number(row.ccu_average),
  };
}
```

**Step 4: Commit, push, validate, CI**

```bash
git add src/lib/config.ts src/db/game-view.ts src/db/game-view.db.test.ts
git commit -m "feat(dashboard): read everything the game page shows"
```

### Task 8: Game view helpers (labels, timeline, engagement signals)

**Files:**
- Create: `src/lib/dashboard/labels.ts`, `src/lib/dashboard/timeline.ts`, `src/lib/dashboard/engagement.ts`
- Test: `src/lib/dashboard/labels.test.ts`, `src/lib/dashboard/timeline.test.ts`, `src/lib/dashboard/engagement.test.ts`

**Step 1: Write the failing tests**

`src/lib/dashboard/labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chartLabel, discoveryLabel } from "./labels";

describe("labels", () => {
  it("names the discovery sorts", () => {
    expect(chartLabel("top-trending")).toBe("Top Trending");
    expect(chartLabel("trending-in-roleplay-and-avatar-sim")).toBe("Trending in Roleplay & Avatar Sim");
  });

  it("describes how a game was found", () => {
    expect(discoveryLabel("rolimons", "")).toBe("Rolimon's list");
    expect(discoveryLabel("chart", "up-and-coming")).toBe("the Up & Coming chart");
    expect(discoveryLabel("search", "fake an egg")).toBe("a search for “fake an egg”");
    expect(discoveryLabel("recommendation", "10769384180")).toBe("recommendations from universe 10769384180");
  });
});
```

`src/lib/dashboard/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChartPresence, VersionRecord } from "@/db/game-view";
import { buildTimeline } from "./timeline";

const at = (day: number) => new Date(Date.UTC(2026, 9, day));

describe("buildTimeline", () => {
  it("lists renames, description and thumbnail changes and chart entries, newest first", () => {
    const versions: VersionRecord[] = [
      { kind: "metadata", name: "Fake an Egg", observedAt: at(10) },
      { kind: "thumbnail", name: null, observedAt: at(11) },
      { kind: "metadata", name: "Fake an Egg", observedAt: at(12) },
      { kind: "metadata", name: "[UPD] Fake an Egg", observedAt: at(14) },
      { kind: "thumbnail", name: null, observedAt: at(15) },
    ];
    const charts: ChartPresence[] = [
      { sortId: "up-and-coming", firstSeenAt: at(13), lastSeenAt: at(20), bestRank: 4, bestRankRecent: null, hoursRecent: 0 },
    ];
    expect(buildTimeline(versions, charts)).toEqual([
      { at: at(15), label: "Thumbnail changed" },
      { at: at(14), label: "Renamed “[UPD] Fake an Egg”" },
      { at: at(13), label: "Entered Up & Coming (best #4)" },
      { at: at(12), label: "Description changed" },
      { at: at(10), label: "Tracked as “Fake an Egg”" },
    ]);
  });
});
```

`src/lib/dashboard/engagement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChartPresence, EngagementWindow } from "@/db/game-view";
import { engagementSignals } from "./engagement";

const window: EngagementWindow = {
  firstAt: new Date("2026-10-19T00:00:00Z"),
  lastAt: new Date("2026-10-21T00:00:00Z"),
  firstVisits: 100_000,
  lastVisits: 196_000,
  firstFavorites: 5_000,
  lastFavorites: 5_480,
  ccuAverage: 1_000,
};

function chart(sortId: string, bestRankRecent: number | null, hoursRecent: number): ChartPresence {
  const seen = new Date("2026-10-20T00:00:00Z");
  return { sortId, firstSeenAt: seen, lastSeenAt: seen, bestRank: 1, bestRankRecent, hoursRecent };
}

describe("engagementSignals", () => {
  it("estimates the session length and favorites per visit over the window", () => {
    // 1,000 players × 48 h × 60 min / 96,000 visits = 30 minutes; 480 favorites per 96,000 visits = 5 per 1,000.
    expect(engagementSignals(window, null, [])).toMatchObject({
      windowHours: 48,
      newVisits: 96_000,
      sessionMinutes: 30,
      favoritesPerThousandVisits: 5,
    });
  });

  it("needs enough hours and new visits", () => {
    const short = { ...window, lastAt: new Date("2026-10-19T20:00:00Z") };
    expect(engagementSignals(short, null, [])).toMatchObject({ sessionMinutes: null, favoritesPerThousandVisits: null });
    const idle = { ...window, lastVisits: window.firstVisits };
    expect(engagementSignals(idle, null, [])).toMatchObject({ newVisits: 0, sessionMinutes: null });
    expect(engagementSignals(null, null, [])).toMatchObject({ windowHours: null, newVisits: null, sessionMinutes: null });
  });

  it("reads the like ratio and the chart ranks", () => {
    const signals = engagementSignals(null, { upVotes: 950, downVotes: 50, observedAt: window.lastAt }, [
      chart("top-earning", 12, 20),
      chart("top-playing-now", 30, 24),
      chart("top-revisited", null, 40),
    ]);
    expect(signals).toMatchObject({
      likeRatio: 0.95,
      upVotes: 950,
      downVotes: 50,
      earningRank: 12,
      playingRank: 30,
      revisitedRank: null,
      revisitedHours: 40,
    });
    expect(engagementSignals(null, { upVotes: 0, downVotes: 0, observedAt: window.lastAt }, []).likeRatio).toBeNull();
    expect(engagementSignals(null, null, []).revisitedHours).toBe(0);
  });
});
```

**Step 2: Run them to see them fail**: `npx vitest run src/lib/dashboard` → FAIL (modules missing).

**Step 3: Implement**

`src/lib/dashboard/labels.ts`:

```ts
// "trending-in-roleplay-and-avatar-sim" → "Trending in Roleplay & Avatar Sim".
export function chartLabel(sortId: string): string {
  return sortId
    .split("-")
    .map((word, index) => {
      if (word === "and") return "&";
      if (index > 0 && word === "in") return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// Completes "First seen through …".
export function discoveryLabel(source: string, detail: string): string {
  switch (source) {
    case "rolimons":
      return "Rolimon's list";
    case "chart":
      return `the ${chartLabel(detail)} chart`;
    case "search":
      return `a search for “${detail}”`;
    case "recommendation":
      return `recommendations from universe ${detail}`;
    default:
      return detail ? `${source} (${detail})` : source;
  }
}
```

`src/lib/dashboard/timeline.ts`:

```ts
import type { ChartPresence, VersionRecord } from "@/db/game-view";
import { chartLabel } from "./labels";

export interface TimelineEntry {
  at: Date;
  label: string;
}

// Newest first. Versions arrive oldest first: the first metadata version is the game as first tracked, and a later
// one either renames it or changes its description. The first thumbnail is no change; each later one is (thumbnail
// A/B tests).
export function buildTimeline(versions: readonly VersionRecord[], charts: readonly ChartPresence[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let tracked = false;
  let previousName: string | null = null;
  let thumbnails = 0;
  for (const version of versions) {
    if (version.kind === "metadata") {
      if (!tracked) entries.push({ at: version.observedAt, label: `Tracked as “${version.name ?? ""}”` });
      else if (version.name !== previousName) entries.push({ at: version.observedAt, label: `Renamed “${version.name ?? ""}”` });
      else entries.push({ at: version.observedAt, label: "Description changed" });
      tracked = true;
      previousName = version.name;
    } else {
      if (thumbnails > 0) entries.push({ at: version.observedAt, label: "Thumbnail changed" });
      thumbnails += 1;
    }
  }
  for (const chart of charts) {
    entries.push({ at: chart.firstSeenAt, label: `Entered ${chartLabel(chart.sortId)} (best #${chart.bestRank})` });
  }
  return entries.sort((left, right) => right.at.getTime() - left.at.getTime());
}
```

`src/lib/dashboard/engagement.ts`:

```ts
import type { ChartPresence, EngagementWindow, VoteReading } from "@/db/game-view";
import { GAME_VIEW_CONFIG } from "@/lib/config";

export interface EngagementSignals {
  windowHours: number | null;
  newVisits: number | null;
  sessionMinutes: number | null;
  favoritesPerThousandVisits: number | null;
  likeRatio: number | null;
  upVotes: number | null;
  downVotes: number | null;
  // Best ranks over the recent hours: earning above playing means the game earns more than its popularity.
  earningRank: number | null;
  playingRank: number | null;
  revisitedRank: number | null;
  revisitedHours: number;
}

type UsageSignals = Pick<EngagementSignals, "windowHours" | "newVisits" | "sessionMinutes" | "favoritesPerThousandVisits">;

// Average concurrent players × minutes gives player-minutes; divided by the visits started over the same time, it is
// the average session (Little's law).
function usageSignals(window: EngagementWindow | null, config: typeof GAME_VIEW_CONFIG): UsageSignals {
  if (!window) return { windowHours: null, newVisits: null, sessionMinutes: null, favoritesPerThousandVisits: null };
  const windowHours = (window.lastAt.getTime() - window.firstAt.getTime()) / 3_600_000;
  const newVisits = window.lastVisits - window.firstVisits;
  if (windowHours < config.engagementMinimumHours || newVisits <= 0) {
    return { windowHours, newVisits, sessionMinutes: null, favoritesPerThousandVisits: null };
  }
  return {
    windowHours,
    newVisits,
    sessionMinutes: window.ccuAverage === null ? null : (window.ccuAverage * windowHours * 60) / newVisits,
    favoritesPerThousandVisits: ((window.lastFavorites - window.firstFavorites) / newVisits) * 1_000,
  };
}

export function engagementSignals(
  window: EngagementWindow | null,
  votes: VoteReading | null,
  charts: readonly ChartPresence[],
  config = GAME_VIEW_CONFIG,
): EngagementSignals {
  const totalVotes = votes ? votes.upVotes + votes.downVotes : 0;
  const chart = (sortId: string) => charts.find((row) => row.sortId === sortId);
  return {
    ...usageSignals(window, config),
    likeRatio: votes && totalVotes > 0 ? votes.upVotes / totalVotes : null,
    upVotes: votes?.upVotes ?? null,
    downVotes: votes?.downVotes ?? null,
    earningRank: chart("top-earning")?.bestRankRecent ?? null,
    playingRank: chart("top-playing-now")?.bestRankRecent ?? null,
    revisitedRank: chart("top-revisited")?.bestRankRecent ?? null,
    revisitedHours: chart("top-revisited")?.hoursRecent ?? 0,
  };
}
```

**Step 4: Run the tests**: `npx vitest run src/lib/dashboard` → PASS.

**Step 5: Commit, push, validate, CI**

```bash
git add src/lib/dashboard/labels.ts src/lib/dashboard/labels.test.ts src/lib/dashboard/timeline.ts src/lib/dashboard/timeline.test.ts src/lib/dashboard/engagement.ts src/lib/dashboard/engagement.test.ts
git commit -m "feat(dashboard): derive the game page signals and timeline"
```

### Task 9: Health snapshot

**Files:**
- Modify: `src/lib/status-report.ts` (export `rateLimitTotals`, `statAt`, `formatStat`)
- Create: `src/lib/dashboard/health.ts`
- Test: `src/lib/status-report.test.ts` (one case), `src/lib/dashboard/health.db.test.ts`

**Step 1: Write the failing tests**

In `src/lib/status-report.test.ts`, add a case using the file's existing job summary helpers (`completed`, or whatever builds a `JobSummary` there):

```ts
describe("rateLimitTotals", () => {
  it("adds the 429s, requests and rate-limited runs of every job that records them", () => {
    // Build two summaries: one with http { rateLimitedResponses: 4, attempts: 100 } and rateLimitedRuns 1, one with
    // http { rateLimitedResponses: 0, attempts: 50 } and rateLimitedRuns 0, then:
    expect(rateLimitTotals(jobs)).toEqual({ responses: 4, attempts: 150, runs: 1, recorded: true });
    expect(rateLimitTotals([])).toEqual({ responses: 0, attempts: 0, runs: 0, recorded: false });
  });
});
```

Write the two summaries with the helpers the file already has; do not invent a new fixture style.

`src/lib/dashboard/health.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { JOB_NAMES } from "@/lib/jobs/types";
import { readHealth } from "./health";

describe.skipIf(!hasTestDatabase)("readHealth", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("reports every job, the coverage, the totals and the system of an empty database", async () => {
    const health = await readHealth(database.db, new Date());
    expect(health.jobs.map((job) => job.job)).toEqual([...JOB_NAMES]);
    expect(health.jobs.every((job) => job.latest === null)).toBe(true);
    expect(health.coverage.slot).toBeNull();
    expect(health.totals).toEqual({ games: 0, pollObservations: 0, censusRows: 0 });
    expect(health.rateLimits).toEqual({ responses: 0, attempts: 0, runs: 0, recorded: false });
    expect(health.system.diskUsedShare).toBeGreaterThan(0);
    expect(health.system.policies).toBeGreaterThan(0);
    // Test databases pause every TimescaleDB policy, which the system check reports.
    expect(health.system.ok).toBe(false);
    expect(health.system.problems.some((problem) => problem.includes("is paused"))).toBe(true);
  });
});
```

**Step 2: Implement**

In `src/lib/status-report.ts`, export `statAt` and `formatStat` (add `export`), and replace the totals part of `rateLimitLine` with an exported function:

```ts
export interface RateLimitTotals {
  responses: number;
  attempts: number;
  runs: number;
  // False when no job of the window recorded its HTTP figures.
  recorded: boolean;
}

// Failed runs keep no stats: the totals are a lower bound of the requests on the IP.
export function rateLimitTotals(jobs: readonly JobSummary[]): RateLimitTotals {
  const http = jobs.flatMap((job) => (job.recent.http ? [job.recent.http] : []));
  return {
    responses: http.reduce((total, metrics) => total + metrics.rateLimitedResponses, 0),
    attempts: http.reduce((total, metrics) => total + metrics.attempts, 0),
    runs: jobs.reduce((total, job) => total + (job.recent.rateLimitedRuns ?? 0), 0),
    recorded: http.length > 0,
  };
}

function rateLimitLine(jobs: readonly JobSummary[], windowHours: number): string {
  const { responses, attempts, runs, recorded } = rateLimitTotals(jobs);
  const share = attempts ? `${Math.round((responses / attempts) * 10_000) / 100}%` : "n/a";
  const requests = recorded ? `${counts.format(responses)}/${counts.format(attempts)} requests (${share})` : "no requests recorded";
  return `429s over the last ${windowHours} h: ${requests}; ${counts.format(runs)} rate-limited run${runs === 1 ? "" : "s"}`;
}
```

`src/lib/dashboard/health.ts`:

```ts
import { statfs } from "node:fs/promises";
import type { Database } from "@/db/client";
import { type CensusCoverage, censusCoverage, type DataTotals, dataTotals, type JobSummary, jobSummaries } from "@/db/status";
import { readArchiver, readTimescaleJobs } from "@/db/system-health";
import { STATUS_CONFIG } from "@/lib/config";
import { evaluateSystemHealth, type SystemHealthResult } from "@/lib/ops/system-check";
import { type RateLimitTotals, rateLimitTotals } from "@/lib/status-report";

export interface HealthSnapshot {
  windowHours: number;
  jobs: JobSummary[];
  coverage: CensusCoverage;
  totals: DataTotals;
  rateLimits: RateLimitTotals;
  system: SystemHealthResult & { diskUsedShare: number; lastArchivedAt: Date | null; policies: number };
}

// What `radar status` and `radar system-check` print, for the Health page. Backups and the restore test report to
// Healthchecks only: the dashboard cannot read pgBackRest.
export async function readHealth(db: Database, now: Date, config = STATUS_CONFIG): Promise<HealthSnapshot> {
  const windowHours = config.summaryWindowHours;
  const [jobs, coverage, totals, policies, archiver, disk] = await Promise.all([
    jobSummaries(db, now, windowHours),
    censusCoverage(db, now, {
      minimumCcu: config.coverageMinimumCcu,
      withinMinutes: config.trackedWithinMinutes,
      listWithinHours: windowHours,
    }),
    dataTotals(db, now, windowHours),
    readTimescaleJobs(db),
    readArchiver(db),
    statfs("/"),
  ]);
  // The share df reports: blocks reserved for root count as neither used nor available.
  const used = disk.blocks - disk.bfree;
  const diskUsedShare = used / (used + disk.bavail);
  const result = evaluateSystemHealth({ now, diskUsedShare, archiver, jobs: policies });
  return {
    windowHours,
    jobs,
    coverage,
    totals,
    rateLimits: rateLimitTotals(jobs),
    system: { ...result, diskUsedShare, lastArchivedAt: archiver.lastArchivedAt, policies: policies.length },
  };
}
```

If `scripts/system-check.ts` computes the disk share the same way, move that computation into a small exported function in `src/lib/ops/system-check.ts` (for example `diskUsedShare(stats)`) and use it in both places instead of duplicating it.

**Step 3: Run the unit tests**: `npx vitest run src/lib/status-report.test.ts` → PASS, report output unchanged.

**Step 4: Commit, push, validate, CI**

```bash
git add src/lib/status-report.ts src/lib/status-report.test.ts src/lib/dashboard/health.ts src/lib/dashboard/health.db.test.ts
git commit -m "feat(dashboard): gather the health snapshot"
```

(Add `src/lib/ops/system-check.ts` and `scripts/system-check.ts` to the commit if you extracted the disk share.)

### Task 10: App shell and shared components

**Files:**
- Modify: `src/components/Navigation.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/not-found.tsx`
- Create: `src/components/GameIcon.tsx`, `src/components/MetricCard.tsx`, `src/components/StatusBadge.tsx`

**Step 1: Navigation**

`src/components/Navigation.tsx`: the links become Radar (`/`, icon `TrendingUp`, also active on `/games/...`) and Health (`/health`, icon `Activity`); the footer text becomes `Classification and clusters arrive in phase 2.`

```tsx
"use client";

import { Activity, Radar, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Radar", icon: TrendingUp },
  { href: "/health", label: "Health", icon: Activity },
];

// Game pages open from the Radar, so they keep it highlighted.
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" || pathname.startsWith("/games/") : pathname.startsWith(href);
}

export function Navigation() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark"><Radar size={20} /></span>
        <span><span className="brand-title">Trend Radar</span><span className="brand-kicker">Roblox intelligence</span></span>
      </Link>
      <nav className="nav" aria-label="Main navigation">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={`nav-link ${isActive(pathname, href) ? "active" : ""}`}><Icon size={18} /><span>{label}</span></Link>
        ))}
      </nav>
      <div className="sidebar-footer"><strong>Radar v2</strong><span>Classification and clusters arrive in phase 2.</span></div>
    </aside>
  );
}
```

If `TrendingUp` or `Activity` is missing from the installed lucide-react, pick the closest existing icon (typecheck tells).

**Step 2: Layout and not-found**

In `src/app/layout.tsx`, the chip `Data core in progress` becomes `Times in UTC`. In `src/app/not-found.tsx`, `This page does not exist in radar v2.` stays, and the button reads `Return to the radar`.

**Step 3: Shared components**

`src/components/GameIcon.tsx`:

```tsx
import Image from "next/image";

// Roblox icons are small already: served as they are (unoptimized) rather than re-encoded by the server.
export function GameIcon({ url, name, size = "small" }: { url: string | null; name: string; size?: "small" | "large" }) {
  const pixels = size === "large" ? 76 : 42;
  const className = size === "large" ? "thumbnail large" : "thumbnail";
  if (!url) return <span className={className} aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? "?"}</span>;
  return <Image className={className} src={url} alt="" width={pixels} height={pixels} unoptimized />;
}
```

`src/components/MetricCard.tsx`:

```tsx
export function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | "warning";
}) {
  return (
    <div className="card metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone ?? ""}`}>{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}
```

`src/components/StatusBadge.tsx`:

```tsx
import type { JobStatus } from "@/lib/jobs/types";

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}
```

**Step 4: CSS**

Append to `src/app/globals.css`, before the first `@media` block:

```css
.badge.event { color: var(--orange); background: rgba(255,173,102,.08); }
.badge.new { color: var(--accent); background: rgba(132,240,193,.08); }
.badge.status-success { color: var(--accent); background: rgba(132,240,193,.08); }
.badge.status-degraded { color: var(--yellow); background: rgba(245,213,111,.08); }
.badge.status-failed { color: var(--red); background: rgba(255,114,125,.08); }
.badge.status-running { color: var(--blue); background: rgba(108,165,255,.08); }
.radar-filters { grid-template-columns: repeat(4, minmax(130px, 1fr)) auto; align-items: end; }
.stat-line { display: block; margin-top: 4px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.5; word-break: break-word; }
.signal-detail { display: block; margin-top: 5px; color: var(--muted); font-size: 10px; font-style: normal; line-height: 1.5; }
.timeline-time { color: var(--muted); font-size: 11px; white-space: nowrap; }
```

In the `max-width: 1120px` block add `.radar-filters { grid-template-columns: repeat(3, 1fr); }`; in the `max-width: 760px` block add `.radar-filters { grid-template-columns: repeat(2, 1fr); }` (the existing `.rising-filters` lines stay).

**Step 5: Build, commit, push, validate, CI**

Run: `npm run lint && npm run typecheck && npm run build` → no error.

```bash
git add src/components/Navigation.tsx src/components/GameIcon.tsx src/components/MetricCard.tsx src/components/StatusBadge.tsx src/app/layout.tsx src/app/not-found.tsx src/app/globals.css
git commit -m "feat(dashboard): add the radar and health navigation"
```

### Task 11: Health page

**Files:**
- Create: `src/app/health/page.tsx`

**Step 1: Implement**

```tsx
import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { dashboardDatabase } from "@/db/dashboard";
import type { JobSummary } from "@/db/status";
import { readHealth } from "@/lib/dashboard/health";
import { formatCount, formatElapsed, formatPercent, formatUtc } from "@/lib/format";
import { formatStat, hasStat, statAt, WATCHED_STATS } from "@/lib/status-report";

export const metadata: Metadata = { title: "Health" };

export default async function HealthPage() {
  await connection();
  const now = new Date();
  const { windowHours, jobs, coverage, totals, rateLimits, system } = await readHealth(dashboardDatabase(), now);
  const archived = system.lastArchivedAt ? `${formatElapsed(system.lastArchivedAt, now)} ago` : "never";
  const problems = system.problems.length;
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Health</p>
          <h1>Collection health</h1>
          <p className="page-subtitle">
            Job runs over the last {windowHours} hours, as of {formatUtc(now)}. Backups and the weekly restore test report
            to Healthchecks only.
          </p>
        </div>
      </div>
      <div className="grid grid-4">
        <MetricCard
          label="Coverage"
          value={formatPercent(coverage.listed ? coverage.tracked / coverage.listed : null)}
          detail={
            coverage.slot
              ? `${formatCount(coverage.tracked)} of ${formatCount(coverage.listed)} Rolimon's places at or above ${coverage.minimumCcu} CCU polled within ${coverage.withinMinutes} min`
              : `No complete Rolimon's list in the last ${windowHours} h`
          }
        />
        <MetricCard
          label="Games tracked"
          value={formatCount(totals.games)}
          detail={`${formatCount(totals.pollObservations)} poll observations and ${formatCount(totals.censusRows)} census rows in ${windowHours} h`}
        />
        <MetricCard
          label="Roblox 429s"
          value={rateLimits.recorded ? `${formatCount(rateLimits.responses)} / ${formatCount(rateLimits.attempts)}` : "—"}
          tone={rateLimits.runs > 0 ? "warning" : undefined}
          detail={
            rateLimits.recorded
              ? `${formatPercent(rateLimits.attempts ? rateLimits.responses / rateLimits.attempts : null, 2)} of requests; ${formatCount(rateLimits.runs)} rate-limited runs`
              : "No requests recorded"
          }
        />
        <MetricCard
          label="System"
          value={system.ok ? "OK" : `${problems} problem${problems === 1 ? "" : "s"}`}
          tone={system.ok ? "positive" : "negative"}
          detail={`Disk ${formatPercent(system.diskUsedShare)} used; WAL archived ${archived}; ${system.policies} TimescaleDB policies`}
        />
      </div>
      {problems ? (
        <section className="section grid">
          {system.problems.map((problem) => (
            <div className="alert" key={problem}><AlertTriangle size={16} /><span>{problem}</span></div>
          ))}
        </section>
      ) : null}
      <section className="section">
        <div className="section-heading"><h2>Jobs</h2></div>
        <div className="card table-shell">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Latest run</th><th>Last completed</th><th>Runs</th><th>Degraded</th><th>Failed</th>
                  <th>429s / requests</th><th>Details</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => <JobRow key={job.job} job={job} now={now} />)}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function JobRow({ job, now }: { job: JobSummary; now: Date }) {
  const watched = WATCHED_STATS[job.job];
  const stats = job.lastCompleted?.stats;
  return (
    <tr>
      <td><strong>{job.job}</strong></td>
      <td>
        {job.latest ? (
          <><StatusBadge status={job.latest.status} /><span className="table-subline">{formatElapsed(job.latest.startedAt, now)} ago</span></>
        ) : "never"}
      </td>
      <td>
        {job.lastCompleted ? (
          <><StatusBadge status={job.lastCompleted.status} /><span className="table-subline">{formatElapsed(job.lastCompleted.finishedAt, now)} ago</span></>
        ) : "never"}
      </td>
      <td>{formatCount(job.recent.runs)}</td>
      <td className={job.recent.degraded ? "warning" : undefined}>{formatCount(job.recent.degraded)}</td>
      <td className={job.recent.failed ? "negative" : undefined}>{formatCount(job.recent.failed)}</td>
      <td>{job.recent.http ? `${formatCount(job.recent.http.rateLimitedResponses)} / ${formatCount(job.recent.http.attempts)}` : "—"}</td>
      <td>
        {watched && stats ? (
          <span className="stat-line">{watched.values.map((path) => `${path}=${formatStat(statAt(stats, path))}`).join(" ")}</span>
        ) : null}
        {watched && stats
          ? (watched.messages ?? [])
              .filter((path) => hasStat(stats, path))
              .map((path) => <span className="stat-line warning" key={path}>{path}: {formatStat(statAt(stats, path))}</span>)
          : null}
        {job.lastError ? (
          <span className="stat-line negative">Error {formatElapsed(job.lastError.startedAt, now)} ago: {job.lastError.message}</span>
        ) : null}
      </td>
    </tr>
  );
}
```

**Step 2: Build, commit, push, validate, CI**

Run: `npm run lint && npm run typecheck && npm run build`. Expected: `/health` listed as a dynamic route (ƒ), no database access during the build.

```bash
git add src/app/health/page.tsx
git commit -m "feat(dashboard): add the health page"
```

### Task 12: Radar page

**Files:**
- Create: `src/components/RisingGamesTable.tsx`
- Modify: `src/app/page.tsx` (replace the placeholder)

**Step 1: The table**

`src/components/RisingGamesTable.tsx`:

```tsx
import Link from "next/link";
import type { RisingGame } from "@/db/radar";
import { ACTIVE_SET_CONFIG, RADAR_CONFIG } from "@/lib/config";
import { formatCompact, formatCount, formatDay, formatElapsed, formatHours, formatMultiplier } from "@/lib/format";
import { GameIcon } from "./GameIcon";

export function RisingGamesTable({ games, asOf }: { games: RisingGame[]; asOf: Date }) {
  if (games.length === 0) return <div className="empty">No game matches these filters.</div>;
  const { start, middle, end } = RADAR_CONFIG.velocityThresholds;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>CCU</th>
            <th>Peak</th>
            <th>vs last week</th>
            <th>vs day before</th>
            <th>{formatCompact(start)} → {formatCompact(middle)}</th>
            <th>{formatCompact(middle)} → {formatCompact(end)}</th>
            <th>Signals</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={game.universeId}>
              <td>
                <Link className="game-cell" href={`/games/${game.universeId}`}>
                  <GameIcon url={game.iconUrl} name={game.name} />
                  <div>
                    <strong>{game.name}</strong>
                    <span>Created {formatDay(game.robloxCreatedAt)} · {formatElapsed(game.robloxCreatedAt, asOf)} old</span>
                  </div>
                </Link>
              </td>
              <td>
                <strong>{formatCount(game.ccuLast ?? game.ccuAverage)}</strong>
                <span className="table-subline">
                  {formatCount(game.ccuAverage)} on average over {game.samples} h
                  {game.ccuLastAt ? ` · read ${formatElapsed(game.ccuLastAt, asOf)} ago` : ""}
                </span>
              </td>
              <td>{formatCount(game.ccuPeak)}</td>
              <td><WeekGrowth game={game} /></td>
              <td>
                {formatMultiplier(game.dayGrowth)}
                <span className="table-subline">{game.previousSamples} h the day before</span>
              </td>
              <td>{formatHours(game.hoursToMiddle)}</td>
              <td>{formatHours(game.hoursToEnd)}</td>
              <td>
                {game.isEvent ? (
                  <span className="badge event" title={`Hourly peak ${formatCount(game.windowPeak)} against a median of ${formatCount(game.windowMedian)}`}>Event</span>
                ) : null}
                <span className="table-subline">First seen at {formatCount(game.firstSeenCcu)} CCU</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "tracked": the game's share against the same hours a week earlier; "new": created since; "untracked": the radar read
// some game in every hour a week earlier but not this one, so it had fewer players than the active-set minimum;
// "unknown": no baseline (v1 hours).
function WeekGrowth({ game }: { game: RisingGame }) {
  switch (game.weekBaseline) {
    case "tracked":
      return (
        <>
          {game.weekGrowth === null ? "from 0" : formatMultiplier(game.weekGrowth)}
          <span className="table-subline">{game.weekSamples} h paired a week earlier</span>
        </>
      );
    case "new":
      return <span className="badge new">New</span>;
    case "untracked":
      return (
        <>
          from under {formatCount(ACTIVE_SET_CONFIG.minimumCcu)}
          <span className="table-subline">Below the tracking minimum a week earlier</span>
        </>
      );
    default:
      return <>—<span className="table-subline">No reading a week earlier</span></>;
  }
}
```

**Step 2: The page**

`src/app/page.tsx`:

```tsx
import type { Metadata } from "next";
import { connection } from "next/server";
import { RisingGamesTable } from "@/components/RisingGamesTable";
import { dashboardDatabase } from "@/db/dashboard";
import { type RadarSort, risingGames } from "@/db/radar";
import { RADAR_CONFIG } from "@/lib/config";
import { parseRadarQuery, toDateTimeInput } from "@/lib/dashboard/radar-query";
import { formatCount, formatUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Radar" };

const sortLabels: Record<RadarSort, string> = {
  growth: "Growth vs last week",
  acceleration: "Growth vs the day before",
  ccu: "CCU",
  age: "Newest",
};

export default async function RadarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const now = new Date();
  const query = parseRadarQuery(await searchParams, now);
  const asOf = query.asOf ?? now;
  const games = await risingGames(dashboardDatabase(), {
    asOf,
    maxAgeDays: query.maxAgeDays,
    minimumCcu: query.minimumCcu,
    sort: query.sort,
    limit: RADAR_CONFIG.pageSize,
  });
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Radar</p>
          <h1>Rising games</h1>
          <p className="page-subtitle">
            Games created within {query.maxAgeDays} days with at least {formatCount(query.minimumCcu)} CCU on average over
            the last {RADAR_CONFIG.windowHours} whole hours, as of {formatUtc(asOf)}. Growth vs last week compares each
            game&apos;s share of tracked CCU with the same hours a week earlier, so weekends do not count as growth.
          </p>
        </div>
      </div>
      <div className="card table-shell">
        <form className="filters radar-filters" method="get">
          <div className="field">
            <label htmlFor="age">Created within</label>
            <select id="age" name="age" className="select" defaultValue={query.maxAgeDays}>
              {RADAR_CONFIG.ageOptionsDays.map((days) => <option key={days} value={days}>{days} days</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="minCcu">Minimum CCU</label>
            <select id="minCcu" name="minCcu" className="select" defaultValue={query.minimumCcu}>
              {RADAR_CONFIG.minimumCcuOptions.map((ccu) => <option key={ccu} value={ccu}>{formatCount(ccu)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sort">Sort by</label>
            <select id="sort" name="sort" className="select" defaultValue={query.sort}>
              {Object.entries(sortLabels).map(([sort, label]) => <option key={sort} value={sort}>{label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="asOf">As of (UTC, empty for now)</label>
            <input id="asOf" name="asOf" type="datetime-local" className="input" defaultValue={query.asOf ? toDateTimeInput(query.asOf) : ""} max={toDateTimeInput(now)} />
          </div>
          <button className="button primary" type="submit">Apply</button>
        </form>
        <RisingGamesTable games={games} asOf={asOf} />
      </div>
    </div>
  );
}
```

**Step 3: Build, commit, push, validate, CI**

Run: `npm run lint && npm run typecheck && npm run build`. Expected: `/` is dynamic (ƒ).

```bash
git add src/components/RisingGamesTable.tsx src/app/page.tsx
git commit -m "feat(dashboard): add the radar page"
```

### Task 13: Game page

**Files:**
- Create: `src/app/games/[universeId]/page.tsx`

**Step 1: Implement**

```tsx
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GameIcon } from "@/components/GameIcon";
import { InteractiveAreaChart } from "@/components/InteractiveAreaChart";
import { MetricCard } from "@/components/MetricCard";
import { dashboardDatabase } from "@/db/dashboard";
import { readGameView } from "@/db/game-view";
import { GAME_VIEW_CONFIG } from "@/lib/config";
import { engagementSignals } from "@/lib/dashboard/engagement";
import { discoveryLabel } from "@/lib/dashboard/labels";
import { buildTimeline } from "@/lib/dashboard/timeline";
import { formatCount, formatDay, formatElapsed, formatHours, formatPercent, formatUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Game" };

// Canonical universe ids only, small enough to stay exact as numbers.
const universeIdPattern = /^[1-9]\d{0,15}$/;

export default async function GamePage({ params }: { params: Promise<{ universeId: string }> }) {
  await connection();
  const { universeId } = await params;
  if (!universeIdPattern.test(universeId)) notFound();
  const now = new Date();
  const view = await readGameView(dashboardDatabase(), Number(universeId), now);
  if (!view) notFound();
  const { game, discovery } = view;
  const signals = engagementSignals(view.engagement, view.votes, view.charts);
  const timeline = buildTimeline(view.versions, view.charts).slice(0, GAME_VIEW_CONFIG.timelineEntries);
  const peak = view.daily.reduce((best, day) => Math.max(best, day.peak), 0);
  return (
    <div className="content">
      <div className="detail-hero">
        <GameIcon url={game.iconUrl} name={game.name} size="large" />
        <div className="detail-hero-copy">
          <p className="eyebrow">Game</p>
          <h1>{game.name}</h1>
          <p className="page-subtitle">
            By {game.creatorName}{game.genre ? ` · ${game.genre}` : ""} · created {formatDay(game.robloxCreatedAt)}, {formatElapsed(game.robloxCreatedAt, now)} ago
          </p>
        </div>
        <div className="detail-actions">
          <a className="button" href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noreferrer"><ExternalLink size={14} />Roblox</a>
          <Link className="button" href="/">Radar</Link>
        </div>
      </div>

      <div className="grid grid-4">
        <MetricCard label="CCU now" value={formatCount(game.lastCcu)} detail={game.lastCcuAt ? `Polled ${formatElapsed(game.lastCcuAt, now)} ago` : "Never polled"} />
        <MetricCard label="Peak CCU" value={formatCount(peak)} detail="Highest daily peak since tracking" />
        <MetricCard
          label="Like ratio"
          value={formatPercent(signals.likeRatio)}
          detail={signals.upVotes === null ? "No votes recorded" : `${formatCount(signals.upVotes)} up · ${formatCount(signals.downVotes)} down`}
        />
        <MetricCard
          label="First seen by the radar"
          value={formatDay(game.firstObservedAt)}
          detail={discovery ? `Through ${discoveryLabel(discovery.source, discovery.detail)}` : "Before v2 recorded discoveries"}
        />
      </div>

      <section className="section card chart-card">
        <div className="chart-header"><h2>Last {GAME_VIEW_CONFIG.recentDays} days</h2><span>Every observation</span></div>
        {view.recent.length ? (
          <InteractiveAreaChart
            data={view.recent.map((point) => ({ timestamp: point.at.toISOString(), value: point.ccu }))}
            color="#84f0c1"
            valueLabel="CCU"
            yAxisLabel="CCU"
            xAxisLabel="Time (UTC)"
          />
        ) : <div className="empty">No observation in this window.</div>}
      </section>

      <section className="section card chart-card">
        <div className="chart-header"><h2>Daily peak</h2><span>Since the radar first tracked the game</span></div>
        {view.daily.length ? (
          <InteractiveAreaChart
            data={view.daily.map((day) => ({ timestamp: day.day.toISOString(), value: day.peak }))}
            color="#6ca5ff"
            valueLabel="CCU"
            yAxisLabel="Peak CCU"
            xAxisLabel="Day (UTC)"
          />
        ) : <div className="empty">No daily history yet.</div>}
      </section>

      <div className="section grid grid-2">
        <div className="card card-pad">
          <h2>Signals</h2>
          <div className="metadata">
            <Signal
              label="Session length"
              value={signals.sessionMinutes === null ? "—" : `${Math.round(signals.sessionMinutes)} min`}
              detail={
                signals.windowHours === null
                  ? `No observation in the last ${GAME_VIEW_CONFIG.engagementDays} days`
                  : `Average CCU × time / new visits over ${formatHours(signals.windowHours)} (${formatCount(signals.newVisits)} new visits); needs ${GAME_VIEW_CONFIG.engagementMinimumHours} h`
              }
            />
            <Signal
              label="Favorites per 1,000 new visits"
              value={signals.favoritesPerThousandVisits === null ? "—" : signals.favoritesPerThousandVisits.toFixed(1)}
              detail={`Over the same ${GAME_VIEW_CONFIG.engagementDays}-day window`}
            />
            <Signal
              label="Monetization"
              value={signals.earningRank === null ? "Not in Top Earning" : `Earning #${signals.earningRank} · Playing #${signals.playingRank ?? "—"}`}
              detail={`Best ranks over the last ${GAME_VIEW_CONFIG.chartBestRankHours} h: an earning rank above the playing rank means the game earns more than its popularity`}
            />
            <Signal
              label="Retention"
              value={signals.revisitedRank === null ? "Not in Top Revisited" : `Top Revisited #${signals.revisitedRank}`}
              detail={`${formatCount(signals.revisitedHours)} h in Top Revisited over ${GAME_VIEW_CONFIG.chartRecentDays} days`}
            />
          </div>
        </div>
        <div className="card card-pad">
          <h2>Timeline</h2>
          {timeline.length ? (
            <div className="list">
              {timeline.map((entry, index) => (
                <div className="list-row" key={`${entry.at.getTime()}-${index}`}>
                  <div className="list-row-main"><strong>{entry.label}</strong></div>
                  <span className="timeline-time">{formatUtc(entry.at)}</span>
                </div>
              ))}
            </div>
          ) : <div className="empty">No change recorded yet.</div>}
        </div>
      </div>
    </div>
  );
}

function Signal({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metadata-row">
      <span>{label}</span>
      <strong>{value}</strong>
      <em className="signal-detail">{detail}</em>
    </div>
  );
}
```

**Step 2: Build, commit, push, validate, CI**

Run: `npm run lint && npm run typecheck && npm run build`. Expected: `/games/[universeId]` is dynamic (ƒ).

```bash
git add "src/app/games/[universeId]/page.tsx"
git commit -m "feat(dashboard): add the game page"
```

### Task 14: Documentation

**Files:**
- Modify: `docs/plans/2026-10-20-radar-v2-design.md`, `docs/operations.md`, `README.md`, this plan (Execution notes)

**Step 1: Design document**

- Header line: add `Updated on 2026-10-22 for the first dashboard (sections 3, 5A, 6 and 7).`
- Section 3, the quality gates bullet: add `or the same list as the latest one read (Rolimon's serving the previous slot again, which happened in 2 of the first 44 runs; such a list is not stored)`.
- Section 5A: replace the four bullets with the implemented definitions: `rising_games(as_of, …)` in `drizzle/0007_rising_games.sql`; windows of whole UTC hours (24 by default), every interval in hours so a session time zone cannot shift them; weekday-safe growth as the game's share against the same hour one week earlier, over the hours where both readings exist and among the games read in both (which cancels a game's own daily cycle on sparse v1 hours and the v1-to-v2 change of tracked games), sorted by a smoothed log score; `week_baseline` `tracked`, `new` (created since), `untracked` (the radar read some game in every hour a week earlier, so this one was below the active-set minimum; counted from 0) or `unknown` (no score); acceleration as the window's average against the window before it; velocity from one hourly reading per game (poll, or census of its places), measured only when the reading before each crossing is at most `velocityMaximumGapHours` older; the event flag against the median hourly CCU of the same window (a seven-day median would flag every hour of a fast organic rise), with at least 12 hourly samples; sample sizes returned for every metric; game metadata is today's, not as_of's.
- Section 6: add a `First version (2026-10-22)` paragraph: Radar without the cluster column and filter or the watchlist filter; Game page with the curves, timeline (title, description and thumbnail changes and chart entries as a list rather than chart annotations), engagement, monetization and retention signals, without the classification card or similar games; Health page without backup and restore-test status (Healthchecks only); `asOf` on the Radar page instead of the global date selector.
- Section 7, delivery phases: note that the first dashboard pages ship between phases 1 and 2, and that phase 4 completes them.

**Step 2: Runbook (`docs/operations.md`)**

- Dashboard section: list the pages (`/` Radar, `/games/<universe id>`, `/health`), the read-only session (`radar-web` in `pg_stat_activity`, `default_transaction_read_only`, 15 s statement timeout), and how to view it locally against production without writing anything: open the analysis tunnel (`ssh -N -L 15432:/var/run/postgresql/.s.PGSQL.5432 radar-analysis`) and run `DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npm run dev`.
- Analysis sessions: add an example call with the configured values:
  ```sql
  select universe_id, name, ccu_avg, week_baseline, week_growth, week_growth_score, day_growth, is_event, samples, week_samples
  from rising_games(as_of => now(), max_age_days => 30, min_ccu => 100, window_hours => 24, smoothing_ccu => 100,
    event_peak_ratio => 3, event_min_samples => 12, velocity_start => 100, velocity_middle => 1000, velocity_end => 10000,
    velocity_max_gap_hours => 2)
  order by week_growth_score desc nulls last, ccu_avg desc limit 25;
  ```
  with the note that the values come from `RADAR_CONFIG` in `src/lib/config.ts`.

**Step 3: README**

Add a `Dashboard` section (or extend the existing one) listing the three pages and the local tunnel command, and mention `rising_games` where the README lists the database objects or views, if it does.

**Step 4: Execution notes**

Fill this plan's Execution notes with what differed from the plan (commits, surprises, CI facts).

**Step 5: Commit, push, validate, CI**

```bash
git add docs/plans/2026-10-20-radar-v2-design.md docs/operations.md README.md docs/plans/2026-10-22-radar-v2-dashboard-first-version.md
git commit -m "docs: describe the first dashboard"
```

# Part B: production (controller only)

### Task 15: Local check against production data (read-only)

1. `ssh -f -N -L 15432:/var/run/postgresql/.s.PGSQL.5432 radar-analysis` (read-only role, peer authentication).
2. `DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npx next dev --port 3100` in the background.
3. `curl -s -o /dev/null -w "%{http_code}\n"` on `/health` and `/games/10765298801`: 200. The Radar page needs `rising_games`, which reaches production only with the deploy: expect an error there until Task 16.
4. Look at the pages (the `run` skill can screenshot them), fix what looks wrong on the branch, then stop the dev server and the tunnel.

### Task 16: Deploy after the phase 1b observation

1. Not before 2026-10-22 15:47 UTC (the end of the B7 24-hour observation). Run B7's close-out first (phase 1b plan, Task B7) and commit its notes on `dashboard`.
2. `git fetch origin && git merge-base --is-ancestor origin/radar-v2 dashboard` (radar-v2 must not have moved), then `git push origin dashboard:radar-v2`. Mark the draft pull request ready and let the merge record it, or close it once `radar-v2` holds the commits.
3. Watch CI, then the deploy: `ssh radar-prod 'readlink /opt/radar/current; journalctl -u radar-deploy -n 40 -o cat'` shows the new commit and `Deployed`; the migration paused the job timers for at most 5 minutes.
4. Verify:
   - `ssh radar-prod radar status`: no failed run; census shows `listQuality`, poll shows `medianTailDetailsMinutes` around 20–30.
   - `ssh radar-prod 'for p in / /health /games/10765298801; do curl -s -o /dev/null -w "%{http_code} $p\n" http://127.0.0.1:3000$p; done'`: 200 everywhere.
   - `EXPLAIN (ANALYZE, BUFFERS)` of the Radar call through `radar-analysis`: well under the 15 s statement timeout.
   - The owner opens `https://radar-prod.tail6e77de.ts.net` on the PC and on the phone.
5. Update the project memory (radar-v2 status: first dashboard live).

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)

- **Task 1** (`b8bced7`, `df9b8e8`, `cd9d67b`): a repeated list is compared only with the latest fingerprint of an *earlier* slot within 6 hours (a retry in the same slot must not see its own list as a repeat). `latestRunWithStat` takes `{ value?, slotBefore? }`; without `value` it matches any string stat. A repeated list is not stored, `listQuality` is `"repeated"`, and `listFingerprint` is null on an outage.
- **Task 2** (`464bcbb`): as planned; the deadline test expects a median of 0.
- **Task 5** (`5b4cfca`, `3097bc2`, `05f277b`): review changed the plan's function in two places. Every interval is in hours (a day interval follows the session time zone across a DST change; a Europe/Paris test covers it). The week-ago comparison pairs hours read in both windows, among the games read in both, and returns `week_baseline` (`tracked`, `new`, `untracked`, `unknown`); velocity needs the reading before a crossing within `velocityMaximumGapHours`. Validated read-only on production with the function body inlined: 0.38 s for 30 days, 0.53 s for 90 days.
- **Task 7** (`c7f55a6`): `ChartPresence` gained `bestRankRecent` and `hoursRecent`, computed over hour-based windows.
- **Task 9** (`e35a206`, `e14d1c2`): the disk share moved to `diskUsedShare()` in `src/lib/ops/system-check.ts`, shared with `scripts/system-check.ts`.
- **Tasks 10–13** (`e1f4b09`, `f000bc4`, `da542eb`, `a1799e9`): written by the controller from the code blocks. Differences: the phone navigation uses as many columns as links instead of six; the Health page's card reads "Games known" (the total is every game in `games`, not the active set) and its coverage detail adds the list age, as `radar status` does.
- **Task 14**: the README's `npm run status` row also moved to the median tail details age, which Task 2 had left.
- CI runs the database suites only in CI; each task's suites were checked in the `npm run test` log. `npm run validate` locally: 320 tests passed, 193 database tests skipped.
- **2026-10-22 13:30 UTC**: before Task 15, `radar-prod` was offline in Tailscale since 10:06 UTC (SSH over the tailnet timed out; public addresses do not answer by design). Tasks 15 and 16 wait for the server.
