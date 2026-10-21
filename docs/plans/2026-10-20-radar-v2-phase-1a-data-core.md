# Radar v2 Phase 1a (Data Core) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the v1 radar code on the `radar-v2` branch with the v2 data core: TimescaleDB schema, six idempotent collectors (`census`, `poll`, `votes`, `charts`, `explore`, `thumbnails`), a job runner with Healthchecks pings, the legacy history import from Aiven, and a status CLI.

**Architecture:** One PostgreSQL 18 + TimescaleDB database. Drizzle defines regular tables and hypertable base tables. A custom SQL migration turns four tables into compressed hypertables and adds continuous aggregates. Every collector is a `JobDefinition` run by `executeJob`, which records `job_runs`, pings Healthchecks and enforces a timeout. Collectors receive their API clients as dependencies, so tests use fakes. Phase 1b (separate plan) provisions the server, the systemd timers, backups and deployment.

**Tech Stack:** Node.js 22, TypeScript 6, Next.js 16 (shell only in this phase), drizzle-orm 0.45 / drizzle-kit 0.31, `pg`, zod 4, Vitest 4, TimescaleDB 2.30 on PostgreSQL 18.

**Design reference:** `docs/plans/2026-10-20-radar-v2-design.md`.

---

## Ground rules for the executor

- Work in the worktree `/home/playfade/dev/roblox-trends/.worktrees/radar-v2` on branch `radar-v2`. The v1 collector keeps running from `main`; never push to `main` from this plan.
- `.env.local` in the worktree contains `LEGACY_DATABASE_URL` (the v1 Aiven production database). Never rename it back to `DATABASE_URL`. `src/db/migrate.ts` refuses to migrate a database that holds v1 tables, as a second safety net.
- All code, comments, tests and docs are in English. Commits follow Conventional Commits.
- **Database tests.** Files named `*.db.test.ts` run only when `TEST_DATABASE_URL` points to a PostgreSQL 18 + TimescaleDB server where the user can create databases. Each test file creates and drops its own database. CI provides this server, and `src/db/test-database.ts` fails the run in CI if the variable is missing. Locally, put the variable in `.env.test.local`: `@next/env` skips `.env.local` when `NODE_ENV=test`, which Vitest sets. Never copy `LEGACY_DATABASE_URL` into `.env.test.local`. Without a local server these suites are reported as skipped. In that case, push the branch after each database task and confirm in CI: `git push origin radar-v2 && gh run watch --exit-status`.
- Fixtures (fake games) are written only into these disposable test databases, never into an application database.
- Before the final handoff: `npm run lint && npm run typecheck && npm run test && npm run build`.

## Task 0 (optional, owner): local TimescaleDB for database tests

Only needed to run database tests locally instead of in CI. Run in a terminal on the WSL machine:

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | sudo bash
sudo apt-get install -y postgresql-18 timescaledb-2-postgresql-18
sudo timescaledb-tune --yes --quiet --pg-config=/usr/lib/postgresql/18/bin/pg_config
sudo pg_ctlcluster 18 main restart
sudo -u postgres psql -p 5433 -c "ALTER USER postgres PASSWORD 'postgres';"
```

PostgreSQL 16 already listens on 5432, so the new cluster listens on 5433. Then create the worktree file `.env.test.local` (git-ignored by the `.env*.local` rule) containing only:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
```

---

### Task 1: Clear v1 code from the branch and set up CI for TimescaleDB

**Files:**
- Delete: v1 modules listed in Step 1
- Create: `src/lib/title.ts`, `src/lib/title.test.ts`
- Rewrite: `src/lib/config.ts`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/components/Navigation.tsx`, `next.config.ts`, `vitest.config.ts`, `.github/workflows/ci.yml`
- Modify: `package.json`

**Step 1: Delete v1 code**

```bash
git rm -r -q src/app/api src/app/games src/app/ideas src/app/rising src/app/settings src/app/trends
git rm -q src/components/GameList.tsx src/components/IdeaLab.tsx src/components/SettingsForm.tsx \
  src/components/TagEditor.tsx src/components/TrendCard.tsx src/components/ui.tsx src/proxy.ts
find src/lib -maxdepth 1 -type f ! -name logger.ts ! -name config.ts -print0 | xargs -0 git rm -q
find src/db -maxdepth 1 -type f ! -name 'connection-url*' -print0 | xargs -0 git rm -q
git rm -r -q scripts drizzle
git rm -q .github/workflows/analyze.yml .github/workflows/collect.yml .github/workflows/daily.yml \
  .github/workflows/scheduler.yml docs/scheduler-operations.md Dockerfile .dockerignore render.yaml
npm uninstall @electric-sql/pglite
```

Expected: `ls src/lib` shows only `api config.ts logger.ts`, and `ls src/db` shows `connection-url.test.ts connection-url.ts`.

**Step 2: Write the failing title test**

Create `src/lib/title.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeTitle } from "./title";

describe("normalizeTitle", () => {
  it("removes emoji and promotional markers without losing the concept", () => {
    expect(normalizeTitle("[🔥 UPDATE 2] 🐒 +1 Speed Monkey Escape!")).toBe("+1 Speed Monkey Escape");
  });

  it("keeps meaningful bracketed text", () => {
    expect(normalizeTitle("[Horror] Kitty House")).toBe("Horror Kitty House");
  });

  it("drops an emoji-only seasonal marker", () => {
    expect(normalizeTitle("[🎃] +1 Stone Skipping")).toBe("+1 Stone Skipping");
  });
});
```

Run: `npx vitest run src/lib/title.test.ts`
Expected: FAIL, cannot resolve `./title`.

**Step 3: Create `src/lib/title.ts`** (moved from the v1 classifier)

```ts
const PROMOTIONAL_MARKERS = [
  "update",
  "updated",
  "new",
  "admin abuse",
  "event",
  "codes",
  "code",
  "release",
  "beta",
  "alpha",
  "x2",
  "2x",
  "x3",
  "3x",
  "upd",
];

export function normalizeTitle(title: string): string {
  let normalized = title.normalize("NFKC").replace(/\p{Extended_Pictographic}|️|‍/gu, " ");
  normalized = normalized.replace(/[\[({【][^\])}】]{0,48}[\])}】]/g, (marker) => {
    const content = marker.slice(1, -1).toLowerCase();
    return PROMOTIONAL_MARKERS.some((word) => content.includes(word)) ? " " : marker;
  });
  normalized = normalized.replace(
    new RegExp(`^(?:${PROMOTIONAL_MARKERS.map(escapeRegExp).join("|")})[!:\\-\\s]+`, "i"),
    "",
  );
  return normalized
    .replace(/[^\p{L}\p{N}+'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

Run: `npx vitest run src/lib/title.test.ts`
Expected: PASS (3 tests).

**Step 4: Rewrite `src/lib/config.ts`**

```ts
export const ROBLOX_DISCOVERY_CHARTS = [
  "top-trending",
  "up-and-coming",
  "top-playing-now",
  "fun-with-friends",
  "top-revisited",
  "trending-in-simulation",
  "trending-in-survival",
  "trending-in-action",
  "trending-in-rpg",
  "trending-in-shooter",
  "trending-in-strategy",
  "trending-in-sports-and-racing",
  "trending-in-roleplay-and-avatar-sim",
  "trending-in-party-and-casual",
  "trending-in-obby-and-platformer",
  "trending-in-puzzle",
  "trending-in-shopping",
  "trending-in-entertainment",
  "top-rated",
  "most-popular",
  "top-paid-access",
  "top-earning",
] as const;

export type RobloxDiscoveryChart = (typeof ROBLOX_DISCOVERY_CHARTS)[number];

export const EXTERNAL_REQUEST_CONFIG = {
  defaultTimeoutMs: 10_000,
  defaultRetries: 3,
  rateLimitBaseDelayMs: 5_000,
  serverErrorBaseDelayMs: 500,
  maximumRetryDelayMs: 60_000,
  retryJitterMs: 750,
  minimumIntervalByHost: {
    "apis.roblox.com": 1_300,
    "games.roblox.com": 500,
    "thumbnails.roblox.com": 500,
  } satisfies Record<string, number>,
} as const;

export const ROBLOX_REGION = {
  country: process.env.ROBLOX_COUNTRY || "all",
  device: process.env.ROBLOX_DEVICE || "computer",
} as const;

// Intervals must match the systemd timers installed in phase 1b.
export const JOB_CONFIG = {
  census: {
    intervalMinutes: 10,
    timeoutMs: 9 * 60_000,
    promotionMinimumCcu: 100,
    resolutionBudgetMs: 150_000,
    resolutionRetryDays: 7,
    maximumListSizeChange: 0.3,
  },
  poll: {
    intervalMinutes: 5,
    timeoutMs: 270_000,
    deadlineMs: 240_000,
    batchSize: 50,
    minimumReturnedShare: 0.95,
    maximumSkippedShare: 0.1,
  },
  votes: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    deadlineMs: 25 * 60_000,
    batchSize: 50,
    minimumReturnedShare: 0.95,
    maximumSkippedShare: 0.1,
  },
  charts: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    minimumSortShare: 0.8,
  },
  explore: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    seedCount: 10,
    seedMaximumAgeDays: 60,
    recommendationsPerSeed: 20,
    searchTermCount: 4,
    minimumDiscoveryCcu: 50,
  },
  thumbnails: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    refreshHours: 24,
    refreshMinimumCcu: 50,
    maximumGamesPerRun: 4_000,
  },
} as const;

export const ACTIVE_SET_CONFIG = {
  minimumCcu: 50,
  lookbackHours: 24,
  censusLookbackMinutes: 30,
  recentGameMaximumAgeDays: 90,
  recentGameActivityDays: 7,
} as const;

export const STATUS_CONFIG = {
  coverageMinimumCcu: 100,
  trackedWithinMinutes: 15,
} as const;
```

**Step 5: Replace the app shell**

`src/app/page.tsx`:

```tsx
export default function HomePage() {
  return (
    <div className="content">
      <div className="card card-pad">
        <p className="eyebrow">Radar v2</p>
        <h1>Data collection is being rebuilt</h1>
        <p className="page-subtitle">
          The dashboard returns in phase 4. Run <code>npm run status</code> to inspect collection health.
        </p>
      </div>
    </div>
  );
}
```

`src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Navigation } from "@/components/Navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Roblox Trend Radar", template: "%s · Roblox Trend Radar" },
  description: "Roblox market radar: early breakouts, why they work, and room left in each cluster.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Navigation />
          <main className="main">
            <header className="topbar">
              <span className="topbar-label">Market intelligence / Radar v2</span>
              <span className="status-chip">Data core in progress</span>
            </header>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
```

`src/components/Navigation.tsx`:

```tsx
"use client";

import { LayoutDashboard, Radar } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [{ href: "/", label: "Overview", icon: LayoutDashboard }];

export function Navigation() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark"><Radar size={20} /></span>
        <span><span className="brand-title">Trend Radar</span><span className="brand-kicker">Roblox intelligence</span></span>
      </Link>
      <nav className="nav" aria-label="Main navigation">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return <Link key={href} href={href} className={`nav-link ${active ? "active" : ""}`}><Icon size={18} /><span>{label}</span></Link>;
        })}
      </nav>
      <div className="sidebar-footer"><strong>Radar v2</strong><span>Collection is being rebuilt. The dashboard returns in phase 4.</span></div>
    </aside>
  );
}
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "tr.rbxcdn.com" }],
  },
};

export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { reporter: ["text", "json", "html"] },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
```

**Step 6: Update `package.json` scripts**

Replace the `scripts` block with:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "db:generate": "drizzle-kit generate",
  "validate": "npm run lint && npm run typecheck && npm run test && npm run build"
}
```

**Step 7: Rewrite `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, radar-v2]
  pull_request:
  workflow_dispatch:

jobs:
  validate:
    runs-on: ubuntu-latest
    services:
      timescale:
        image: timescale/timescaledb:2.30.2-pg18
        env:
          POSTGRES_PASSWORD: postgres
          TIMESCALEDB_TELEMETRY: "off"
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 30
    env:
      TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
```

**Step 8: Validate**

Run: `npm run validate`
Expected: lint, typecheck and build pass. The tests that remain (HTTP timing, API parsing, connection URL, title) pass.

**Step 9: Commit**

```bash
git add -A
git commit -m "refactor: remove v1 radar modules from the v2 branch"
```

---

### Task 2: Array helpers, time slots and fingerprints

**Files:**
- Create: `src/lib/arrays.ts`, `src/lib/arrays.test.ts`, `src/lib/time-slots.ts`, `src/lib/time-slots.test.ts`, `src/lib/fingerprint.ts`, `src/lib/fingerprint.test.ts`

**Step 1: Write the failing tests**

`src/lib/arrays.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunk, uniqueBy } from "./arrays";

describe("chunk", () => {
  it("splits items into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("uniqueBy", () => {
  it("keeps the first item for each key", () => {
    expect(uniqueBy([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 1, v: "c" }], (item) => item.id)).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);
  });
});
```

`src/lib/time-slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { floorToSlot } from "./time-slots";

describe("floorToSlot", () => {
  it("floors to the start of a five-minute slot", () => {
    expect(floorToSlot(new Date("2026-10-20T14:07:59.999Z"), 5).toISOString()).toBe("2026-10-20T14:05:00.000Z");
  });

  it("keeps an exact slot boundary", () => {
    expect(floorToSlot(new Date("2026-10-20T14:10:00.000Z"), 10).toISOString()).toBe("2026-10-20T14:10:00.000Z");
  });

  it("floors hourly slots", () => {
    expect(floorToSlot(new Date("2026-10-20T14:59:00.000Z"), 60).toISOString()).toBe("2026-10-20T14:00:00.000Z");
  });

  it("rejects a non-positive slot size", () => {
    expect(() => floorToSlot(new Date(), 0)).toThrow();
  });
});
```

`src/lib/fingerprint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contentFingerprint, rawFingerprint, urlFingerprint } from "./fingerprint";

describe("fingerprints", () => {
  it("changes the raw fingerprint when only a promotional marker changes", () => {
    expect(rawFingerprint("[🎃] +1 Stone Skipping", "Skip stones")).not.toBe(rawFingerprint("+1 Stone Skipping", "Skip stones"));
  });

  it("keeps the content fingerprint when only markers, case or spacing change", () => {
    expect(contentFingerprint("[🎃 UPD] +1 Stone Skipping", "Skip  stones\n")).toBe(
      contentFingerprint("+1 Stone Skipping", "skip stones"),
    );
  });

  it("changes the content fingerprint when the concept text changes", () => {
    expect(contentFingerprint("+1 Stone Skipping", "")).not.toBe(contentFingerprint("+1 Rock Throwing", ""));
  });

  it("hashes URLs deterministically", () => {
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toBe(urlFingerprint("https://tr.rbxcdn.com/a"));
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toHaveLength(40);
  });
});
```

Run: `npx vitest run src/lib/arrays.test.ts src/lib/time-slots.test.ts src/lib/fingerprint.test.ts`
Expected: FAIL, modules not found.

**Step 2: Implement**

`src/lib/arrays.ts`:

```ts
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`Invalid chunk size: ${size}`);
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  const unique: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(item);
  }
  return unique;
}
```

`src/lib/time-slots.ts`:

```ts
export function floorToSlot(date: Date, minutes: number): Date {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`Invalid slot size: ${minutes}`);
  const size = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / size) * size);
}
```

`src/lib/fingerprint.ts`:

```ts
import { createHash } from "node:crypto";
import { normalizeTitle } from "./title";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Changes on any visible edit, including seasonal markers such as [🎃].
export function rawFingerprint(name: string, description: string): string {
  return sha1(`${name}\u0000${description}`);
}

// Changes only when the concept text changes; used to decide reclassification.
export function contentFingerprint(name: string, description: string): string {
  return sha1(`${normalizeTitle(name).toLowerCase()}\u0000${normalizeText(description)}`);
}

export function urlFingerprint(url: string): string {
  return sha1(url);
}
```

**Step 3: Run tests**

Run: `npx vitest run src/lib/arrays.test.ts src/lib/time-slots.test.ts src/lib/fingerprint.test.ts`
Expected: PASS (10 tests).

**Step 4: Commit**

```bash
git add src/lib/arrays.ts src/lib/arrays.test.ts src/lib/time-slots.ts src/lib/time-slots.test.ts src/lib/fingerprint.ts src/lib/fingerprint.test.ts
git commit -m "feat: add slot, fingerprint and array helpers"
```

---

### Task 3: Database foundation (schema, TimescaleDB migration, client, test databases)

**Files:**
- Create: `src/lib/jobs/types.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/test-database.ts`, `src/db/schema.db.test.ts`, `scripts/migrate.ts`
- Generate: `drizzle/0000_core_schema.sql`, `drizzle/0001_timescale.sql`, `drizzle/meta/*`
- Modify: `package.json`

**Step 0: Guard against locale-dependent casing**

Stored fingerprints must not depend on the host locale (under tr-TR, V8 lowercases "I" to "ı" in non-Latin-1 strings), and CI runs under the default locale, so a test alone cannot catch a regression. In `eslint.config.mjs`, add this entry to the `defineConfig([...])` array, after `...nextTypeScript`:

```js
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "toLocaleLowerCase", message: "Use toLowerCase(): stored values must not depend on the host locale." },
        { property: "toLocaleUpperCase", message: "Use toUpperCase(): stored values must not depend on the host locale." },
      ],
    },
  },
```

Run `npm run lint` (expected: PASS, since no code uses these methods), then commit: `git add eslint.config.mjs && git commit -m "chore(lint): forbid locale-dependent casing in source"`.

**Step 1: Create `src/lib/jobs/types.ts`**

```ts
export const JOB_NAMES = ["census", "poll", "votes", "charts", "explore", "thumbnails"] as const;

export type JobName = (typeof JOB_NAMES)[number];
export type JobStatus = "running" | "success" | "degraded" | "failed";
export type DiscoverySource = "rolimons" | "chart" | "search" | "recommendation";
```

**Step 2: Create `src/db/schema.ts`**

```ts
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DiscoverySource, JobName, JobStatus } from "@/lib/jobs/types";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const id64 = (name: string) => bigint(name, { mode: "number" });

export const games = pgTable(
  "games",
  {
    universeId: id64("universe_id").primaryKey(),
    rootPlaceId: id64("root_place_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    creatorId: id64("creator_id").notNull(),
    creatorName: text("creator_name").notNull(),
    creatorType: text("creator_type").notNull(),
    genre: text("genre"),
    robloxCreatedAt: timestamptz("roblox_created_at").notNull(),
    robloxUpdatedAt: timestamptz("roblox_updated_at").notNull(),
    firstObservedAt: timestamptz("first_observed_at").notNull(),
    lastObservedAt: timestamptz("last_observed_at").notNull(),
    lastCcu: integer("last_ccu").notNull().default(0),
    lastCcuAt: timestamptz("last_ccu_at"),
    // Raw fingerprint of the current name + description; a version is recorded whenever it changes.
    metadataFingerprint: text("metadata_fingerprint").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    iconUrl: text("icon_url"),
    thumbnailsCheckedAt: timestamptz("thumbnails_checked_at"),
  },
  (table) => [
    index("games_roblox_created_idx").on(table.robloxCreatedAt),
    index("games_root_place_idx").on(table.rootPlaceId),
  ],
);

export const places = pgTable(
  "places",
  {
    placeId: id64("place_id").primaryKey(),
    universeId: id64("universe_id"),
    resolvedAt: timestamptz("resolved_at").notNull(),
    error: text("error"),
  },
  (table) => [index("places_universe_idx").on(table.universeId)],
);

export const gameVersions = pgTable(
  "game_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    universeId: id64("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    kind: text("kind").$type<"metadata" | "thumbnail">().notNull(),
    rawFingerprint: text("raw_fingerprint").notNull(),
    contentFingerprint: text("content_fingerprint"),
    name: text("name"),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    robloxUpdatedAt: timestamptz("roblox_updated_at"),
    observedAt: timestamptz("observed_at").notNull(),
  },
  // Versions are compared with the game's current state, not with all history, so a title or
  // thumbnail that reverts (X → [🎃] X → X) records the return. The unique key keeps imports idempotent.
  (table) => [
    uniqueIndex("game_versions_unique_idx").on(table.universeId, table.kind, table.rawFingerprint, table.observedAt),
    index("game_versions_game_time_idx").on(table.universeId, table.observedAt),
  ],
);

export const discoverySources = pgTable(
  "discovery_sources",
  {
    universeId: id64("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    source: text("source").$type<DiscoverySource>().notNull(),
    detail: text("detail").notNull().default(""),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.universeId, table.source, table.detail] }),
    index("discovery_sources_first_seen_idx").on(table.firstSeenAt),
  ],
);

// Hypertables (converted in drizzle/0001_timescale.sql). No foreign keys, for write volume and compression.
export const gameObservations = pgTable(
  "game_observations",
  {
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    ccu: integer("ccu").notNull(),
    visits: id64("visits").notNull(),
    favorites: id64("favorites").notNull(),
    source: text("source").$type<"poll" | "legacy">().notNull().default("poll"),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.observedAt] })],
);

export const censusObservations = pgTable(
  "census_observations",
  {
    placeId: id64("place_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    ccu: integer("ccu").notNull(),
  },
  (table) => [primaryKey({ columns: [table.placeId, table.observedAt] })],
);

export const voteObservations = pgTable(
  "vote_observations",
  {
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    upVotes: integer("up_votes").notNull(),
    downVotes: integer("down_votes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.observedAt] })],
);

export const chartPlacements = pgTable(
  "chart_placements",
  {
    sortId: text("sort_id").notNull(),
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    rank: integer("rank").notNull(),
    playerCount: integer("player_count").notNull(),
    isSponsored: boolean("is_sponsored"),
  },
  (table) => [
    primaryKey({ columns: [table.sortId, table.universeId, table.observedAt] }),
    index("chart_placements_game_time_idx").on(table.universeId, table.observedAt),
  ],
);

export const gameDailyLegacy = pgTable(
  "game_daily_legacy",
  {
    universeId: id64("universe_id").notNull(),
    day: timestamptz("day").notNull(),
    ccuAvg: real("ccu_avg").notNull(),
    ccuPeak: integer("ccu_peak").notNull(),
    visits: id64("visits").notNull(),
    favorites: id64("favorites").notNull(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.day] })],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey(),
    job: text("job").$type<JobName>().notNull(),
    slot: timestamptz("slot").notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
  },
  (table) => [
    index("job_runs_job_started_idx").on(table.job, table.startedAt),
    index("job_runs_job_slot_idx").on(table.job, table.slot),
  ],
);
```

**Step 3: Generate the core migration and an empty custom migration**

```bash
npx drizzle-kit generate --name=core_schema
npx drizzle-kit generate --custom --name=timescale
```

Expected: `drizzle/0000_core_schema.sql` with `CREATE TABLE` statements for the ten tables, and an empty `drizzle/0001_timescale.sql`. Do not edit `0000_core_schema.sql`.

**Step 4: Fill `drizzle/0001_timescale.sql`**

The Drizzle migrator runs all pending migrations inside one transaction, so continuous aggregates are created `WITH NO DATA` (a materializing `CREATE MATERIALIZED VIEW` cannot run in a transaction). Refresh policies fill them in the background.

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('game_observations', by_range('observed_at', INTERVAL '1 day'));
--> statement-breakpoint
SELECT create_hypertable('census_observations', by_range('observed_at', INTERVAL '1 day'));
--> statement-breakpoint
SELECT create_hypertable('vote_observations', by_range('observed_at', INTERVAL '7 days'));
--> statement-breakpoint
SELECT create_hypertable('chart_placements', by_range('observed_at', INTERVAL '7 days'));
--> statement-breakpoint
ALTER TABLE game_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'universe_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE census_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'place_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE vote_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'universe_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE chart_placements SET (timescaledb.compress, timescaledb.compress_segmentby = 'universe_id', timescaledb.compress_orderby = 'sort_id, observed_at DESC');
--> statement-breakpoint
-- Every policy starts 5 minutes after migrating, so test databases can pause jobs before any of them runs.
SELECT add_compression_policy('game_observations', INTERVAL '7 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_compression_policy('census_observations', INTERVAL '7 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_compression_policy('vote_observations', INTERVAL '30 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_compression_policy('chart_placements', INTERVAL '30 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_retention_policy('game_observations', INTERVAL '365 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_retention_policy('census_observations', INTERVAL '365 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
CREATE MATERIALIZED VIEW game_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  universe_id,
  time_bucket(INTERVAL '1 hour', observed_at) AS bucket,
  min(ccu) AS ccu_min,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_max,
  max(visits) AS visits_max,
  last(favorites, observed_at) AS favorites_last,
  count(*) AS samples
FROM game_observations
GROUP BY universe_id, bucket
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW game_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  universe_id,
  time_bucket(INTERVAL '1 day', observed_at) AS bucket,
  min(ccu) AS ccu_min,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_peak,
  min(visits) AS visits_min,
  max(visits) AS visits_max,
  last(favorites, observed_at) AS favorites_last,
  count(*) AS samples
FROM game_observations
GROUP BY universe_id, bucket
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW census_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  place_id,
  time_bucket(INTERVAL '1 hour', observed_at) AS bucket,
  min(ccu) AS ccu_min,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_max,
  count(*) AS samples
FROM census_observations
GROUP BY place_id, bucket
WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('game_hourly', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('game_daily', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('census_hourly', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
ALTER MATERIALIZED VIEW game_hourly SET (timescaledb.compress = true);
--> statement-breakpoint
ALTER MATERIALIZED VIEW census_hourly SET (timescaledb.compress = true);
--> statement-breakpoint
SELECT add_compression_policy('game_hourly', compress_after => INTERVAL '30 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
SELECT add_compression_policy('census_hourly', compress_after => INTERVAL '30 days', initial_start => now() + INTERVAL '5 minutes');
--> statement-breakpoint
CREATE VIEW game_daily_all AS
SELECT universe_id, bucket AS day, ccu_avg, ccu_peak, visits_max AS visits, favorites_last AS favorites, 'observed'::text AS origin
FROM game_daily
UNION ALL
SELECT legacy.universe_id, legacy.day, legacy.ccu_avg, legacy.ccu_peak, legacy.visits, legacy.favorites, 'legacy'::text AS origin
FROM game_daily_legacy legacy
WHERE NOT EXISTS (
  SELECT 1 FROM game_daily observed
  WHERE observed.universe_id = legacy.universe_id AND observed.bucket = legacy.day
);
```

Retention keeps 365 days of raw 5-minute and 10-minute rows; compressed, a year of raw data costs about as much as the aggregates, and it keeps every aggregate recomputable for a year. The continuous aggregates are the only record older than that, so they store minimum, average and maximum CCU, and visits as a maximum (a cumulative counter that only goes up, so one bad final reading cannot stick). Policy refresh windows (3 and 7 days) stay far inside the retention, so dropping old raw chunks never erases aggregated buckets. A manual refresh must never cover a range whose raw rows were already dropped: it would recompute those buckets from nothing. `chart_placements` is segmented by game because per-game chart history is its main read pattern.

**Step 5: Create `src/db/client.ts`**

```ts
import * as nextEnvNamespace from "@next/env";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { errorMessage, logger } from "@/lib/logger";
import { normalizePostgresConnectionUrl } from "./connection-url";
import * as schema from "./schema";

const environmentNamespace = nextEnvNamespace as unknown as {
  default?: typeof import("@next/env");
  loadEnvConfig: typeof import("@next/env")["loadEnvConfig"];
};
(environmentNamespace.default ?? environmentNamespace).loadEnvConfig(process.cwd());

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  maxConnections?: number;
  // Shown in pg_stat_activity, to tell the dashboard, each job and analysis sessions apart.
  applicationName?: string;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: normalizePostgresConnectionUrl(connectionString),
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "radar",
  });
  // Idle clients report errors (for example a server restart) on the pool; unhandled, they crash the process.
  pool.on("error", (error) => logger.warn("Idle PostgreSQL client error", { error: errorMessage(error) }));
  return { db: drizzle(pool, { schema }), pool };
}

let shared: { db: Database; pool: Pool } | null = null;

export function getDatabase(applicationName = "radar"): Database {
  if (shared) return shared.db;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  shared = createDatabase(connectionString, { applicationName });
  return shared.db;
}

export async function closeDatabase(): Promise<void> {
  if (shared) await shared.pool.end();
  shared = null;
}
```

**Step 6: Create `src/db/migrate.ts`**

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";
import { assertNotLegacyDatabase } from "./legacy-guard";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function migrateDatabase(db: Database): Promise<void> {
  await assertNotLegacyDatabase(db);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
```

Create `src/db/legacy-guard.ts` (its own module, so app code can import the guard without pulling in the migrations folder reference):

```ts
import { sql } from "drizzle-orm";
import type { Database } from "./client";

// v1 and v2 both read DATABASE_URL; nothing v2 may run against the v1 production schema.
export async function assertNotLegacyDatabase(db: Database): Promise<void> {
  const legacy = await db.execute<{ found: string | null }>(sql`select to_regclass('public.snapshots')::text as found`);
  if (legacy.rows[0]?.found) {
    throw new Error("Refusing to run: this database still holds v1 radar tables");
  }
}
```

**Step 7: Create `scripts/migrate.ts`**

```ts
import { closeDatabase, getDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { errorMessage, logger } from "@/lib/logger";

try {
  await migrateDatabase(getDatabase());
  logger.info("Database migrations completed");
} catch (error) {
  logger.error("Database migration failed", { error: errorMessage(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
```

Add to `package.json` scripts: `"db:migrate": "tsx scripts/migrate.ts",`

**Step 8: Create `src/db/test-database.ts`**

```ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";

const adminUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";

// A missing variable in CI must fail loudly instead of silently skipping every database suite.
if (process.env.CI && !adminUrl) {
  throw new Error("TEST_DATABASE_URL must be set in CI");
}

// Database suites run only against a disposable PostgreSQL + TimescaleDB server.
export const hasTestDatabase = adminUrl.length > 0;

export interface TestDatabase {
  db: Database;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `radar_test_${randomUUID().replaceAll("-", "")}`;
  // template0 has no TimescaleDB, so the migration's CREATE EXTENSION path is exercised as in production.
  await runAdminQuery(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const url = withDatabaseName(adminUrl, name);
  const { db, pool } = createDatabase(url, { maxConnections: 3, applicationName: "radar-test" });
  const drop = async () => {
    try {
      await pool.end();
    } finally {
      await runAdminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  };
  try {
    if (options.migrate !== false) {
      await migrateDatabase(db);
      await pauseBackgroundJobs(db);
    }
  } catch (error) {
    await drop();
    throw error;
  }
  return { db, url, drop };
}

// Policies would otherwise materialize, compress or drop fixture rows while tests run.
// Tests that need materialized aggregates call refresh_continuous_aggregate explicitly.
async function pauseBackgroundJobs(db: Database): Promise<void> {
  await db.execute(sql`select alter_job(job_id, scheduled => false) from timescaledb_information.jobs where job_id >= 1000`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.execute<{ running: number }>(
      sql`select count(*)::int as running from timescaledb_information.job_stats where job_id >= 1000 and job_status = 'Running'`,
    );
    if (!result.rows[0]?.running) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TimescaleDB background jobs did not stop");
}

async function runAdminQuery(statement: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
```

**Step 9: Write the database test**

`src/db/schema.db.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("v2 schema migrations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("creates the four hypertables", async () => {
    const result = await database.db.execute<{ hypertable_name: string }>(
      sql`select hypertable_name from timescaledb_information.hypertables order by 1`,
    );
    expect(result.rows.map((row) => row.hypertable_name)).toEqual([
      "census_observations",
      "chart_placements",
      "game_observations",
      "vote_observations",
    ]);
  });

  it("creates the continuous aggregates", async () => {
    const result = await database.db.execute<{ view_name: string }>(
      sql`select view_name from timescaledb_information.continuous_aggregates order by 1`,
    );
    expect(result.rows.map((row) => row.view_name)).toEqual(["census_hourly", "game_daily", "game_hourly"]);
  });

  it("serves unmaterialized observations through the hourly aggregate", async () => {
    await database.db.execute(sql`
      insert into game_observations (universe_id, observed_at, ccu, visits, favorites) values
        (1, '2026-10-20T14:00:00Z', 100, 1000, 10),
        (1, '2026-10-20T14:05:00Z', 300, 1100, 11),
        (1, '2026-10-20T14:10:00Z', 200, 1200, 12)
    `);
    const result = await database.db.execute<{ ccu_min: number; ccu_max: number; samples: string; visits_max: string }>(
      sql`select ccu_min, ccu_max, samples, visits_max from game_hourly where universe_id = 1`,
    );
    expect(result.rows).toEqual([{ ccu_min: 100, ccu_max: 300, samples: "3", visits_max: "1200" }]);
  });

  it("schedules compression, retention and refresh policies", async () => {
    const result = await database.db.execute<{ proc_name: string; jobs: number }>(sql`
      select proc_name, count(*)::int as jobs from timescaledb_information.jobs
      where job_id >= 1000 group by proc_name order by proc_name
    `);
    expect(result.rows).toEqual([
      { proc_name: "policy_compression", jobs: 6 },
      { proc_name: "policy_refresh_continuous_aggregate", jobs: 3 },
      { proc_name: "policy_retention", jobs: 2 },
    ]);
    const retention = await database.db.execute<{ drop_after: string }>(sql`
      select distinct config->>'drop_after' as drop_after from timescaledb_information.jobs where proc_name = 'policy_retention'
    `);
    expect(retention.rows).toEqual([{ drop_after: "365 days" }]);
    const paused = await database.db.execute<{ paused: boolean }>(
      sql`select bool_and(not scheduled) as paused from timescaledb_information.jobs where job_id >= 1000`,
    );
    expect(paused.rows).toEqual([{ paused: true }]);
  });

  it("refuses to migrate a database that still holds v1 tables", async () => {
    const legacy = await createTestDatabase({ migrate: false });
    try {
      await legacy.db.execute(sql`create table snapshots (id integer)`);
      await expect(migrateDatabase(legacy.db)).rejects.toThrow(/v1/);
    } finally {
      await legacy.drop();
    }
  });
});
```

**Step 10: Run tests and validation**

Run: `npx vitest run src/db/schema.db.test.ts`
Expected locally without `TEST_DATABASE_URL`: 5 skipped. With it: 5 passed.

Run: `npm run typecheck && npm run lint`
Expected: PASS.

**Step 11: Commit and confirm in CI**

```bash
git add src/lib/jobs/types.ts src/db scripts/migrate.ts drizzle package.json
git commit -m "feat(db): add v2 TimescaleDB schema and migrations"
git push -u origin radar-v2
gh run watch --exit-status
```

Expected: CI green, with the schema suite passing (not skipped).

---

### Task 4: Job runs, Healthchecks pings and the job runner

**Files:**
- Create: `src/db/job-runs.ts`, `src/lib/jobs/healthchecks.ts`, `src/lib/jobs/healthchecks.test.ts`, `src/lib/jobs/runner.ts`, `src/lib/jobs/runner.db.test.ts`, `src/lib/jobs/registry.ts`, `scripts/job.ts`
- Modify: `package.json`

**Step 1: Write the failing Healthchecks test**

`src/lib/jobs/healthchecks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPingUrl } from "./healthchecks";

describe("buildPingUrl", () => {
  const base = "https://hc-ping.com/ping-key/";

  it("builds start, success and fail URLs with auto-provisioning and a run id", () => {
    expect(buildPingUrl(base, "radar-poll", "start", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll/start?create=1&rid=run-1");
    expect(buildPingUrl(base, "radar-poll", "success", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll?create=1&rid=run-1");
    expect(buildPingUrl(base, "radar-poll", "fail", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll/fail?create=1&rid=run-1");
  });
});
```

Run: `npx vitest run src/lib/jobs/healthchecks.test.ts`
Expected: FAIL, module not found.

**Step 2: Implement `src/lib/jobs/healthchecks.ts`**

```ts
import { errorMessage, logger } from "@/lib/logger";

export type PingKind = "start" | "success" | "fail";

export function buildPingUrl(base: string, slug: string, kind: PingKind, runId: string): string {
  const suffix = kind === "success" ? "" : `/${kind}`;
  const url = new URL(`${base.replace(/\/+$/, "")}/${slug}${suffix}`);
  url.searchParams.set("create", "1");
  url.searchParams.set("rid", runId);
  return url.toString();
}

// Pings are best effort: a monitoring outage must never fail a collection.
export async function sendPing(slug: string, kind: PingKind, runId: string, body?: string): Promise<void> {
  const base = process.env.HEALTHCHECKS_PING_BASE?.trim();
  if (!base) return;
  try {
    const response = await fetch(buildPingUrl(base, slug, kind, runId), {
      method: "POST",
      body: body?.slice(0, 10_000),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) logger.warn("Healthchecks ping rejected", { slug, kind, status: response.status });
  } catch (error) {
    logger.warn("Healthchecks ping failed", { slug, kind, error: errorMessage(error) });
  }
}
```

Run: `npx vitest run src/lib/jobs/healthchecks.test.ts`
Expected: PASS.

**Step 3: Implement `src/db/job-runs.ts`**

```ts
import { and, desc, eq, inArray } from "drizzle-orm";
import type { JobName, JobStatus } from "@/lib/jobs/types";
import type { Database } from "./client";
import { jobRuns } from "./schema";

export async function startJobRun(
  db: Database,
  run: { id: string; job: JobName; slot: Date; startedAt: Date },
): Promise<void> {
  await db.insert(jobRuns).values({ ...run, status: "running", stats: {} });
}

export async function finishJobRun(
  db: Database,
  id: string,
  outcome: {
    status: Exclude<JobStatus, "running">;
    finishedAt: Date;
    durationMs: number;
    stats: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      status: outcome.status,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
      stats: outcome.stats,
      error: outcome.error ?? null,
    })
    .where(eq(jobRuns.id, id));
}

export async function latestCompletedRun(
  db: Database,
  job: JobName,
): Promise<{ slot: Date; stats: Record<string, unknown> } | null> {
  const [run] = await db
    .select({ slot: jobRuns.slot, stats: jobRuns.stats })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), inArray(jobRuns.status, ["success", "degraded"])))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return run ?? null;
}
```

**Step 4: Write the failing runner test**

`src/lib/jobs/runner.db.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("executeJob", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("records a successful run with its slot and stats", async () => {
    const status = await executeJob(
      { name: "poll", intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "success", stats: { games: 3 } }) },
      database.db,
      new Date("2026-10-20T14:07:00Z"),
    );
    expect(status).toBe("success");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "poll"));
    expect(run.status).toBe("success");
    expect(run.slot.toISOString()).toBe("2026-10-20T14:05:00.000Z");
    expect(run.stats).toEqual({ games: 3 });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failed run with its error", async () => {
    const status = await executeJob(
      { name: "votes", intervalMinutes: 60, timeoutMs: 1_000, run: async () => { throw new Error("boom"); } },
      database.db,
    );
    expect(status).toBe("failed");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "votes"));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
  });

  it("fails a run that exceeds its timeout", async () => {
    const status = await executeJob(
      {
        name: "charts",
        intervalMinutes: 60,
        timeoutMs: 20,
        run: () => new Promise((resolve) => setTimeout(() => resolve({ status: "success", stats: {} }), 500)),
      },
      database.db,
    );
    expect(status).toBe("failed");
    const [run] = await database.db.select().from(jobRuns).where(eq(jobRuns.job, "charts"));
    expect(run.error).toMatch(/exceeded/);
  });
});
```

Run: `npx vitest run src/lib/jobs/runner.db.test.ts`
Expected: FAIL to compile (`./runner` missing), or skipped without a test database. The typecheck in Step 6 fails until Step 5.

**Step 5: Implement `src/lib/jobs/runner.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import { finishJobRun, startJobRun } from "@/db/job-runs";
import { errorMessage, logger } from "@/lib/logger";
import { floorToSlot } from "@/lib/time-slots";
import { sendPing } from "./healthchecks";
import type { JobName, JobStatus } from "./types";

export interface JobContext {
  db: Database;
  now: Date;
  slot: Date;
  runId: string;
}

export interface JobResult {
  status: "success" | "degraded";
  stats: Record<string, unknown>;
}

export interface JobDefinition {
  name: JobName;
  intervalMinutes: number;
  timeoutMs: number;
  run(context: JobContext): Promise<JobResult>;
}

// A degraded run still sends a success ping: the heartbeat means "the job ran";
// data quality is tracked in job_runs and excluded from analysis there.
export async function executeJob(
  definition: JobDefinition,
  db: Database,
  now = new Date(),
): Promise<Exclude<JobStatus, "running">> {
  const runId = randomUUID();
  const slug = `radar-${definition.name}`;
  const slot = floorToSlot(now, definition.intervalMinutes);
  const startedMs = Date.now();
  await startJobRun(db, { id: runId, job: definition.name, slot, startedAt: new Date(startedMs) });
  await sendPing(slug, "start", runId);
  try {
    const result = await withTimeout(definition.run({ db, now, slot, runId }), definition.timeoutMs, definition.name);
    await finishJobRun(db, runId, {
      status: result.status,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
      stats: result.stats,
    });
    await sendPing(slug, "success", runId, JSON.stringify({ status: result.status, ...result.stats }));
    logger.info("Job completed", { job: definition.name, status: result.status, ...result.stats });
    return result.status;
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Job failed", { job: definition.name, error: message });
    try {
      await finishJobRun(db, runId, {
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - startedMs,
        stats: {},
        error: message,
      });
    } catch (recordError) {
      logger.error("Could not record job failure", { job: definition.name, error: errorMessage(recordError) });
    }
    await sendPing(slug, "fail", runId, message);
    return "failed";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

**Step 6: Create the registry and the entry script**

`src/lib/jobs/registry.ts`:

```ts
import type { JobDefinition } from "./runner";

// Each collector task registers its job here.
export function createJobs(): JobDefinition[] {
  return [];
}
```

`scripts/job.ts`:

```ts
import { closeDatabase, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import { logger } from "@/lib/logger";

const name = process.argv[2];
const jobs = createJobs();
const definition = jobs.find((job) => job.name === name);
if (!definition) {
  logger.error("Unknown job", { name, available: jobs.map((job) => job.name) });
  process.exit(2);
}

const database = getDatabase(`radar-${definition.name}`);
await assertNotLegacyDatabase(database);
const status = await executeJob(definition, database);
await closeDatabase();
process.exit(status === "failed" ? 1 : 0);
```

Add to `package.json` scripts: `"job": "tsx scripts/job.ts",`

**Step 7: Run tests and typecheck**

Run: `npx vitest run src/lib/jobs && npm run typecheck`
Expected: Healthchecks test passes; the runner suite passes with a test database, or is skipped without one; typecheck passes.

**Step 8: Commit and confirm in CI**

```bash
git add src/db/job-runs.ts src/lib/jobs scripts/job.ts package.json
git commit -m "feat(jobs): add job runner with run history and Healthchecks pings"
git push && gh run watch --exit-status
```

---

### Task 5: Roblox API surface for collectors

**Files:**
- Modify: `src/lib/api/roblox.ts`, `src/lib/api/parsing.test.ts`
- Create: `src/test/fixtures.ts`

**Step 1: Write the failing parser test**

Append to `src/lib/api/parsing.test.ts`, inside the existing `describe` block, and add `parseGameThumbnailsResponse` to the import from `./roblox`:

```ts
  it("keeps the first completed 16:9 game thumbnail per universe", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: [{ targetId: 9, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/768/432/Image/Png", version: "TN3" }] },
        { universeId: 102, error: null, thumbnails: [{ targetId: 10, state: "Pending", imageUrl: null }] },
      ],
    });
    expect([...thumbnails]).toEqual([["101", "https://tr.rbxcdn.com/a/768/432/Image/Png"]]);
  });
```

Run: `npx vitest run src/lib/api/parsing.test.ts`
Expected: FAIL, `parseGameThumbnailsResponse` is not exported.

**Step 2: Implement in `src/lib/api/roblox.ts`**

Add next to the other schemas:

```ts
const gameThumbnailsResponseSchema = z.object({
  data: z.array(
    z.object({
      universeId: z.number(),
      thumbnails: z.array(z.object({ state: z.string(), imageUrl: z.string().nullable() })).default([]),
    }),
  ),
});
```

Add next to the other parsers:

```ts
export function parseGameThumbnailsResponse(value: unknown): Map<string, string> {
  const thumbnails = new Map<string, string>();
  for (const item of gameThumbnailsResponseSchema.parse(value).data) {
    const completed = item.thumbnails.find((thumbnail) => thumbnail.state === "Completed" && thumbnail.imageUrl);
    if (completed?.imageUrl) thumbnails.set(String(item.universeId), completed.imageUrl);
  }
  return thumbnails;
}
```

Add the interface above the `RobloxClient` class, and declare `export class RobloxClient implements RobloxApi`:

```ts
export interface RobloxApi {
  getSortContent(sortId: string): Promise<RobloxSort>;
  getGameDetails(universeIds: string[]): Promise<RobloxGameDetail[]>;
  getGameVotes(universeIds: string[]): Promise<RobloxGameVote[]>;
  getRecommendations(universeId: string, maximumRows?: number): Promise<RobloxChartGame[]>;
  searchGames(query: string): Promise<RobloxChartGame[]>;
  resolveUniverseId(placeId: string): Promise<string>;
  getThumbnails(universeIds: string[]): Promise<Map<string, string>>;
  getGameThumbnails(universeIds: string[]): Promise<Map<string, string>>;
}
```

Add this method to `RobloxClient`, after `getThumbnails`:

```ts
  async getGameThumbnails(universeIds: string[]): Promise<Map<string, string>> {
    const thumbnails = new Map<string, string>();
    for (let index = 0; index < universeIds.length; index += 50) {
      const url = new URL("https://thumbnails.roblox.com/v1/games/multiget/thumbnails");
      url.searchParams.set("universeIds", universeIds.slice(index, index + 50).join(","));
      url.searchParams.set("countPerUniverse", "1");
      url.searchParams.set("defaults", "true");
      url.searchParams.set("size", "768x432");
      url.searchParams.set("format", "Png");
      url.searchParams.set("isCircular", "false");
      const parsed = parseGameThumbnailsResponse(await fetchJson(url.toString(), { cacheTtlMs: 60 * 60 * 1000 }));
      for (const [universeId, imageUrl] of parsed) thumbnails.set(universeId, imageUrl);
    }
    return thumbnails;
  }
```

**Step 3: Create the shared test fixture `src/test/fixtures.ts`**

```ts
import type { RobloxGameDetail } from "@/lib/api/roblox";

// Test-only game details. Used exclusively with disposable test databases.
export function gameDetail(id: number, overrides: Partial<RobloxGameDetail> = {}): RobloxGameDetail {
  return {
    id,
    rootPlaceId: id + 1_000_000,
    name: `Game ${id}`,
    description: "",
    creator: { id: 1, name: "Studio", type: "Group" },
    playing: 100,
    visits: 10_000,
    created: new Date("2026-10-01T00:00:00Z"),
    updated: new Date("2026-10-19T00:00:00Z"),
    favoritedCount: 50,
    genre: "All",
    genre_l1: "Simulation",
    ...overrides,
  };
}
```

**Step 4: Run tests and typecheck**

Run: `npx vitest run src/lib/api && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/api/roblox.ts src/lib/api/parsing.test.ts src/test/fixtures.ts
git commit -m "feat(api): expose Roblox client interface and 16:9 thumbnails"
```

---

### Task 6: Games, places and discovery repositories

**Files:**
- Create: `src/db/games.ts`, `src/db/places.ts`, `src/db/discovery.ts`, `src/db/games.db.test.ts`

**Step 1: Write the failing database test**

`src/db/games.db.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { recordDiscoveries } from "./discovery";
import { knownUniverseIds, upsertGameDetails } from "./games";
import { placesToSkip, savePlaceResolution, unpromotedUniverses } from "./places";
import { discoverySources, games, gameVersions, places } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("game repositories", () => {
  let database: TestDatabase;
  const first = new Date("2026-10-20T14:00:00Z");
  const second = new Date("2026-10-20T14:05:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("inserts a new game with its first metadata version and place mapping", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping", playing: 900 })], first);
    expect(result).toEqual({ inserted: [1], metadataChanged: [] });
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.lastCcu).toBe(900);
    expect(game.firstObservedAt.toISOString()).toBe(first.toISOString());
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(1);
    const [place] = await database.db.select().from(places).where(eq(places.placeId, 1_000_001));
    expect(place.universeId).toBe(1);
  });

  it("updates live fields without a new version when metadata is unchanged", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping", playing: 1_200 })], second);
    expect(result).toEqual({ inserted: [], metadataChanged: [] });
    const [game] = await database.db.select().from(games).where(eq(games.universeId, 1));
    expect(game.lastCcu).toBe(1_200);
    expect(game.firstObservedAt.toISOString()).toBe(first.toISOString());
    expect(game.lastObservedAt.toISOString()).toBe(second.toISOString());
  });

  it("records a version when the title changes", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "[🎃] +1 Stone Skipping" })], second);
    expect(result.metadataChanged).toEqual([1]);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(2);
  });

  it("records a revert to an earlier title", async () => {
    const third = new Date("2026-10-20T14:10:00Z");
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping" })], third);
    expect(result.metadataChanged).toEqual([1]);
    const versions = await database.db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.universeId, 1))
      .orderBy(gameVersions.observedAt);
    expect(versions.map((version) => version.name)).toEqual(["+1 Stone Skipping", "[🎃] +1 Stone Skipping", "+1 Stone Skipping"]);
  });

  it("does not duplicate a version when the same slot is retried", async () => {
    const third = new Date("2026-10-20T14:10:00Z");
    const result = await upsertGameDetails(database.db, [gameDetail(1, { name: "+1 Stone Skipping" })], third);
    expect(result.metadataChanged).toEqual([]);
    expect(await database.db.select().from(gameVersions).where(eq(gameVersions.universeId, 1))).toHaveLength(3);
  });

  it("deduplicates repeated details within one call", async () => {
    const result = await upsertGameDetails(database.db, [gameDetail(2), gameDetail(2)], first);
    expect(result.inserted).toEqual([2]);
  });

  it("lists known universes", async () => {
    expect(await knownUniverseIds(database.db, [1, 2, 3])).toEqual(new Set([1, 2]));
  });

  it("skips resolved places and recent failures, and finds unpromoted universes", async () => {
    const now = new Date("2026-10-20T15:00:00Z");
    await savePlaceResolution(database.db, { placeId: 500, universeId: 50, resolvedAt: now, error: null });
    await savePlaceResolution(database.db, { placeId: 600, universeId: null, resolvedAt: now, error: "404" });
    await savePlaceResolution(database.db, { placeId: 700, universeId: null, resolvedAt: new Date("2026-10-01T00:00:00Z"), error: "404" });
    expect(await placesToSkip(database.db, [500, 600, 700, 800], now, 7)).toEqual(new Set([500, 600]));
    expect(await unpromotedUniverses(database.db, [500, 1_000_001])).toEqual([50]);
  });

  it("records discoveries and widens their seen window", async () => {
    await recordDiscoveries(database.db, [
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: second, lastSeenAt: second },
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: second, lastSeenAt: second },
    ]);
    await recordDiscoveries(database.db, [
      { universeId: 1, source: "chart", detail: "top-trending", firstSeenAt: first, lastSeenAt: first },
    ]);
    const [row] = await database.db.select().from(discoverySources).where(eq(discoverySources.universeId, 1));
    expect(row.firstSeenAt.toISOString()).toBe(first.toISOString());
    expect(row.lastSeenAt.toISOString()).toBe(second.toISOString());
  });
});
```

Run: `npx vitest run src/db/games.db.test.ts`
Expected: FAIL to compile (modules missing) or skipped without a test database.

**Step 2: Implement `src/db/games.ts`**

```ts
import { inArray, sql } from "drizzle-orm";
import type { RobloxGameDetail } from "@/lib/api/roblox";
import { chunk, uniqueBy } from "@/lib/arrays";
import { contentFingerprint, rawFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions, places } from "./schema";

const CHUNK_SIZE = 500;

export interface GameUpsertResult {
  inserted: number[];
  metadataChanged: number[];
}

export async function upsertGameDetails(db: Database, details: RobloxGameDetail[], observedAt: Date): Promise<GameUpsertResult> {
  const inserted: number[] = [];
  const metadataChanged: number[] = [];
  for (const part of chunk(uniqueBy(details, (detail) => detail.id), CHUNK_SIZE)) {
    // One transaction per chunk: if the version insert fails after games stored the new fingerprint,
    // a retry would see no change and the version would be lost.
    await db.transaction(async (transaction) => {
      // PostgreSQL 18 exposes the pre-update row through RETURNING old.*; it is null for inserted rows.
      // Comparing with the current fingerprint (not all history) records reverts such as X → [🎃] X → X.
      const rows = await transaction
        .insert(games)
        .values(part.map((detail) => toGameRow(detail, observedAt)))
        .onConflictDoUpdate({
          target: games.universeId,
          set: {
            rootPlaceId: sql`excluded.root_place_id`,
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            creatorId: sql`excluded.creator_id`,
            creatorName: sql`excluded.creator_name`,
            creatorType: sql`excluded.creator_type`,
            genre: sql`excluded.genre`,
            robloxCreatedAt: sql`excluded.roblox_created_at`,
            robloxUpdatedAt: sql`excluded.roblox_updated_at`,
            lastObservedAt: sql`greatest(${games.lastObservedAt}, excluded.last_observed_at)`,
            lastCcu: sql`excluded.last_ccu`,
            lastCcuAt: sql`excluded.last_ccu_at`,
            metadataFingerprint: sql`excluded.metadata_fingerprint`,
            contentFingerprint: sql`excluded.content_fingerprint`,
          },
        })
        .returning({
          universeId: games.universeId,
          previousFingerprint: sql<string | null>`old.metadata_fingerprint`,
          currentFingerprint: games.metadataFingerprint,
        });
      const versioned = new Set<number>();
      for (const row of rows) {
        if (row.previousFingerprint === null) {
          inserted.push(row.universeId);
          versioned.add(row.universeId);
        } else if (row.previousFingerprint !== row.currentFingerprint) {
          metadataChanged.push(row.universeId);
          versioned.add(row.universeId);
        }
      }

      const versions = part
        .filter((detail) => versioned.has(detail.id))
        .map((detail) => ({
          universeId: detail.id,
          kind: "metadata" as const,
          rawFingerprint: rawFingerprint(detail.name, detail.description),
          contentFingerprint: contentFingerprint(detail.name, detail.description),
          name: detail.name,
          description: detail.description,
          robloxUpdatedAt: detail.updated,
          observedAt,
        }));
      if (versions.length) {
        await transaction
          .insert(gameVersions)
          .values(versions)
          .onConflictDoNothing({
            target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
          });
      }

      // Every detail reveals its root place mapping, which saves census resolutions later.
      await transaction
        .insert(places)
        .values(part.map((detail) => ({ placeId: detail.rootPlaceId, universeId: detail.id, resolvedAt: observedAt, error: null })))
        .onConflictDoNothing();
    });
  }
  return { inserted, metadataChanged };
}

export async function knownUniverseIds(db: Database, universeIds: number[]): Promise<Set<number>> {
  const known = new Set<number>();
  for (const part of chunk([...new Set(universeIds)], 5_000)) {
    const rows = await db.select({ universeId: games.universeId }).from(games).where(inArray(games.universeId, part));
    for (const row of rows) known.add(row.universeId);
  }
  return known;
}

function toGameRow(detail: RobloxGameDetail, observedAt: Date): typeof games.$inferInsert {
  return {
    universeId: detail.id,
    rootPlaceId: detail.rootPlaceId,
    name: detail.name,
    description: detail.description,
    creatorId: detail.creator.id,
    creatorName: detail.creator.name,
    creatorType: detail.creator.type,
    genre: detail.genre_l1 ?? detail.genre ?? null,
    robloxCreatedAt: detail.created,
    robloxUpdatedAt: detail.updated,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    lastCcu: Math.round(detail.playing),
    lastCcuAt: observedAt,
    metadataFingerprint: rawFingerprint(detail.name, detail.description),
    contentFingerprint: contentFingerprint(detail.name, detail.description),
  };
}
```

**Step 3: Implement `src/db/places.ts`**

```ts
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { chunk } from "@/lib/arrays";
import type { Database } from "./client";
import { games, places } from "./schema";

export async function placesToSkip(db: Database, placeIds: number[], now: Date, retryDays: number): Promise<Set<number>> {
  const retryCutoff = new Date(now.getTime() - retryDays * 24 * 60 * 60 * 1000);
  const skip = new Set<number>();
  for (const part of chunk([...new Set(placeIds)], 5_000)) {
    const rows = await db
      .select({ placeId: places.placeId })
      .from(places)
      .where(and(inArray(places.placeId, part), or(isNotNull(places.universeId), gt(places.resolvedAt, retryCutoff))));
    for (const row of rows) skip.add(row.placeId);
  }
  return skip;
}

export async function savePlaceResolution(
  db: Database,
  resolution: { placeId: number; universeId: number | null; resolvedAt: Date; error: string | null },
): Promise<void> {
  await db
    .insert(places)
    .values(resolution)
    .onConflictDoUpdate({
      target: places.placeId,
      set: { universeId: sql`excluded.universe_id`, resolvedAt: sql`excluded.resolved_at`, error: sql`excluded.error` },
    });
}

export async function unpromotedUniverses(db: Database, placeIds: number[]): Promise<number[]> {
  const universes = new Set<number>();
  for (const part of chunk([...new Set(placeIds)], 5_000)) {
    const rows = await db
      .selectDistinct({ universeId: places.universeId })
      .from(places)
      .leftJoin(games, eq(games.universeId, places.universeId))
      .where(and(inArray(places.placeId, part), isNotNull(places.universeId), isNull(games.universeId)));
    for (const row of rows) if (row.universeId !== null) universes.add(row.universeId);
  }
  return [...universes].sort((a, b) => a - b);
}
```

**Step 4: Implement `src/db/discovery.ts`**

```ts
import { sql } from "drizzle-orm";
import { chunk, uniqueBy } from "@/lib/arrays";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoverySources } from "./schema";

export interface DiscoveryRecord {
  universeId: number;
  source: DiscoverySource;
  detail: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export async function recordDiscoveries(db: Database, records: DiscoveryRecord[]): Promise<number> {
  const unique = uniqueBy(records, (record) => `${record.universeId}:${record.source}:${record.detail}`);
  for (const part of chunk(unique, 1_000)) {
    await db
      .insert(discoverySources)
      .values(part)
      .onConflictDoUpdate({
        target: [discoverySources.universeId, discoverySources.source, discoverySources.detail],
        set: {
          firstSeenAt: sql`least(${discoverySources.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${discoverySources.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return unique.length;
}
```

**Step 5: Run tests and typecheck**

Run: `npx vitest run src/db/games.db.test.ts && npm run typecheck`
Expected: 9 passed with a test database (skipped otherwise); typecheck passes.

**Step 6: Commit and confirm in CI**

```bash
git add src/db/games.ts src/db/places.ts src/db/discovery.ts src/db/games.db.test.ts
git commit -m "feat(db): add game, place and discovery repositories"
git push && gh run watch --exit-status
```

---

### Task 7: Observation writers

**Files:**
- Create: `src/db/observations.ts`, `src/db/observations.db.test.ts`

**Step 1: Write the failing database test**

`src/db/observations.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCensusObservations, writeChartPlacements, writeGameObservations, writeVoteObservations } from "./observations";
import { censusObservations, chartPlacements, gameObservations, voteObservations } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("observation writers", () => {
  let database: TestDatabase;
  const slot = new Date("2026-10-20T14:05:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("replaces a game observation written twice in the same slot", async () => {
    await writeGameObservations(database.db, [{ universeId: 1, observedAt: slot, ccu: 100, visits: 10, favorites: 1 }]);
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: slot, ccu: 150, visits: 11, favorites: 2 },
      { universeId: 1, observedAt: slot, ccu: 999, visits: 99, favorites: 9 },
    ]);
    const rows = await database.db.select().from(gameObservations);
    expect(rows).toHaveLength(1);
    expect(rows[0].ccu).toBe(150);
  });

  it("keeps existing rows in keep mode", async () => {
    await writeGameObservations(database.db, [{ universeId: 1, observedAt: slot, ccu: 1, visits: 1, favorites: 1, source: "legacy" }], "keep");
    const [row] = await database.db.select().from(gameObservations);
    expect(row.ccu).toBe(150);
    expect(row.source).toBe("poll");
  });

  it("writes census, vote and chart rows idempotently", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await writeCensusObservations(database.db, [{ placeId: 10, observedAt: slot, ccu: 400 }]);
      await writeVoteObservations(database.db, [{ universeId: 1, observedAt: slot, upVotes: 90, downVotes: 10 }]);
      await writeChartPlacements(database.db, [{ sortId: "top-trending", universeId: 1, observedAt: slot, rank: 3, playerCount: 150, isSponsored: false }]);
    }
    expect(await database.db.select().from(censusObservations)).toHaveLength(1);
    expect(await database.db.select().from(voteObservations)).toHaveLength(1);
    expect(await database.db.select().from(chartPlacements)).toHaveLength(1);
  });
});
```

Run: `npx vitest run src/db/observations.db.test.ts`
Expected: FAIL to compile, or skipped.

**Step 2: Implement `src/db/observations.ts`**

```ts
import { sql } from "drizzle-orm";
import { chunk, uniqueBy } from "@/lib/arrays";
import type { Database } from "./client";
import { censusObservations, chartPlacements, gameObservations, voteObservations } from "./schema";

// "replace" for live collectors (a retry in the same slot overwrites);
// "keep" for imports that must never overwrite collected data.
export type WriteMode = "replace" | "keep";

export type GameObservationRow = typeof gameObservations.$inferInsert;
export type CensusObservationRow = typeof censusObservations.$inferInsert;
export type VoteObservationRow = typeof voteObservations.$inferInsert;
export type ChartPlacementRow = typeof chartPlacements.$inferInsert;

const CHUNK_SIZE = 2_000;

export async function writeGameObservations(db: Database, rows: GameObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(gameObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [gameObservations.universeId, gameObservations.observedAt],
        set: { ccu: sql`excluded.ccu`, visits: sql`excluded.visits`, favorites: sql`excluded.favorites`, source: sql`excluded.source` },
      });
  }
  return unique.length;
}

export async function writeCensusObservations(db: Database, rows: CensusObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.placeId}:${row.observedAt.getTime()}`);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(censusObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [censusObservations.placeId, censusObservations.observedAt],
        set: { ccu: sql`excluded.ccu` },
      });
  }
  return unique.length;
}

export async function writeVoteObservations(db: Database, rows: VoteObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(voteObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [voteObservations.universeId, voteObservations.observedAt],
        set: { upVotes: sql`excluded.up_votes`, downVotes: sql`excluded.down_votes` },
      });
  }
  return unique.length;
}

export async function writeChartPlacements(db: Database, rows: ChartPlacementRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.sortId}:${row.universeId}:${row.observedAt.getTime()}`);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(chartPlacements).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [chartPlacements.sortId, chartPlacements.universeId, chartPlacements.observedAt],
        set: { rank: sql`excluded.rank`, playerCount: sql`excluded.player_count`, isSponsored: sql`excluded.is_sponsored` },
      });
  }
  return unique.length;
}
```

**Step 3: Run tests and typecheck**

Run: `npx vitest run src/db/observations.db.test.ts && npm run typecheck`
Expected: 3 passed (or skipped); typecheck passes.

**Step 4: Commit and confirm in CI**

```bash
git add src/db/observations.ts src/db/observations.db.test.ts
git commit -m "feat(db): add idempotent observation writers"
git push && gh run watch --exit-status
```

---

### Task 8: Promotion helper and the `census` job

**Files:**
- Create: `src/lib/jobs/promotion.ts`, `src/lib/jobs/census.ts`, `src/lib/jobs/census.test.ts`, `src/lib/jobs/census.db.test.ts`
- Modify: `src/lib/jobs/registry.ts`, `src/lib/config.ts`

**Step 0: Add the census baseline window to `src/lib/config.ts`**

In `JOB_CONFIG.census`, add `baselineMaxAgeHours: 6,` after `maximumListSizeChange: 0.3,`. Without a recent successful run, there is no baseline and the run is accepted, so a legitimate permanent change in the list size recovers after six hours.

**Step 1: Write the failing pure tests**

`src/lib/jobs/census.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { evaluateCensusQuality, selectPlacesToResolve } from "./census";

function listed(placeId: string, ccu: number): RolimonsGame {
  return { placeId, name: `Place ${placeId}`, ccu, thumbnailUrl: "" };
}

describe("evaluateCensusQuality", () => {
  it("accepts the first run", () => {
    expect(evaluateCensusQuality(7_800, null, 0.3)).toBe("success");
  });

  it("accepts normal variation", () => {
    expect(evaluateCensusQuality(7_000, 7_800, 0.3)).toBe("success");
  });

  it("flags a sudden drop", () => {
    expect(evaluateCensusQuality(4_000, 7_800, 0.3)).toBe("degraded");
  });

  it("flags an empty list", () => {
    expect(evaluateCensusQuality(0, null, 0.3)).toBe("degraded");
  });
});

describe("selectPlacesToResolve", () => {
  it("keeps unknown places at or above the threshold, highest CCU first", () => {
    const games = [listed("1", 90), listed("2", 150), listed("3", 400), listed("4", 1_000)];
    expect(selectPlacesToResolve(games, new Set([4]), 100).map((game) => game.placeId)).toEqual(["3", "2"]);
  });
});
```

Run: `npx vitest run src/lib/jobs/census.test.ts`
Expected: FAIL, module not found.

**Step 2: Implement `src/lib/jobs/promotion.ts`**

```ts
import type { Database } from "@/db/client";
import { recordDiscoveries } from "@/db/discovery";
import { knownUniverseIds, upsertGameDetails } from "@/db/games";
import type { RobloxApi } from "@/lib/api/roblox";
import type { DiscoverySource } from "./types";

export interface PromotionCandidate {
  universeId: number;
  source: DiscoverySource;
  detail: string;
}

// Adds unknown universes to the games table and records how they were found.
// With recordKnown, discoveries of already-tracked games are recorded too.
export async function promoteUniverses(
  db: Database,
  roblox: Pick<RobloxApi, "getGameDetails">,
  candidates: PromotionCandidate[],
  now: Date,
  options: { recordKnown?: boolean } = {},
): Promise<{ promoted: number; discoveries: number }> {
  if (!candidates.length) return { promoted: 0, discoveries: 0 };
  const universeIds = [...new Set(candidates.map((candidate) => candidate.universeId))];
  const knownBefore = await knownUniverseIds(db, universeIds);
  const unknown = universeIds.filter((universeId) => !knownBefore.has(universeId));
  let promoted = 0;
  if (unknown.length) {
    const details = await roblox.getGameDetails(unknown.map(String));
    promoted = (await upsertGameDetails(db, details, now)).inserted.length;
  }
  const knownAfter = await knownUniverseIds(db, universeIds);
  const discoveries = candidates
    .filter((candidate) => knownAfter.has(candidate.universeId))
    .filter((candidate) => options.recordKnown || !knownBefore.has(candidate.universeId))
    .map((candidate) => ({ ...candidate, firstSeenAt: now, lastSeenAt: now }));
  return { promoted, discoveries: await recordDiscoveries(db, discoveries) };
}
```

**Step 3: Implement `src/lib/jobs/census.ts`**

```ts
import { savePlaceResolution, placesToSkip, unpromotedUniverses } from "@/db/places";
import { latestSuccessfulRun } from "@/db/job-runs";
import { writeCensusObservations } from "@/db/observations";
import { HttpError } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { promoteUniverses } from "./promotion";
import type { JobDefinition } from "./runner";

export interface CensusDependencies {
  fetchGames(): Promise<RolimonsGame[]>;
  roblox: Pick<RobloxApi, "resolveUniverseId" | "getGameDetails">;
  clock?: () => number;
}

export function evaluateCensusQuality(listed: number, previousListed: number | null, maximumChange: number): "success" | "degraded" {
  if (listed === 0) return "degraded";
  if (!previousListed) return "success";
  return Math.abs(listed - previousListed) / previousListed > maximumChange ? "degraded" : "success";
}

export function selectPlacesToResolve(games: RolimonsGame[], skip: Set<number>, minimumCcu: number): RolimonsGame[] {
  return games
    .filter((game) => game.ccu >= minimumCcu && !skip.has(Number(game.placeId)))
    .sort((a, b) => b.ccu - a.ccu);
}

export function createCensusJob(dependencies: CensusDependencies): JobDefinition {
  const config = JOB_CONFIG.census;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "census",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const listed = (await dependencies.fetchGames()).filter((game) => Number.isSafeInteger(Number(game.placeId)));
      await writeCensusObservations(
        db,
        listed.map((game) => ({ placeId: Number(game.placeId), observedAt: slot, ccu: Math.round(game.ccu) })),
      );
      // Baseline: the latest fully successful run of the last hours, so one truncated list never becomes the reference.
      // started_at is wall-clock time, so the window uses the clock, not the injectable `now`.
      const baselineSince = new Date(clock() - config.baselineMaxAgeHours * 60 * 60 * 1000);
      const previous = await latestSuccessfulRun(db, "census", baselineSince);
      const previousListed = typeof previous?.stats.listed === "number" ? previous.stats.listed : null;
      const status = evaluateCensusQuality(listed.length, previousListed, config.maximumListSizeChange);

      const eligibleIds = listed.filter((game) => game.ccu >= config.promotionMinimumCcu).map((game) => Number(game.placeId));
      const skip = await placesToSkip(db, eligibleIds, now, config.resolutionRetryDays);
      const candidates = selectPlacesToResolve(listed, skip, config.promotionMinimumCcu);
      const deadline = clock() + config.resolutionBudgetMs;
      let resolved = 0;
      let unresolvable = 0;
      let resolutionFailures = 0;
      let deferred = 0;
      for (const [index, candidate] of candidates.entries()) {
        if (clock() > deadline) {
          deferred = candidates.length - index;
          break;
        }
        const placeId = Number(candidate.placeId);
        try {
          const universeId = Number(await dependencies.roblox.resolveUniverseId(candidate.placeId));
          await savePlaceResolution(db, { placeId, universeId, resolvedAt: now, error: null });
          resolved += 1;
        } catch (error) {
          if (error instanceof HttpError && (error.status === 400 || error.status === 404)) {
            await savePlaceResolution(db, { placeId, universeId: null, resolvedAt: now, error: errorMessage(error) });
            unresolvable += 1;
          } else {
            resolutionFailures += 1;
            logger.warn("Place resolution failed; retrying next run", { placeId, error: errorMessage(error) });
          }
        }
      }

      const universes = await unpromotedUniverses(db, eligibleIds);
      const promotion = await promoteUniverses(
        db,
        dependencies.roblox,
        universes.map((universeId) => ({ universeId, source: "rolimons" as const, detail: "" })),
        now,
      );
      return {
        status,
        stats: {
          listed: listed.length,
          eligible: eligibleIds.length,
          resolved,
          unresolvable,
          resolutionFailures,
          deferred,
          promoted: promotion.promoted,
        },
      };
    },
  };
}
```

Run: `npx vitest run src/lib/jobs/census.test.ts`
Expected: PASS (5 tests).

**Step 4: Write the database test with fake APIs**

`src/lib/jobs/census.db.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { censusObservations, discoverySources, games, places } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { HttpError } from "@/lib/api/http";
import { gameDetail } from "@/test/fixtures";
import { createCensusJob } from "./census";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("census job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("stores the list, resolves eligible places and promotes their universes", async () => {
    const job = createCensusJob({
      fetchGames: async () => [
        { placeId: "1", name: "Big", ccu: 500, thumbnailUrl: "" },
        { placeId: "2", name: "Small", ccu: 50, thumbnailUrl: "" },
        { placeId: "404", name: "Gone", ccu: 300, thumbnailUrl: "" },
      ],
      roblox: {
        resolveUniverseId: async (placeId) => {
          if (placeId === "404") throw new HttpError(404, "Not Found", "https://apis.roblox.com/universes");
          return String(Number(placeId) + 1_000);
        },
        getGameDetails: async (universeIds) => universeIds.map((universeId) => gameDetail(Number(universeId))),
      },
    });

    const status = await executeJob(job, database.db, new Date("2026-10-20T14:13:00Z"));

    expect(status).toBe("success");
    expect(await database.db.select().from(censusObservations)).toHaveLength(3);
    const [resolved] = await database.db.select().from(places).where(eq(places.placeId, 1));
    expect(resolved.universeId).toBe(1_001);
    const [unresolvable] = await database.db.select().from(places).where(eq(places.placeId, 404));
    expect(unresolvable.universeId).toBeNull();
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([1_001]);
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 1_001, source: "rolimons", detail: "" }),
    ]);
  });

  it("marks a run degraded when the list shrinks sharply against the last successful run", async () => {
    const job = createCensusJob({
      fetchGames: async () => [{ placeId: "1", name: "Big", ccu: 500, thumbnailUrl: "" }],
      roblox: {
        resolveUniverseId: async (placeId) => String(Number(placeId) + 1_000),
        getGameDetails: async (universeIds) => universeIds.map((universeId) => gameDetail(Number(universeId))),
      },
    });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:23:00Z"))).toBe("degraded");
  });
});
```

Run: `npx vitest run src/lib/jobs/census.db.test.ts`
Expected: PASS with a test database (skipped otherwise).

**Step 5: Register the job**

`src/lib/jobs/registry.ts`:

```ts
import { RobloxClient } from "@/lib/api/roblox";
import { getRolimonsGames } from "@/lib/api/rolimons";
import { ROBLOX_REGION } from "@/lib/config";
import { createCensusJob } from "./census";
import type { JobDefinition } from "./runner";

export function createJobs(): JobDefinition[] {
  const roblox = new RobloxClient(ROBLOX_REGION.country, ROBLOX_REGION.device);
  return [createCensusJob({ fetchGames: getRolimonsGames, roblox })];
}
```

**Step 6: Typecheck, commit and confirm in CI**

```bash
npm run typecheck
git add src/lib/jobs
git commit -m "feat(jobs): add census collector with place resolution and promotion"
git push && gh run watch --exit-status
```

---

### Task 9: Active set, deadline batching and the `poll` job

**Files:**
- Create: `src/lib/jobs/batching.ts`, `src/lib/jobs/batching.test.ts`, `src/db/active-set.ts`, `src/db/active-set.db.test.ts`, `src/lib/jobs/poll.ts`, `src/lib/jobs/poll.db.test.ts`
- Modify: `src/lib/jobs/registry.ts`

**Step 1: Write the failing batching tests**

`src/lib/jobs/batching.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateCollectionQuality, runBatchesWithDeadline } from "./batching";

describe("runBatchesWithDeadline", () => {
  it("processes every batch when time allows", async () => {
    const outcome = await runBatchesWithDeadline([1, 2, 3], 2, 100, () => 0, async (batch) => batch.map((item) => item * 10));
    expect(outcome).toEqual({ results: [10, 20, 30], attempted: 3, failedBatches: 0, skippedItems: 0 });
  });

  it("skips the remaining items once the deadline passes", async () => {
    let now = 0;
    const outcome = await runBatchesWithDeadline([1, 2, 3, 4, 5], 2, 10, () => now, async (batch) => {
      now += 20;
      return batch;
    });
    expect(outcome).toEqual({ results: [1, 2], attempted: 2, failedBatches: 0, skippedItems: 3 });
  });

  it("counts failed batches and keeps going", async () => {
    const outcome = await runBatchesWithDeadline([1, 2, 3], 1, 100, () => 0, async (batch) => {
      if (batch[0] === 2) throw new Error("boom");
      return batch;
    });
    expect(outcome).toEqual({ results: [1, 3], attempted: 3, failedBatches: 1, skippedItems: 0 });
  });
});

describe("evaluateCollectionQuality", () => {
  const thresholds = { minimumReturnedShare: 0.95, maximumSkippedShare: 0.1 };

  it("accepts a complete run", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 100, returned: 98, ...thresholds })).toBe("success");
  });

  it("flags missing responses", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 100, returned: 90, ...thresholds })).toBe("degraded");
  });

  it("flags heavy shedding", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 80, returned: 80, ...thresholds })).toBe("degraded");
  });

  it("accepts an empty run", () => {
    expect(evaluateCollectionQuality({ requested: 0, attempted: 0, returned: 0, ...thresholds })).toBe("success");
  });
});
```

Run: `npx vitest run src/lib/jobs/batching.test.ts`
Expected: FAIL, module not found.

**Step 2: Implement `src/lib/jobs/batching.ts`**

```ts
import { chunk } from "@/lib/arrays";

export interface BatchOutcome<R> {
  results: R[];
  attempted: number;
  failedBatches: number;
  skippedItems: number;
}

// Items arrive in priority order, so a missed deadline sheds the least important ones.
export async function runBatchesWithDeadline<I, R>(
  items: I[],
  batchSize: number,
  deadline: number,
  clock: () => number,
  work: (batch: I[]) => Promise<R[]>,
  onError?: (error: unknown) => void,
): Promise<BatchOutcome<R>> {
  const results: R[] = [];
  const batches = chunk(items, batchSize);
  let attempted = 0;
  let failedBatches = 0;
  let skippedItems = 0;
  for (const [index, batch] of batches.entries()) {
    if (clock() > deadline) {
      skippedItems = batches.slice(index).reduce((total, rest) => total + rest.length, 0);
      break;
    }
    attempted += batch.length;
    try {
      results.push(...(await work(batch)));
    } catch (error) {
      failedBatches += 1;
      onError?.(error);
    }
  }
  return { results, attempted, failedBatches, skippedItems };
}

export function evaluateCollectionQuality(input: {
  requested: number;
  attempted: number;
  returned: number;
  minimumReturnedShare: number;
  maximumSkippedShare: number;
}): "success" | "degraded" {
  if (input.requested === 0) return "success";
  const returnedShare = input.attempted ? input.returned / input.attempted : 0;
  const skippedShare = (input.requested - input.attempted) / input.requested;
  return returnedShare >= input.minimumReturnedShare && skippedShare <= input.maximumSkippedShare ? "success" : "degraded";
}
```

Run: `npx vitest run src/lib/jobs/batching.test.ts`
Expected: PASS (7 tests).

**Step 3: Write the failing active-set test**

`src/db/active-set.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { selectActiveUniverses } from "./active-set";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("selectActiveUniverses", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:00:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    const old = new Date("2025-01-01T00:00:00Z");
    await upsertGameDetails(database.db, [
      gameDetail(1, { playing: 5_000, created: old }),
      gameDetail(2, { playing: 0, created: old }),
      gameDetail(3, { playing: 0, created: old }),
      gameDetail(4, { playing: 10, created: new Date("2026-10-10T00:00:00Z") }),
      gameDetail(5, { playing: 0, created: old }),
      gameDetail(6, { playing: 0, created: old }),
    ], now);
    // Game 2 peaked earlier today; game 3 only appears in the census; game 5 is quiet; game 6 peaked two days ago.
    await writeGameObservations(database.db, [
      { universeId: 2, observedAt: new Date("2026-10-20T09:00:00Z"), ccu: 800, visits: 1, favorites: 1 },
      { universeId: 6, observedAt: new Date("2026-10-18T09:00:00Z"), ccu: 900, visits: 1, favorites: 1 },
    ]);
    await savePlaceResolution(database.db, { placeId: 333, universeId: 3, resolvedAt: now, error: null });
    await writeCensusObservations(database.db, [{ placeId: 333, observedAt: new Date("2026-10-20T13:50:00Z"), ccu: 120 }]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("selects busy, recently busy, census-visible and young active games by priority", async () => {
    const active = await selectActiveUniverses(database.db, now);
    expect(active).toEqual([
      { universeId: 1, priority: 5_000 },
      { universeId: 2, priority: 800 },
      { universeId: 3, priority: 120 },
      { universeId: 4, priority: 10 },
    ]);
  });
});
```

Run: `npx vitest run src/db/active-set.db.test.ts`
Expected: FAIL to compile, or skipped.

**Step 4: Implement `src/db/active-set.ts`**

```ts
import { sql } from "drizzle-orm";
import { ACTIVE_SET_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export interface ActiveUniverse {
  universeId: number;
  priority: number;
}

// Games worth polling, highest priority first so deadline shedding drops the quietest.
export async function selectActiveUniverses(db: Database, now: Date): Promise<ActiveUniverse[]> {
  const config = ACTIVE_SET_CONFIG;
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; priority: number }>(sql`
    with recent as (
      select universe_id, max(ccu_max) as peak
      from game_hourly
      where bucket > ${at}::timestamptz - make_interval(hours => ${config.lookbackHours}::int)
      group by universe_id
    ),
    census_now as (
      select p.universe_id, max(c.ccu) as ccu
      from census_observations c
      join places p on p.place_id = c.place_id
      where c.observed_at > ${at}::timestamptz - make_interval(mins => ${config.censusLookbackMinutes}::int)
        and p.universe_id is not null
      group by p.universe_id
    )
    select g.universe_id, greatest(coalesce(r.peak, 0), coalesce(c.ccu, 0), g.last_ccu)::int as priority
    from games g
    left join recent r on r.universe_id = g.universe_id
    left join census_now c on c.universe_id = g.universe_id
    where coalesce(r.peak, 0) >= ${config.minimumCcu}
       or coalesce(c.ccu, 0) >= ${config.minimumCcu}
       or g.last_ccu >= ${config.minimumCcu}
       or (
         g.roblox_created_at > ${at}::timestamptz - make_interval(days => ${config.recentGameMaximumAgeDays}::int)
         and g.last_ccu > 0
         and g.last_ccu_at > ${at}::timestamptz - make_interval(days => ${config.recentGameActivityDays}::int)
       )
    order by priority desc, g.universe_id
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), priority: Number(row.priority) }));
}
```

Run: `npx vitest run src/db/active-set.db.test.ts`
Expected: PASS with a test database.

**Step 5: Implement `src/lib/jobs/poll.ts`**

```ts
import { selectActiveUniverses } from "@/db/active-set";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface PollDependencies {
  roblox: Pick<RobloxApi, "getGameDetails">;
  clock?: () => number;
}

export function createPollJob(dependencies: PollDependencies): JobDefinition {
  const config = JOB_CONFIG.poll;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "poll",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      const outcome = await runBatchesWithDeadline(
        active.map((item) => String(item.universeId)),
        config.batchSize,
        clock() + config.deadlineMs,
        clock,
        (batch) => dependencies.roblox.getGameDetails(batch),
        (error) => logger.warn("Poll batch failed", { error: errorMessage(error) }),
      );
      const details = outcome.results;
      // Observations first: the hypertable has no foreign key, and a lock timeout or deadlock in the
      // games upsert must not lose this 5-minute CCU slot.
      await writeGameObservations(
        db,
        details.map((detail) => ({
          universeId: detail.id,
          observedAt: slot,
          ccu: Math.round(detail.playing),
          visits: Math.round(detail.visits),
          favorites: Math.round(detail.favoritedCount),
        })),
      );
      const upsert = await upsertGameDetails(db, details, now);
      const status = evaluateCollectionQuality({
        requested: active.length,
        attempted: outcome.attempted,
        returned: details.length,
        minimumReturnedShare: config.minimumReturnedShare,
        maximumSkippedShare: config.maximumSkippedShare,
      });
      return {
        status,
        stats: {
          active: active.length,
          attempted: outcome.attempted,
          returned: details.length,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          newGames: upsert.inserted.length,
          metadataChanges: upsert.metadataChanged.length,
        },
      };
    },
  };
}
```

**Step 6: Write the poll database test**

`src/lib/jobs/poll.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { gameObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { createPollJob } from "./poll";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("poll job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:07:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1, { playing: 500 }), gameDetail(2, { playing: 400 })], now);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("writes one observation per returned game in the five-minute slot", async () => {
    const job = createPollJob({
      roblox: { getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id), { playing: 700 })) },
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    const rows = await database.db.select().from(gameObservations);
    expect(rows.map((row) => [row.universeId, row.ccu, row.observedAt.toISOString()]).sort()).toEqual([
      [1, 700, "2026-10-20T14:05:00.000Z"],
      [2, 700, "2026-10-20T14:05:00.000Z"],
    ]);
  });

  it("marks a run degraded when games are missing from the response", async () => {
    const job = createPollJob({
      roblox: { getGameDetails: async (ids) => ids.slice(0, 1).map((id) => gameDetail(Number(id))) },
    });
    expect(await executeJob(job, database.db, now)).toBe("degraded");
  });
});
```

Run: `npx vitest run src/lib/jobs/poll.db.test.ts`
Expected: PASS with a test database.

**Step 7: Register the job**

In `src/lib/jobs/registry.ts`, import `createPollJob` from `./poll` and return:

```ts
  return [createCensusJob({ fetchGames: getRolimonsGames, roblox }), createPollJob({ roblox })];
```

**Step 8: Typecheck, commit and confirm in CI**

```bash
npm run typecheck
git add src/db/active-set.ts src/db/active-set.db.test.ts src/lib/jobs
git commit -m "feat(jobs): add five-minute poll collector with priority shedding"
git push && gh run watch --exit-status
```

---

### Task 10: The `votes` job

**Files:**
- Create: `src/lib/jobs/votes.ts`, `src/lib/jobs/votes.db.test.ts`
- Modify: `src/lib/jobs/registry.ts`

**Step 1: Write the failing database test**

`src/lib/jobs/votes.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { voteObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createVotesJob } from "./votes";

describe.skipIf(!hasTestDatabase)("votes job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:20:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1, { playing: 500 })], now);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("writes hourly vote totals for active games", async () => {
    const job = createVotesJob({
      roblox: { getGameVotes: async (ids) => ids.map((id) => ({ id: Number(id), upVotes: 90, downVotes: 10 })) },
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    const [row] = await database.db.select().from(voteObservations);
    expect(row).toEqual({ universeId: 1, observedAt: new Date("2026-10-20T14:00:00Z"), upVotes: 90, downVotes: 10 });
  });
});
```

**Step 2: Share the rate-limit and HTTP metric helpers, then implement `src/lib/jobs/votes.ts`**

Move `isRateLimited` and `httpMetricsSince` from `src/lib/jobs/poll.ts` into `src/lib/jobs/batching.ts` as exports (unchanged), and import them in `poll.ts` (a `refactor:` commit of its own). Then create `src/lib/jobs/votes.ts`, following the committed poll job: votes are written batch by batch, a terminal 429 stops the run, repeated batch failures stop it, and quality is gated on requested games.

```ts
import { selectActiveUniverses } from "@/db/active-set";
import { writeVoteObservations } from "@/db/observations";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, httpMetricsSince, isRateLimited, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface VotesDependencies {
  roblox: Pick<RobloxApi, "getGameVotes">;
  // Measures the deadline only.
  clock?: () => number;
}

export function createVotesJob(dependencies: VotesDependencies): JobDefinition {
  const config = JOB_CONFIG.votes;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "votes",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      const httpBefore = getHttpRequestMetrics();
      const outcome = await runBatchesWithDeadline(
        active.map((item) => String(item.universeId)),
        {
          batchSize: config.batchSize,
          deadline: clock() + config.deadlineMs,
          clock,
          work: (batch) => dependencies.roblox.getGameVotes(batch),
          onError: (error, batch) =>
            logger.warn("Votes batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) }),
          stopOn: isRateLimited,
          maximumConsecutiveFailedBatches: config.maximumConsecutiveFailedBatches,
          store: async (votes) => {
            await writeVoteObservations(
              db,
              votes.map((vote) => ({ universeId: vote.id, observedAt: slot, upVotes: vote.upVotes, downVotes: vote.downVotes })),
            );
          },
        },
      );
      const status =
        active.length === 0
          ? "degraded"
          : evaluateCollectionQuality({
              requested: active.length,
              returned: outcome.results.length,
              minimumReturnedShare: config.minimumReturnedShare,
            });
      return {
        status,
        stats: {
          active: active.length,
          attempted: outcome.attempted,
          returned: outcome.results.length,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          stoppedBy: outcome.stoppedBy,
          rateLimited: outcome.stoppedBy === "error",
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
```

Add to `src/lib/jobs/votes.db.test.ts` a test where the fake throws `new HttpError(429, "Too Many Requests", "https://games.roblox.com/v1/games/votes")` for the first batch: the run is `degraded`, `rateLimited` is true in `job_runs.stats`, and no vote row is written.

**Step 3: Register, test, commit**

Add `createVotesJob({ roblox })` to the array in `src/lib/jobs/registry.ts` (import from `./votes`).

```bash
npx vitest run src/lib/jobs/votes.db.test.ts src/lib/jobs/poll.db.test.ts && npm run typecheck
git add src/lib/jobs/votes.ts src/lib/jobs/votes.db.test.ts src/lib/jobs/registry.ts
git commit -m "feat(jobs): add hourly votes collector"
git push && gh run watch --exit-status
```

---

### Task 11: The `charts` job

**Files:**
- Create: `src/lib/jobs/charts.ts`, `src/lib/jobs/charts.test.ts`, `src/lib/jobs/charts.db.test.ts`
- Modify: `src/db/observations.ts` (add `replaceChartSlot`), `src/lib/jobs/registry.ts`

**Step 1: Write the failing pure test**

`src/lib/jobs/charts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toChartPlacements } from "./charts";

describe("toChartPlacements", () => {
  it("ranks games from 1 and keeps the best rank of a repeated game", () => {
    const observedAt = new Date("2026-10-20T14:00:00Z");
    const placements = toChartPlacements("top-trending", [
      { universeId: 10, rootPlaceId: 1, name: "A", playerCount: 500, isSponsored: true },
      { universeId: 20, rootPlaceId: 2, name: "B", playerCount: 300.4 },
      { universeId: 10, rootPlaceId: 1, name: "A", playerCount: 500 },
    ], observedAt);
    expect(placements).toEqual([
      { sortId: "top-trending", universeId: 10, observedAt, rank: 1, playerCount: 500, isSponsored: true },
      { sortId: "top-trending", universeId: 20, observedAt, rank: 2, playerCount: 300, isSponsored: null },
    ]);
  });
});
```

**Step 2: Implement `src/lib/jobs/charts.ts`**

```ts
import { replaceChartSlot, type ChartPlacementRow } from "@/db/observations";
import type { RobloxApi, RobloxChartGame } from "@/lib/api/roblox";
import { uniqueBy } from "@/lib/arrays";
import { JOB_CONFIG, ROBLOX_DISCOVERY_CHARTS } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { PromotionApiError, promoteUniverses, type PromotionCandidate } from "./promotion";
import type { JobDefinition } from "./runner";

export interface ChartsDependencies {
  roblox: Pick<RobloxApi, "getSortContent" | "getGameDetails">;
  sortIds?: readonly string[];
}

export function toChartPlacements(sortId: string, chartGames: RobloxChartGame[], observedAt: Date): ChartPlacementRow[] {
  return uniqueBy(
    chartGames.map((game, index) => ({
      sortId,
      universeId: game.universeId,
      observedAt,
      rank: index + 1,
      playerCount: Math.round(game.playerCount),
      isSponsored: game.isSponsored ?? null,
    })),
    (row) => row.universeId,
  );
}

export function createChartsJob(dependencies: ChartsDependencies): JobDefinition {
  const config = JOB_CONFIG.charts;
  const sortIds = dependencies.sortIds ?? ROBLOX_DISCOVERY_CHARTS;
  return {
    name: "charts",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const placementsBySort = new Map<string, ChartPlacementRow[]>();
      const candidates: PromotionCandidate[] = [];
      let failedSorts = 0;
      for (const sortId of sortIds) {
        try {
          const sort = await dependencies.roblox.getSortContent(sortId);
          const rows = toChartPlacements(sortId, sort.games, slot);
          placementsBySort.set(sortId, rows);
          candidates.push(...rows.map((row) => ({ universeId: row.universeId, source: "chart" as const, detail: sortId })));
        } catch (error) {
          failedSorts += 1;
          logger.warn("Chart collection failed", { sortId, error: errorMessage(error) });
        }
      }
      // A failed sort keeps whatever an earlier attempt in this hour stored for it.
      let placements = 0;
      for (const [sortId, rows] of placementsBySort) placements += await replaceChartSlot(db, sortId, slot, rows);
      // A promotion failure must not discard the placements already stored; the next run retries it.
      let promoted = 0;
      let promotionError: string | undefined;
      try {
        promoted = (await promoteUniverses(db, dependencies.roblox, candidates, now)).promoted;
      } catch (error) {
        if (!(error instanceof PromotionApiError)) throw error; // database errors fail the run
        promotionError = errorMessage(error);
        logger.error("Chart promotion failed; retrying next run", { error: promotionError });
      }
      const succeededSorts = sortIds.length - failedSorts;
      const sortsOk = sortIds.length > 0 && succeededSorts / sortIds.length >= config.minimumSortShare;
      return {
        status: sortsOk && !promotionError ? "success" : "degraded",
        stats: { sorts: sortIds.length, failedSorts, placements, promotionRequested: candidates.length, promoted, promotionError },
      };
    },
  };
}
```

**Step 3: Write the database test**

`src/lib/jobs/charts.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartPlacements, discoverySources, games } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { createChartsJob } from "./charts";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("charts job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("stores placements, promotes new games and tolerates one failing sort", async () => {
    const job = createChartsJob({
      sortIds: ["top-trending", "up-and-coming", "top-earning", "top-rated", "most-popular"],
      roblox: {
        getSortContent: async (sortId) => {
          if (sortId === "top-rated") throw new Error("unavailable");
          return { sortId, sortDisplayName: sortId, games: [{ universeId: 7, rootPlaceId: 70, name: "Seven", playerCount: 900 }] };
        },
        getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id))),
      },
    });
    expect(await executeJob(job, database.db, new Date("2026-10-20T14:02:00Z"))).toBe("success");
    expect(await database.db.select().from(chartPlacements)).toHaveLength(4);
    expect((await database.db.select().from(games)).map((game) => game.universeId)).toEqual([7]);
    expect((await database.db.select().from(discoverySources)).map((row) => row.detail).sort()).toEqual([
      "most-popular",
      "top-earning",
      "top-trending",
      "up-and-coming",
    ]);
  });
});
```

**Step 3b: Add `replaceChartSlot` to `src/db/observations.ts`**

A chart is a ranking: a retry within the same hour must replace the whole slot of that sort, otherwise a game that dropped out between attempts keeps a stale rank next to the game that took it. Add `and, eq` to the `drizzle-orm` import and append:

```ts
// Replaces every placement of one sort in one slot, atomically. Rows are sorted by key, like the other writers.
export async function replaceChartSlot(db: Database, sortId: string, observedAt: Date, rows: ChartPlacementRow[]): Promise<number> {
  const unique = uniqueBy(rows, (row) => row.universeId).sort((a, b) => a.universeId - b.universeId);
  return db.transaction(async (transaction) => {
    await transaction
      .delete(chartPlacements)
      .where(and(eq(chartPlacements.sortId, sortId), eq(chartPlacements.observedAt, observedAt)));
    let written = 0;
    for (const part of chunk(unique, CHUNK_SIZE)) {
      const result = await transaction.insert(chartPlacements).values(part);
      written += result.rowCount ?? 0;
    }
    return written;
  });
}
```

Add to `src/lib/jobs/charts.db.test.ts`, inside the `describe`:

```ts
  it("replaces the whole slot of a sort when the same hour is collected again", async () => {
    const lists: Record<number, number[]> = { 1: [7, 8], 2: [7] };
    let attempt = 0;
    const job = createChartsJob({
      sortIds: ["up-and-coming"],
      roblox: {
        getSortContent: async (sortId) => {
          attempt += 1;
          return {
            sortId,
            sortDisplayName: sortId,
            games: lists[attempt].map((universeId) => ({ universeId, rootPlaceId: universeId * 10, name: `Game ${universeId}`, playerCount: 100 })),
          };
        },
        getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id))),
      },
    });
    const at = new Date("2026-10-20T15:02:00Z");
    await executeJob(job, database.db, at);
    await executeJob(job, database.db, at);
    const rows = await database.db
      .select()
      .from(chartPlacements)
      .where(and(eq(chartPlacements.sortId, "up-and-coming"), eq(chartPlacements.observedAt, new Date("2026-10-20T15:00:00Z"))));
    expect(rows.map((row) => row.universeId)).toEqual([7]);
  });
```

Add `and, eq` from `drizzle-orm` to the test imports.

**Step 4: Register, test, commit**

Add `createChartsJob({ roblox })` to the registry array (import from `./charts`).

```bash
npx vitest run src/lib/jobs/charts.test.ts src/lib/jobs/charts.db.test.ts && npm run typecheck
git add src/lib/jobs
git commit -m "feat(jobs): add hourly charts collector"
git push && gh run watch --exit-status
```

---

### Task 12: The `explore` job

**Files:**
- Create: `src/db/explore.ts`, `src/lib/jobs/explore.ts`, `src/lib/jobs/explore.test.ts`, `src/lib/jobs/explore.db.test.ts`
- Modify: `src/lib/jobs/registry.ts`

**Step 1: Write the failing pure test**

`src/lib/jobs/explore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectSearchTerms } from "./explore";

describe("selectSearchTerms", () => {
  it("returns the most shared meaningful title words", () => {
    expect(selectSearchTerms(["Steal An Egg", "Break and Steal an Egg", "[🎃] +1 Stone Skipping", "Egg Obby"], 2)).toEqual([
      "egg",
      "steal",
    ]);
  });

  it("ignores generic format words and numbers", () => {
    expect(selectSearchTerms(["Tycoon Simulator 2", "Obby 99"], 5)).toEqual([]);
  });
});
```

**Step 2: Implement `src/db/explore.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface RisingSeed {
  universeId: number;
  name: string;
  gain: number;
}

// Young games with the largest CCU gain over the last day, used as exploration seeds.
export async function selectRisingSeeds(db: Database, now: Date, count: number, maximumAgeDays: number): Promise<RisingSeed[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; name: string; gain: number }>(sql`
    with current_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - interval '6 hours'
      group by universe_id
    ),
    previous_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - interval '30 hours' and bucket <= ${at}::timestamptz - interval '24 hours'
      group by universe_id
    )
    select g.universe_id, g.name, (cw.ccu - coalesce(pw.ccu, 0))::float8 as gain
    from games g
    join current_window cw on cw.universe_id = g.universe_id
    left join previous_window pw on pw.universe_id = g.universe_id
    where g.roblox_created_at > ${at}::timestamptz - make_interval(days => ${maximumAgeDays}::int)
    order by gain desc, g.universe_id
    limit ${count}
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), name: row.name, gain: Number(row.gain) }));
}
```

**Step 3: Implement `src/lib/jobs/explore.ts`**

```ts
import { selectRisingSeeds } from "@/db/explore";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { normalizeTitle } from "@/lib/title";
import { PromotionApiError, promoteUniverses, type PromotionCandidate } from "./promotion";
import type { JobDefinition } from "./runner";

const SEARCH_STOP_WORDS = new Set([
  "and", "the", "for", "with", "your", "you", "from", "into", "but", "are",
  "game", "games", "roblox", "simulator", "obby", "tycoon", "update", "new",
]);

export function selectSearchTerms(titles: string[], count: number): string[] {
  const frequency = new Map<string, number>();
  for (const title of titles) {
    const tokens = new Set(
      normalizeTitle(title)
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^['+-]+|['+-]+$/g, ""))
        .filter((token) => token.length >= 3 && /\p{L}/u.test(token) && !SEARCH_STOP_WORDS.has(token)),
    );
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return [...frequency.entries()]
    .filter(([, occurrences]) => occurrences >= (titles.length > 1 ? 2 : 1))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([term]) => term);
}

export interface ExploreDependencies {
  roblox: Pick<RobloxApi, "getRecommendations" | "searchGames" | "getGameDetails">;
}

export function createExploreJob(dependencies: ExploreDependencies): JobDefinition {
  const config = JOB_CONFIG.explore;
  return {
    name: "explore",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const seeds = await selectRisingSeeds(db, now, config.seedCount, config.seedMaximumAgeDays);
      const terms = selectSearchTerms(seeds.map((seed) => seed.name), config.searchTermCount);
      const candidates: PromotionCandidate[] = [];
      let requests = 0;
      let failures = 0;
      for (const seed of seeds) {
        requests += 1;
        try {
          const related = await dependencies.roblox.getRecommendations(String(seed.universeId), config.recommendationsPerSeed);
          for (const game of related) {
            if (game.playerCount >= config.minimumDiscoveryCcu) {
              candidates.push({ universeId: game.universeId, source: "recommendation", detail: String(seed.universeId) });
            }
          }
        } catch (error) {
          failures += 1;
          logger.warn("Recommendation exploration failed", { seed: seed.universeId, error: errorMessage(error) });
        }
      }
      for (const term of terms) {
        requests += 1;
        try {
          for (const game of await dependencies.roblox.searchGames(term)) {
            if (game.playerCount >= config.minimumDiscoveryCcu) candidates.push({ universeId: game.universeId, source: "search", detail: term });
          }
        } catch (error) {
          failures += 1;
          logger.warn("Search exploration failed", { term, error: errorMessage(error) });
        }
      }
      let promoted = 0;
      let promotionError: string | undefined;
      try {
        promoted = (await promoteUniverses(db, dependencies.roblox, candidates, now, { recordKnown: true })).promoted;
      } catch (error) {
        if (!(error instanceof PromotionApiError)) throw error; // database errors fail the run
        promotionError = errorMessage(error);
        logger.error("Exploration promotion failed; retrying next run", { error: promotionError });
      }
      return {
        status: (requests > 0 && failures === requests) || promotionError ? "degraded" : "success",
        stats: { seeds: seeds.length, terms, requests, failures, candidates: candidates.length, promoted, promotionError },
      };
    },
  };
}
```

Run: `npx vitest run src/lib/jobs/explore.test.ts`
Expected: PASS. In the first case "egg" appears in 3 titles and "steal" in 2; every other word appears once. In the second case every word is generic, a number, or appears only once.

**Step 4: Write the database test**

`src/lib/jobs/explore.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { discoverySources } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { gameDetail } from "@/test/fixtures";
import { createExploreJob } from "./explore";
import { executeJob } from "./runner";

describe.skipIf(!hasTestDatabase)("explore job", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:35:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Steal An Egg", created: new Date("2026-10-15T00:00:00Z") })], now);
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-10-19T12:00:00Z"), ccu: 100, visits: 1, favorites: 1 },
      { universeId: 1, observedAt: new Date("2026-10-20T13:00:00Z"), ccu: 5_000, visits: 2, favorites: 2 },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("explores recommendations of rising young games and records the seed", async () => {
    const job = createExploreJob({
      roblox: {
        getRecommendations: async () => [
          { universeId: 2, rootPlaceId: 20, name: "Break and Steal an Egg", playerCount: 3_000 },
          { universeId: 3, rootPlaceId: 30, name: "Tiny", playerCount: 5 },
        ],
        searchGames: async () => [],
        getGameDetails: async (ids) => ids.map((id) => gameDetail(Number(id))),
      },
    });
    expect(await executeJob(job, database.db, now)).toBe("success");
    expect(await database.db.select().from(discoverySources)).toEqual([
      expect.objectContaining({ universeId: 2, source: "recommendation", detail: "1" }),
    ]);
  });
});
```

**Step 5: Register, test, commit**

Add `createExploreJob({ roblox })` to the registry array (import from `./explore`).

```bash
npx vitest run src/lib/jobs/explore.test.ts src/lib/jobs/explore.db.test.ts && npm run typecheck
git add src/db/explore.ts src/lib/jobs
git commit -m "feat(jobs): add exploration collector seeded by rising young games"
git push && gh run watch --exit-status
```

---

### Task 13: The `thumbnails` job

**Files:**
- Modify: `src/db/schema.ts` (new `games.thumbnail_key` column), `src/lib/jobs/registry.ts`
- Generate: `drizzle/0003_thumbnail_key.sql`
- Create: `src/db/thumbnails.ts`, `src/lib/jobs/thumbnails.ts`, `src/lib/jobs/thumbnails.db.test.ts`

Roblox's thumbnail map (Task 5) has four cases per universe: a custom thumbnail `{ imageUrl, mediaId }`; `null` (no usable custom thumbnail: none uploaded, or blocked by moderation); `"pending"` (still processing or in review: retried next run, but an answer, not a failure); or no entry (error, malformed item or failed batch). Coverage counts every answer, so only source failures degrade a run, and a run where Roblox answered for no game at all fails. A thumbnail version is keyed on the media asset id, so a CDN URL change for the same image never records a fake A/B test. When Roblox answers `null`, the previous thumbnail URL and key are kept on purpose: a transient empty answer must not erase history or record a fake change.

**Step 1: Add the thumbnail key column and generate its migration**

In `src/db/schema.ts`, in `games`, add after `iconUrl`:

```ts
    // Identity of the current thumbnail: "media:<asset id>", or "url:<sha1>" when Roblox gives no asset id.
    thumbnailKey: text("thumbnail_key"),
```

Run: `npx drizzle-kit generate --name=thumbnail_key`
Expected: `drizzle/0003_thumbnail_key.sql` containing only `ALTER TABLE "games" ADD COLUMN "thumbnail_key" text;`. Never edit an existing migration.

**Step 2: Write the failing database test**

`src/lib/jobs/thumbnails.db.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { games, gameVersions } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import type { GameThumbnailAnswer } from "@/lib/api/roblox";
import { gameDetail } from "@/test/fixtures";
import { executeJob } from "./runner";
import { createThumbnailsJob } from "./thumbnails";

describe.skipIf(!hasTestDatabase)("thumbnails job", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1), gameDetail(2), gameDetail(3), gameDetail(4)], new Date("2026-10-20T13:00:00Z"));
  });

  afterAll(async () => {
    await database?.drop();
  });

  function job(thumbnails: Record<string, GameThumbnailAnswer>) {
    return createThumbnailsJob({
      roblox: {
        getGameThumbnails: async (ids) => new Map(ids.filter((id) => id in thumbnails).map((id) => [id, thumbnails[id]])),
        getThumbnails: async (ids) => new Map(ids.map((id) => [id, `https://tr.rbxcdn.com/icon-${id}`])),
      },
    });
  }

  async function game(universeId: number) {
    const [row] = await database.db.select().from(games).where(eq(games.universeId, universeId));
    return row;
  }

  async function thumbnailVersions(universeId: number) {
    return database.db.select().from(gameVersions).where(eq(gameVersions.universeId, universeId));
  }

  it("stores a custom thumbnail, marks a game without one as checked, and retries pending and unknown games", async () => {
    const status = await executeJob(
      job({ "1": { imageUrl: "https://tr.rbxcdn.com/a/Image", mediaId: 101 }, "2": null, "4": "pending" }),
      database.db,
      new Date("2026-10-20T14:45:00Z"),
    );
    expect(status).toBe("degraded"); // game 3 is unknown: 3 of 4 answered (pending counts as an answer)
    expect(await game(1)).toMatchObject({ thumbnailUrl: "https://tr.rbxcdn.com/a/Image", thumbnailKey: "media:101", iconUrl: "https://tr.rbxcdn.com/icon-1" });
    expect((await game(1)).thumbnailsCheckedAt).not.toBeNull();
    expect(await game(2)).toMatchObject({ thumbnailUrl: null, thumbnailKey: null });
    expect((await game(2)).thumbnailsCheckedAt).not.toBeNull();
    expect((await game(3)).thumbnailsCheckedAt).toBeNull();
    expect((await game(3)).iconUrl).toBe("https://tr.rbxcdn.com/icon-3");
    expect((await game(4)).thumbnailsCheckedAt).toBeNull();
    expect((await thumbnailVersions(1)).filter((version) => version.kind === "thumbnail")).toHaveLength(1);
  });

  it("keys versions on the media id: a new URL for the same image is not a new version", async () => {
    const status = await executeJob(
      job({ "1": { imageUrl: "https://tr.rbxcdn.com/b/Image", mediaId: 101 }, "2": null, "3": null, "4": "pending" }),
      database.db,
      new Date("2026-10-21T16:00:00Z"),
    );
    expect(status).toBe("success"); // every game answered, one of them pending
    expect((await game(1)).thumbnailUrl).toBe("https://tr.rbxcdn.com/b/Image");
    expect((await thumbnailVersions(1)).filter((version) => version.kind === "thumbnail")).toHaveLength(1);
  });

  it("records a version when the image changes", async () => {
    await executeJob(job({ "1": { imageUrl: "https://tr.rbxcdn.com/c/Image", mediaId: 202 } }), database.db, new Date("2026-10-22T17:00:00Z"));
    expect((await game(1)).thumbnailKey).toBe("media:202");
    expect((await thumbnailVersions(1)).filter((version) => version.kind === "thumbnail")).toHaveLength(2);
  });

  it("fails when Roblox answers for no game at all", async () => {
    expect(await executeJob(job({}), database.db, new Date("2026-10-23T18:00:00Z"))).toBe("failed");
  });
});
```

Game 1 has `last_ccu = 100` (fixture default), at least `refreshMinimumCcu`, and each later run is more than 24 hours after the previous check, so it is refreshed. Games 3 (unknown) and 4 (pending) stay unchecked after the first run and are retried; game 4 stays pending and keeps being retried without degrading runs. The last test runs when games 2, 3 and 4 are due again, and an empty answer for all of them fails the run.

**Step 3: Implement `src/db/thumbnails.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { GameThumbnail, GameThumbnailAnswer } from "@/lib/api/roblox";
import { urlFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions } from "./schema";

export interface ThumbnailTarget {
  universeId: number;
  thumbnailKey: string | null;
}

export function thumbnailKey(thumbnail: GameThumbnail): string {
  return thumbnail.mediaId !== null ? `media:${thumbnail.mediaId}` : `url:${urlFingerprint(thumbnail.imageUrl)}`;
}

export async function selectGamesNeedingThumbnails(
  db: Database,
  now: Date,
  options: { refreshHours: number; refreshMinimumCcu: number; limit: number },
): Promise<ThumbnailTarget[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; thumbnail_key: string | null }>(sql`
    select universe_id, thumbnail_key
    from games
    where thumbnails_checked_at is null
       or (thumbnails_checked_at < ${at}::timestamptz - make_interval(hours => ${options.refreshHours}::int)
           and last_ccu >= ${options.refreshMinimumCcu})
    order by thumbnails_checked_at nulls first, last_ccu desc
    limit ${options.limit}
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), thumbnailKey: row.thumbnail_key }));
}

// No entry (no answer) or "pending" (not ready yet): only the icon is updated, and the game stays due.
// null (no usable custom thumbnail): the game is marked checked and its previous thumbnail is kept on purpose.
export async function saveThumbnails(
  db: Database,
  targets: ThumbnailTarget[],
  thumbnails: Map<string, GameThumbnailAnswer>,
  icons: Map<string, string>,
  checkedAt: Date,
): Promise<{ changed: number }> {
  let changed = 0;
  // Universe-id order, like upsertGameDetails, so concurrent writers to games never deadlock.
  const ordered = [...targets].sort((a, b) => a.universeId - b.universeId);
  await db.transaction(async (transaction) => {
    for (const target of ordered) {
      const id = String(target.universeId);
      const iconUrl = icons.get(id);
      const iconUpdate = iconUrl ? { iconUrl } : {};
      const answer = thumbnails.get(id);
      if (answer === undefined || answer === "pending") {
        if (iconUrl) await transaction.update(games).set(iconUpdate).where(eq(games.universeId, target.universeId));
        continue;
      }
      const thumbnail = answer;
      if (!thumbnail) {
        await transaction.update(games).set({ ...iconUpdate, thumbnailsCheckedAt: checkedAt }).where(eq(games.universeId, target.universeId));
        continue;
      }
      const key = thumbnailKey(thumbnail);
      await transaction
        .update(games)
        .set({ ...iconUpdate, thumbnailUrl: thumbnail.imageUrl, thumbnailKey: key, thumbnailsCheckedAt: checkedAt })
        .where(eq(games.universeId, target.universeId));
      if (key !== target.thumbnailKey) {
        await transaction
          .insert(gameVersions)
          .values({ universeId: target.universeId, kind: "thumbnail", rawFingerprint: key, thumbnailUrl: thumbnail.imageUrl, observedAt: checkedAt })
          .onConflictDoNothing({
            target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
          });
        changed += 1;
      }
    }
  });
  return { changed };
}
```

**Step 4: Implement `src/lib/jobs/thumbnails.ts`**

```ts
import { saveThumbnails, selectGamesNeedingThumbnails } from "@/db/thumbnails";
import type { GameThumbnailAnswer, RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import type { JobDefinition } from "./runner";

export interface ThumbnailsDependencies {
  roblox: Pick<RobloxApi, "getGameThumbnails" | "getThumbnails">;
}

export function createThumbnailsJob(dependencies: ThumbnailsDependencies): JobDefinition {
  const config = JOB_CONFIG.thumbnails;
  return {
    name: "thumbnails",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const targets = await selectGamesNeedingThumbnails(db, now, {
        refreshHours: config.refreshHours,
        refreshMinimumCcu: config.refreshMinimumCcu,
        limit: config.maximumGamesPerRun,
      });
      const ids = targets.map((target) => String(target.universeId));
      const thumbnails = ids.length ? await dependencies.roblox.getGameThumbnails(ids) : new Map<string, GameThumbnailAnswer>();
      if (ids.length && thumbnails.size === 0) {
        throw new Error(`The thumbnail endpoint answered for none of ${ids.length} games`);
      }
      const icons = ids.length ? await dependencies.roblox.getThumbnails(ids) : new Map<string, string>();
      const { changed } = await saveThumbnails(db, targets, thumbnails, icons, now);
      const answers = [...thumbnails.values()];
      const pending = answers.filter((answer) => answer === "pending").length;
      const withoutThumbnail = answers.filter((answer) => answer === null).length;
      return {
        // Coverage counts every answer, including "no custom thumbnail" and "pending"; only source failures degrade.
        status: ids.length && thumbnails.size / ids.length < 0.9 ? "degraded" : "success",
        stats: {
          checked: targets.length,
          answered: thumbnails.size,
          withThumbnail: thumbnails.size - pending - withoutThumbnail,
          withoutThumbnail,
          pending,
          icons: icons.size,
          changed,
        },
      };
    },
  };
}
```

**Step 5: Register, test, commit**

Add `createThumbnailsJob({ roblox })` to the registry array (import from `./thumbnails`).

```bash
npx vitest run src/lib/jobs/thumbnails.db.test.ts && npm run typecheck
git add src/db/schema.ts drizzle src/db/thumbnails.ts src/lib/jobs
git commit -m "feat(jobs): add thumbnail and icon collector keyed on media ids"
git push && gh run watch --exit-status
```

---

### Task 14: `npm run collect`

**Files:**
- Create: `scripts/collect.ts`
- Modify: `package.json`

**Step 1: Create `scripts/collect.ts`**

```ts
import { closeDatabase, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { createJobs } from "@/lib/jobs/registry";
import { executeJob } from "@/lib/jobs/runner";
import type { JobName } from "@/lib/jobs/types";
import { logger } from "@/lib/logger";

// Runs every collector once, in dependency order. Production uses one systemd timer per job instead.
const ORDER: JobName[] = ["census", "poll", "votes", "charts", "explore", "thumbnails"];

const jobs = new Map(createJobs().map((job) => [job.name, job]));
const database = getDatabase("radar-collect");
await assertNotLegacyDatabase(database);
const outcomes: Record<string, string> = {};
for (const name of ORDER) {
  const job = jobs.get(name);
  if (!job) throw new Error(`Job ${name} is not registered`);
  outcomes[name] = await executeJob(job, database);
}
await closeDatabase();
logger.info("Collection pass completed", outcomes);
process.exit(Object.values(outcomes).includes("failed") ? 1 : 0);
```

Add to `package.json` scripts: `"collect": "tsx scripts/collect.ts",`

**Step 2: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Do not run `npm run collect` yet: it needs a v2 `DATABASE_URL`, which phase 1b provides.

```bash
git add scripts/collect.ts package.json
git commit -m "feat(jobs): add single-pass collect command"
```

---

### Task 15: Legacy history import

**Files:**
- Create: `src/lib/legacy/mapping.ts`, `src/lib/legacy/mapping.test.ts`, `src/lib/legacy/import.ts`, `src/lib/legacy/import.db.test.ts`, `scripts/import-legacy.ts`
- Modify: `package.json`

**Step 1: Write the failing mapping test**

`src/lib/legacy/mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { legacyDiscovery, sortIdFromLegacyChartLabel } from "./mapping";

describe("sortIdFromLegacyChartLabel", () => {
  it.each([
    ["Top Trending", "top-trending"],
    ["Up-and-Coming", "up-and-coming"],
    ["Trending in Sports & Racing", "trending-in-sports-and-racing"],
    ["Trending in Roleplay & Avatar Sim", "trending-in-roleplay-and-avatar-sim"],
    ["Trending in RPG", "trending-in-rpg"],
    ["Fun with Friends", "fun-with-friends"],
  ])("maps %s to %s", (label, sortId) => {
    expect(sortIdFromLegacyChartLabel(label)).toBe(sortId);
  });

  it("rejects labels that are not discovery charts", () => {
    expect(sortIdFromLegacyChartLabel("Direct tracking")).toBeNull();
    expect(sortIdFromLegacyChartLabel("Search: Defense")).toBeNull();
  });
});

describe("legacyDiscovery", () => {
  it("maps every v1 discovery source", () => {
    expect(legacyDiscovery("roblox-charts", "Top Earning")).toEqual({ source: "chart", detail: "top-earning" });
    expect(legacyDiscovery("roblox-search", "Search: Collection + Kitty")).toEqual({ source: "search", detail: "Collection + Kitty" });
    expect(legacyDiscovery("roblox-recommendations", "Recommendations from 10765298801")).toEqual({ source: "recommendation", detail: "10765298801" });
    expect(legacyDiscovery("rolimons", "Rolimon's discovery")).toEqual({ source: "rolimons", detail: "" });
  });

  it("ignores direct tracking and unknown sources", () => {
    expect(legacyDiscovery("roblox-tracked", "Direct tracking")).toBeNull();
    expect(legacyDiscovery("other", "x")).toBeNull();
  });
});
```

**Step 2: Implement `src/lib/legacy/mapping.ts`**

```ts
import { ROBLOX_DISCOVERY_CHARTS, type RobloxDiscoveryChart } from "@/lib/config";
import type { DiscoverySource } from "@/lib/jobs/types";

const DISCOVERY_CHARTS: ReadonlySet<string> = new Set(ROBLOX_DISCOVERY_CHARTS);

export function sortIdFromLegacyChartLabel(label: string): RobloxDiscoveryChart | null {
  const slug = label
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return DISCOVERY_CHARTS.has(slug) ? (slug as RobloxDiscoveryChart) : null;
}

export function legacyDiscovery(source: string, chart: string): { source: DiscoverySource; detail: string } | null {
  if (source === "roblox-charts") {
    const sortId = sortIdFromLegacyChartLabel(chart);
    return sortId ? { source: "chart", detail: sortId } : null;
  }
  if (source === "roblox-search") return chart.startsWith("Search: ") ? { source: "search", detail: chart.slice("Search: ".length) } : null;
  if (source === "roblox-recommendations") {
    const match = /^Recommendations from (\d+)$/.exec(chart);
    return match ? { source: "recommendation", detail: match[1] } : null;
  }
  if (source === "rolimons") return { source: "rolimons", detail: "" };
  return null;
}
```

Run: `npx vitest run src/lib/legacy/mapping.test.ts`
Expected: PASS (10 tests).

**Step 3: Implement `src/lib/legacy/import.ts`**

The importer reads v1 tables with raw SQL and never writes to the source. Writes use `keep` mode or `do nothing`, so collected v2 data always wins and reruns are idempotent.

```ts
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { Database } from "@/db/client";
import { recordDiscoveries, type DiscoveryRecord } from "@/db/discovery";
import { knownUniverseIds } from "@/db/games";
import { writeChartPlacements, writeGameObservations, writeVoteObservations } from "@/db/observations";
import { gameDailyLegacy, games, gameVersions, places } from "@/db/schema";
import { chunk } from "@/lib/arrays";
import { contentFingerprint, rawFingerprint } from "@/lib/fingerprint";
import { logger } from "@/lib/logger";
import { legacyDiscovery, sortIdFromLegacyChartLabel } from "./mapping";

const HOUR = 60 * 60 * 1000;

export interface LegacyImportOptions {
  since?: Date;
  windowHours?: number;
  now?: Date;
}

export interface LegacyImportStats {
  games: number;
  versions: number;
  observations: number;
  votes: number;
  placements: number;
  discoveries: number;
  dailyRows: number;
  from: string | null;
  to: string | null;
}

export async function importLegacyHistory(target: Database, source: Pool, options: LegacyImportOptions = {}): Promise<LegacyImportStats> {
  const stats: LegacyImportStats = { games: 0, versions: 0, observations: 0, votes: 0, placements: 0, discoveries: 0, dailyRows: 0, from: null, to: null };
  stats.games = await importGames(target, source);
  const imported = await knownUniverseIds(target, await legacyUniverseIds(source));
  stats.versions = await importVersions(target, source, imported);
  stats.dailyRows = await importDaily(target, source, imported);
  stats.discoveries = await importDiscoveries(target, source, imported);

  const retentionStart = await rawRetentionStart(target, options.now ?? new Date());
  // During the parallel run both v1 and v2 collect charts hourly; a chart slot is a ranking, so v1 placements are
  // imported only for slots before v2's first charts run, never mixed into a slot v2 collected.
  const chartCutoff = await firstCollectedChartSlot(target);
  const range = await source.query<{ first: Date | null; last: Date | null }>(
    "select min(bucket_at) as first, max(bucket_at) as last from snapshots where bucket_at >= $1",
    [options.since ?? new Date(0)],
  );
  const first = range.rows[0]?.first;
  const last = range.rows[0]?.last;
  if (first && last) {
    stats.from = first.toISOString();
    stats.to = last.toISOString();
    const windowMs = (options.windowHours ?? 24) * HOUR;
    for (let start = first.getTime(); start <= last.getTime(); start += windowMs) {
      const window = { from: new Date(start), to: new Date(start + windowMs) };
      // Only game_observations has retention (and feeds the aggregates); votes and placements are permanent.
      if (window.to > retentionStart) {
        const from = window.from > retentionStart ? window.from : retentionStart;
        stats.observations += await importObservations(target, source, { from, to: window.to });
      }
      stats.votes += await importVotes(target, source, window);
      stats.placements += await importPlacements(target, source, window, chartCutoff);
      logger.info("Legacy window imported", { from: window.from.toISOString() });
    }
    if (last >= retentionStart) await refreshAggregates(target, first > retentionStart ? first : retentionStart, last);
  }
  await backfillLastCcu(target);
  return stats;
}

async function firstCollectedChartSlot(target: Database): Promise<Date | null> {
  const result = await target.execute<{ slot: string | null }>(
    // Any run, failed ones included: charts store each sort as soon as it is read, so a failed run can hold placements.
    sql`select min(slot) as slot from job_runs where job = 'charts'`,
  );
  const slot = result.rows[0]?.slot;
  return slot ? new Date(slot) : null;
}

// Raw rows older than the retention window are dropped by TimescaleDB. Importing them again would let a
// later refresh recompute those aggregate buckets from legacy rows only, overwriting collected history.
async function rawRetentionStart(target: Database, now: Date): Promise<Date> {
  const policy = await target.execute<{ drop_after: string | null }>(sql`
    select config->>'drop_after' as drop_after from timescaledb_information.jobs
    where proc_name = 'policy_retention' and hypertable_name = 'game_observations'
  `);
  const dropAfter = policy.rows[0]?.drop_after;
  if (!dropAfter) return new Date(0);
  const result = await target.execute<{ start: string }>(
    sql`select (${now.toISOString()}::timestamptz - ${dropAfter}::interval + interval '1 day') as start`,
  );
  return new Date(result.rows[0].start);
}

async function legacyUniverseIds(source: Pool): Promise<number[]> {
  const result = await source.query<{ universe_id: string }>("select universe_id from games");
  return result.rows.map((row) => Number(row.universe_id)).filter(Number.isSafeInteger);
}

async function importGames(target: Database, source: Pool): Promise<number> {
  const result = await source.query<{
    universe_id: string; root_place_id: string; name: string; description: string; creator_id: string;
    creator_name: string; creator_type: string; genre: string | null; created_at: Date; updated_at: Date;
    first_seen_at: Date; last_seen_at: Date; thumbnail_url: string | null;
  }>(
    // Universe-id order, like every other writer to games, so the import cannot deadlock with poll.
    "select universe_id, root_place_id, name, description, creator_id, creator_name, creator_type, genre, created_at, updated_at, first_seen_at, last_seen_at, thumbnail_url from games order by universe_id::bigint",
  );
  const rows = result.rows
    .filter((row) => [row.universe_id, row.root_place_id, row.creator_id].every((value) => Number.isSafeInteger(Number(value))))
    .map((row) => ({
      universeId: Number(row.universe_id),
      rootPlaceId: Number(row.root_place_id),
      name: row.name,
      description: row.description,
      creatorId: Number(row.creator_id),
      creatorName: row.creator_name,
      creatorType: row.creator_type,
      genre: row.genre,
      robloxCreatedAt: row.created_at,
      robloxUpdatedAt: row.updated_at,
      firstObservedAt: row.first_seen_at,
      lastObservedAt: row.last_seen_at,
      metadataFingerprint: rawFingerprint(row.name, row.description),
      contentFingerprint: contentFingerprint(row.name, row.description),
      iconUrl: row.thumbnail_url,
    }));
  for (const part of chunk(rows, 500)) {
    await target
      .insert(games)
      .values(part)
      .onConflictDoUpdate({
        target: games.universeId,
        set: {
          firstObservedAt: sql`least(${games.firstObservedAt}, excluded.first_observed_at)`,
          lastObservedAt: sql`greatest(${games.lastObservedAt}, excluded.last_observed_at)`,
        },
      });
    await target
      .insert(places)
      .values(part.map((row) => ({ placeId: row.rootPlaceId, universeId: row.universeId, resolvedAt: row.firstObservedAt, error: null })))
      .onConflictDoNothing();
  }
  return rows.length;
}

async function importVersions(target: Database, source: Pool, imported: Set<number>): Promise<number> {
  const result = await source.query<{ universe_id: string; name: string; description: string; game_updated_at: Date; observed_at: Date }>(
    "select universe_id, name, description, game_updated_at, observed_at from game_metadata_history order by observed_at",
  );
  const rows = result.rows
    .filter((row) => imported.has(Number(row.universe_id)))
    .map((row) => ({
      universeId: Number(row.universe_id),
      kind: "metadata" as const,
      rawFingerprint: rawFingerprint(row.name, row.description),
      contentFingerprint: contentFingerprint(row.name, row.description),
      name: row.name,
      description: row.description,
      robloxUpdatedAt: row.game_updated_at,
      observedAt: row.observed_at,
    }));
  for (const part of chunk(rows, 1_000)) {
    await target.insert(gameVersions).values(part).onConflictDoNothing({
      target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
    });
  }
  return rows.length;
}

async function importDaily(target: Database, source: Pool, imported: Set<number>): Promise<number> {
  const result = await source.query<{ universe_id: string; day: Date; average_ccu: number; peak_ccu: number; visits: number; favorites: number }>(
    "select universe_id, date_trunc('day', day_at at time zone 'UTC') at time zone 'UTC' as day, average_ccu, peak_ccu, visits, favorites from daily_snapshots",
  );
  const rows = result.rows
    .filter((row) => imported.has(Number(row.universe_id)))
    .map((row) => ({
      universeId: Number(row.universe_id),
      day: row.day,
      ccuAvg: row.average_ccu,
      ccuPeak: row.peak_ccu,
      visits: Math.round(row.visits),
      favorites: row.favorites,
    }));
  for (const part of chunk(rows, 2_000)) await target.insert(gameDailyLegacy).values(part).onConflictDoNothing();
  return rows.length;
}

async function importDiscoveries(target: Database, source: Pool, imported: Set<number>): Promise<number> {
  const result = await source.query<{ universe_id: string; source: string; chart: string; first_seen: Date; last_seen: Date }>(
    "select universe_id, source, chart, min(collected_at) as first_seen, max(collected_at) as last_seen from snapshots where source <> 'roblox-tracked' group by 1, 2, 3",
  );
  const records: DiscoveryRecord[] = [];
  for (const row of result.rows) {
    const mapped = legacyDiscovery(row.source, row.chart);
    if (!mapped || !imported.has(Number(row.universe_id))) continue;
    records.push({ universeId: Number(row.universe_id), ...mapped, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen });
  }
  return recordDiscoveries(target, records);
}

interface TimeWindow {
  from: Date;
  to: Date;
}

async function importObservations(target: Database, source: Pool, window: TimeWindow): Promise<number> {
  const result = await source.query<{ universe_id: string; bucket_at: Date; ccu: number; visits: number; favorites: number }>(
    `select universe_id, bucket_at, max(ccu) as ccu, max(visits) as visits, max(favorites) as favorites
     from snapshots where bucket_at >= $1 and bucket_at < $2 group by 1, 2`,
    [window.from, window.to],
  );
  return writeGameObservations(
    target,
    result.rows
      .filter((row) => Number.isSafeInteger(Number(row.universe_id)))
      .map((row) => ({
        universeId: Number(row.universe_id),
        observedAt: row.bucket_at,
        ccu: row.ccu,
        visits: Math.round(row.visits),
        favorites: row.favorites,
        source: "legacy" as const,
      })),
    "keep",
  );
}

async function importVotes(target: Database, source: Pool, window: TimeWindow): Promise<number> {
  const result = await source.query<{ universe_id: string; bucket_at: Date; up_votes: number; down_votes: number }>(
    `select universe_id, bucket_at, max(up_votes) as up_votes, max(down_votes) as down_votes
     from snapshots where bucket_at >= $1 and bucket_at < $2 and up_votes is not null and down_votes is not null group by 1, 2`,
    [window.from, window.to],
  );
  return writeVoteObservations(
    target,
    result.rows
      .filter((row) => Number.isSafeInteger(Number(row.universe_id)))
      .map((row) => ({ universeId: Number(row.universe_id), observedAt: row.bucket_at, upVotes: row.up_votes, downVotes: row.down_votes })),
    "keep",
  );
}

async function importPlacements(target: Database, source: Pool, window: TimeWindow, cutoff: Date | null): Promise<number> {
  const to = cutoff && cutoff < window.to ? cutoff : window.to;
  if (to <= window.from) return 0;
  const result = await source.query<{ chart: string; universe_id: string; bucket_at: Date; rank: number; ccu: number; is_sponsored: boolean | null }>(
    `select chart, universe_id, bucket_at, min(rank) as rank, max(ccu) as ccu, bool_or(is_sponsored) as is_sponsored
     from snapshots where source = 'roblox-charts' and rank is not null and bucket_at >= $1 and bucket_at < $2 group by 1, 2, 3`,
    [window.from, to],
  );
  const rows = result.rows.flatMap((row) => {
    const sortId = sortIdFromLegacyChartLabel(row.chart);
    if (!sortId || !Number.isSafeInteger(Number(row.universe_id))) return [];
    return [{ sortId, universeId: Number(row.universe_id), observedAt: row.bucket_at, rank: row.rank, playerCount: row.ccu, isSponsored: row.is_sponsored }];
  });
  return writeChartPlacements(target, rows, "keep");
}

// refresh_continuous_aggregate refuses to run in a transaction block. A parameterless statement
// goes through the simple query protocol on its own; the literals are ISO strings built here.
async function refreshAggregates(target: Database, first: Date, last: Date): Promise<void> {
  const from = new Date(Math.floor(first.getTime() / (24 * HOUR)) * 24 * HOUR).toISOString();
  const to = new Date(Math.ceil((last.getTime() + HOUR) / (24 * HOUR)) * 24 * HOUR).toISOString();
  for (const view of ["game_hourly", "game_daily"]) {
    await target.execute(sql.raw(`CALL refresh_continuous_aggregate('${view}', '${from}'::timestamptz, '${to}'::timestamptz)`));
  }
}

async function backfillLastCcu(target: Database): Promise<void> {
  await target.execute(sql`
    update games g
    set last_ccu = latest.ccu, last_ccu_at = latest.observed_at
    from (
      select distinct on (universe_id) universe_id, ccu, observed_at
      from game_observations
      order by universe_id, observed_at desc
    ) latest
    where latest.universe_id = g.universe_id and g.last_ccu_at is null
  `);
  // The young-game rule needs the last time a game had players, not only its latest reading.
  await target.execute(sql`
    update games g
    set last_active_at = active.observed_at
    from (
      select universe_id, max(observed_at) as observed_at
      from game_observations
      where ccu > 0
      group by universe_id
    ) active
    where active.universe_id = g.universe_id
      and (g.last_active_at is null or g.last_active_at < active.observed_at)
  `);
}
```

**Step 4: Write the database test**

`src/lib/legacy/import.db.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartPlacements, discoverySources, gameObservations, games, gameVersions, jobRuns, voteObservations } from "@/db/schema";
import { writeGameObservations } from "@/db/observations";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { importLegacyHistory } from "./import";

// Minimal copy of the v1 tables the importer reads, created in a disposable test database.
const LEGACY_SCHEMA = `
  create table games (universe_id text primary key, root_place_id text not null, name text not null, description text not null default '',
    creator_id text not null, creator_name text not null, creator_type text not null, created_at timestamptz not null, updated_at timestamptz not null,
    first_seen_at timestamptz not null, last_seen_at timestamptz not null, thumbnail_url text, genre text);
  create table game_metadata_history (id integer generated always as identity primary key, universe_id text not null, fingerprint text not null,
    name text not null, normalized_title text not null, description text not null, game_updated_at timestamptz not null, observed_at timestamptz not null);
  create table snapshots (id integer generated always as identity primary key, universe_id text not null, collected_at timestamptz not null,
    bucket_at timestamptz not null, ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer,
    is_sponsored boolean, chart text not null, rank integer, source text not null);
  create table daily_snapshots (id integer generated always as identity primary key, universe_id text not null, day_at timestamptz not null,
    average_ccu integer not null, peak_ccu integer not null, visits real not null, favorites integer not null, up_votes integer, down_votes integer, best_rank integer);
`;

const LEGACY_ROWS = `
  insert into games values ('10765298801', '115530770000806', '+1 Stone Skipping', 'Skip stones', '1', 'Meow Labs', 'Group',
    '2026-09-04T22:00:00Z', '2026-10-01T00:00:00Z', '2026-09-28T22:00:00Z', '2026-10-01T10:00:00Z', 'https://tr.rbxcdn.com/icon', 'Simulation');
  insert into game_metadata_history (universe_id, fingerprint, name, normalized_title, description, game_updated_at, observed_at)
    values ('10765298801', 'v1', '+1 Stone Skipping', '+1 Stone Skipping', 'Skip stones', '2026-10-01T00:00:00Z', '2026-09-29T15:09:16Z');
  insert into snapshots (universe_id, collected_at, bucket_at, ccu, visits, favorites, up_votes, down_votes, is_sponsored, chart, rank, source) values
    ('10765298801', '2026-09-29T20:02:00Z', '2026-09-29T20:00:00Z', 13000, 5000000, 9000, 900, 100, false, 'Top Trending', 4, 'roblox-charts'),
    ('10765298801', '2026-09-29T20:03:00Z', '2026-09-29T20:00:00Z', 13473, 5000100, 9001, 900, 100, null, 'Direct tracking', null, 'roblox-tracked'),
    ('10765298801', '2026-09-29T20:04:00Z', '2026-09-29T20:00:00Z', 13100, 5000050, 9000, null, null, false, 'Search: Stone', 2, 'roblox-search');
  insert into daily_snapshots (universe_id, day_at, average_ccu, peak_ccu, visits, favorites)
    values ('10765298801', '2026-09-01T00:00:00Z', 800, 1200, 100000, 100);
`;

// Fixed clock: the import skips raw rows older than the retention window, so the real date would age the fixtures out.
const FIXTURE_NOW = new Date("2026-10-21T00:00:00Z");

describe.skipIf(!hasTestDatabase)("importLegacyHistory", () => {
  let target: TestDatabase;
  let legacy: TestDatabase;
  let legacyPool: Pool;

  beforeAll(async () => {
    target = await createTestDatabase();
    legacy = await createTestDatabase({ migrate: false });
    legacyPool = new Pool({ connectionString: legacy.url, max: 2 });
    await legacyPool.query(LEGACY_SCHEMA);
    await legacyPool.query(LEGACY_ROWS);
  });

  afterAll(async () => {
    await legacyPool?.end();
    await legacy?.drop();
    await target?.drop();
  });

  it("imports games, versions, deduplicated observations, placements, votes, discoveries and daily rows", async () => {
    const stats = await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(stats).toMatchObject({ games: 1, versions: 1, observations: 1, votes: 1, placements: 1, dailyRows: 1 });

    const [game] = await target.db.select().from(games);
    expect(game.universeId).toBe(10765298801);
    expect(game.iconUrl).toBe("https://tr.rbxcdn.com/icon");
    expect(game.lastCcu).toBe(13473);
    expect(game.lastActiveAt?.toISOString()).toBe("2026-09-29T20:00:00.000Z");

    const [observation] = await target.db.select().from(gameObservations);
    expect(observation).toMatchObject({ ccu: 13473, visits: 5000100, source: "legacy" });
    expect(await target.db.select().from(voteObservations)).toHaveLength(1);
    expect(await target.db.select().from(chartPlacements)).toEqual([expect.objectContaining({ sortId: "top-trending", rank: 4 })]);
    expect((await target.db.select().from(discoverySources)).map((row) => [row.source, row.detail]).sort()).toEqual([
      ["chart", "top-trending"],
      ["search", "Stone"],
    ]);
    expect(await target.db.select().from(gameVersions).where(eq(gameVersions.universeId, 10765298801))).toHaveLength(1);

    const daily = await target.db.execute<{ origin: string }>(sql`select origin from game_daily_all order by day`);
    expect(daily.rows.map((row) => row.origin)).toEqual(["legacy", "observed"]);
  });

  it("is idempotent", async () => {
    await importLegacyHistory(target.db, legacyPool, { now: FIXTURE_NOW });
    expect(await target.db.select().from(gameObservations)).toHaveLength(1);
    expect(await target.db.select().from(games)).toHaveLength(1);
  });

  it("imports no v1 chart placement into a slot v2 already collected", async () => {
    const collected = await createTestDatabase();
    try {
      await collected.db.insert(jobRuns).values({
        id: "00000000-0000-4000-8000-000000000001",
        job: "charts",
        slot: new Date("2026-09-29T20:00:00Z"),
        status: "success",
        startedAt: new Date("2026-09-29T20:02:00Z"),
        stats: {},
      });
      const stats = await importLegacyHistory(collected.db, legacyPool, { now: FIXTURE_NOW });
      expect(stats.placements).toBe(0);
      expect(stats.observations).toBe(1);
    } finally {
      await collected.drop();
    }
  });

  it("never overwrites data collected by v2", async () => {
    const collected = await createTestDatabase();
    try {
      await writeGameObservations(collected.db, [
        { universeId: 10765298801, observedAt: new Date("2026-09-29T20:00:00Z"), ccu: 99_999, visits: 1, favorites: 1 },
      ]);
      await importLegacyHistory(collected.db, legacyPool, { now: FIXTURE_NOW });
      const [row] = await collected.db.select().from(gameObservations);
      expect(row).toMatchObject({ ccu: 99_999, source: "poll" });
    } finally {
      await collected.drop();
    }
  });

  it("skips raw observations older than the retention window but keeps permanent tables", async () => {
    const late = await createTestDatabase();
    try {
      const stats = await importLegacyHistory(late.db, legacyPool, { now: new Date("2027-12-01T00:00:00Z") });
      expect(stats).toMatchObject({ games: 1, observations: 0, votes: 1, placements: 1, dailyRows: 1 });
      expect(await late.db.select().from(gameObservations)).toHaveLength(0);
    } finally {
      await late.drop();
    }
  });
});
```

**Step 5: Create `scripts/import-legacy.ts`**

```ts
import { Pool } from "pg";
import { closeDatabase, getDatabase } from "@/db/client";
import { normalizePostgresConnectionUrl } from "@/db/connection-url";
import { importLegacyHistory } from "@/lib/legacy/import";
import { errorMessage, logger } from "@/lib/logger";

const legacyUrl = process.env.LEGACY_DATABASE_URL?.trim();
if (!legacyUrl) {
  logger.error("LEGACY_DATABASE_URL is required");
  process.exit(2);
}
const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="))?.slice("--since=".length);
const since = sinceArgument ? new Date(sinceArgument) : undefined;
if (since && Number.isNaN(since.getTime())) {
  logger.error("Invalid --since date", { since: sinceArgument });
  process.exit(2);
}

const source = new Pool({ connectionString: normalizePostgresConnectionUrl(legacyUrl), max: 2 });
try {
  const stats = await importLegacyHistory(getDatabase(), source, { since });
  logger.info("Legacy import completed", { ...stats });
} catch (error) {
  logger.error("Legacy import failed", { error: errorMessage(error) });
  process.exitCode = 1;
} finally {
  await source.end();
  await closeDatabase();
}
```

Add to `package.json` scripts: `"import:legacy": "tsx scripts/import-legacy.ts",`

**Step 6: Run tests, commit, confirm in CI**

```bash
npx vitest run src/lib/legacy && npm run typecheck
git add src/lib/legacy scripts/import-legacy.ts package.json
git commit -m "feat(legacy): import v1 history into the v2 schema"
git push && gh run watch --exit-status
```

---

### Task 16: `npm run status`

**Files:**
- Create: `src/db/status.ts`, `src/db/status.db.test.ts`, `scripts/status.ts`
- Modify: `package.json`

**Step 1: Write the failing database test**

`src/db/status.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations } from "./observations";
import { censusCoverage } from "./status";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("censusCoverage", () => {
  let database: TestDatabase;
  const now = new Date("2026-10-20T14:12:00Z");
  const slot = new Date("2026-10-20T14:10:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1), gameDetail(2)], now);
    await writeCensusObservations(database.db, [
      { placeId: 1_000_001, observedAt: slot, ccu: 500 },
      { placeId: 1_000_002, observedAt: slot, ccu: 300 },
      { placeId: 9_999, observedAt: slot, ccu: 200 },
      { placeId: 8_888, observedAt: slot, ccu: 20 },
    ]);
    await writeGameObservations(database.db, [{ universeId: 1, observedAt: new Date("2026-10-20T14:05:00Z"), ccu: 500, visits: 1, favorites: 1 }]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("counts listed places above the threshold and those polled recently", async () => {
    expect(await censusCoverage(database.db, now, 100, 15)).toEqual({ slot, listed: 3, tracked: 1 });
  });
});
```

**Step 2: Implement `src/db/status.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface JobSummary {
  job: string;
  lastStatus: string;
  lastStartedAt: Date;
  lastCompletedAt: Date | null;
  runs24h: number;
  degraded24h: number;
  failed24h: number;
}

export async function jobSummaries(db: Database, now: Date): Promise<JobSummary[]> {
  const at = now.toISOString();
  const result = await db.execute<{
    job: string; last_status: string; last_started_at: Date; last_completed_at: Date | null;
    runs_24h: number; degraded_24h: number; failed_24h: number;
  }>(sql`
    select job,
      (array_agg(status order by started_at desc))[1] as last_status,
      max(started_at) as last_started_at,
      max(started_at) filter (where status in ('success', 'degraded')) as last_completed_at,
      (count(*) filter (where started_at > ${at}::timestamptz - interval '24 hours'))::int as runs_24h,
      (count(*) filter (where started_at > ${at}::timestamptz - interval '24 hours' and status = 'degraded'))::int as degraded_24h,
      (count(*) filter (where started_at > ${at}::timestamptz - interval '24 hours' and status = 'failed'))::int as failed_24h
    from job_runs
    group by job
    order by job
  `);
  return result.rows.map((row) => ({
    job: row.job,
    lastStatus: row.last_status,
    lastStartedAt: new Date(row.last_started_at),
    lastCompletedAt: row.last_completed_at ? new Date(row.last_completed_at) : null,
    runs24h: row.runs_24h,
    degraded24h: row.degraded_24h,
    failed24h: row.failed_24h,
  }));
}

// Share of Rolimon's places above the threshold whose universe was polled recently.
export async function censusCoverage(
  db: Database,
  now: Date,
  minimumCcu: number,
  trackedWithinMinutes: number,
): Promise<{ slot: Date | null; listed: number; tracked: number }> {
  const at = now.toISOString();
  const result = await db.execute<{ slot: Date | null; listed: number; tracked: number }>(sql`
    with latest as (select max(observed_at) as slot from census_observations),
    listed as (
      select c.place_id from census_observations c join latest l on c.observed_at = l.slot where c.ccu >= ${minimumCcu}
    ),
    tracked as (
      select distinct l.place_id
      from listed l
      join places p on p.place_id = l.place_id
      join game_observations o on o.universe_id = p.universe_id
        and o.observed_at > ${at}::timestamptz - make_interval(mins => ${trackedWithinMinutes}::int)
    )
    select (select slot from latest) as slot,
      (select count(*) from listed)::int as listed,
      (select count(*) from tracked)::int as tracked
  `);
  const row = result.rows[0];
  return { slot: row?.slot ? new Date(row.slot) : null, listed: row?.listed ?? 0, tracked: row?.tracked ?? 0 };
}

export async function dataTotals(db: Database, now: Date): Promise<{ games: number; observations24h: number; censusRows24h: number }> {
  const at = now.toISOString();
  const result = await db.execute<{ games: number; observations_24h: number; census_rows_24h: number }>(sql`
    select (select count(*) from games)::int as games,
      (select count(*) from game_observations where observed_at > ${at}::timestamptz - interval '24 hours')::int as observations_24h,
      (select count(*) from census_observations where observed_at > ${at}::timestamptz - interval '24 hours')::int as census_rows_24h
  `);
  const row = result.rows[0];
  return { games: row?.games ?? 0, observations24h: row?.observations_24h ?? 0, censusRows24h: row?.census_rows_24h ?? 0 };
}
```

**Step 3: Create `scripts/status.ts`**

```ts
import { closeDatabase, getDatabase } from "@/db/client";
import { censusCoverage, dataTotals, jobSummaries } from "@/db/status";
import { STATUS_CONFIG } from "@/lib/config";

const database = getDatabase();
const now = new Date();
try {
  const jobs = await jobSummaries(database, now);
  console.table(
    jobs.map((job) => ({
      job: job.job,
      last: job.lastStatus,
      lastCompletedMinutesAgo: job.lastCompletedAt ? Math.round((now.getTime() - job.lastCompletedAt.getTime()) / 60_000) : null,
      runs24h: job.runs24h,
      degraded24h: job.degraded24h,
      failed24h: job.failed24h,
    })),
  );
  const coverage = await censusCoverage(database, now, STATUS_CONFIG.coverageMinimumCcu, STATUS_CONFIG.trackedWithinMinutes);
  const share = coverage.listed ? Math.round((coverage.tracked / coverage.listed) * 1_000) / 10 : 0;
  console.log(
    `Coverage: ${coverage.tracked}/${coverage.listed} Rolimon's places at or above ${STATUS_CONFIG.coverageMinimumCcu} CCU polled in the last ${STATUS_CONFIG.trackedWithinMinutes} min (${share}%)`,
  );
  console.table([await dataTotals(database, now)]);
} finally {
  await closeDatabase();
}
```

Add to `package.json` scripts: `"status": "tsx scripts/status.ts",`

**Step 4: Run tests, commit, confirm in CI**

```bash
npx vitest run src/db/status.db.test.ts && npm run typecheck
git add src/db/status.ts src/db/status.db.test.ts scripts/status.ts package.json
git commit -m "feat(ops): add collection status command"
git push && gh run watch --exit-status
```

---

### Task 17: Documentation and final validation

**Files:**
- Rewrite: `README.md`, `.env.example`
- Modify: `AGENTS.md`

**Step 1: Rewrite `.env.example`**

```bash
# v2 PostgreSQL 18 + TimescaleDB database (required).
DATABASE_URL=

# Disposable PostgreSQL + TimescaleDB server for *.db.test.ts suites. Set it in .env.test.local:
# Vitest runs with NODE_ENV=test, and @next/env does not read .env.local in that mode. CI provides one.
TEST_DATABASE_URL=

# v1 Aiven database, read only by `npm run import:legacy`.
LEGACY_DATABASE_URL=

# Healthchecks.io ping base, for example https://hc-ping.com/<ping-key>. Checks are auto-created by slug.
HEALTHCHECKS_PING_BASE=

# Set to 1 in production units: jobs then refuse to run without HEALTHCHECKS_PING_BASE.
RADAR_REQUIRE_HEALTHCHECKS=

# Roblox Charts filters.
ROBLOX_COUNTRY=all
ROBLOX_DEVICE=computer
```

**Step 2: Update `AGENTS.md`**

Replace the first section, up to but not including `# This is NOT the Next.js you know`, with:

```markdown
# Repository guidance

- Write all source code, identifiers, comments, tests, documentation, configuration, logs, and UI copy in English.
- Communicate with the repository owner in French.
- Keep the product as one Next.js application backed by one PostgreSQL 18 database with TimescaleDB.
- Put reusable domain logic in `src/lib`, persistence in `src/db`, pages in `src/app`, and scheduled entry points in `scripts`.
- Keep collection intervals, thresholds and limits centralized in `src/lib/config.ts`; avoid hidden constants in jobs or UI code.
- Preserve collection idempotency (observations are keyed by slot) and isolate external-source failures.
- Use `npm run db:migrate` and `npm run collect` for local setup with live data; `npm run status` reports collection health.
- Never insert synthetic or demo games into the application database. Test fixtures belong only in disposable test databases.
- Before handing off changes, run `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.
```

Leave the generated Next.js block that follows unchanged.

**Step 3: Rewrite `README.md`**

Write a README covering, in this order:
1. The one-paragraph purpose from the design document's "Why a v2".
2. Architecture: the jobs table from design section 3, the tables from section 2, and a link to `docs/plans/2026-10-20-radar-v2-design.md`.
3. Local setup: PostgreSQL 18 + TimescaleDB (Task 0 commands), `cp .env.example .env.local`, `npm install`, `npm run db:migrate`, `npm run collect`, `npm run status`.
4. Commands: `job <name>`, `collect`, `import:legacy [--since=ISO]`, `status`, `db:generate`, `db:migrate`, `validate`.
5. Tests: unit tests run anywhere; `*.db.test.ts` need `TEST_DATABASE_URL`, and CI runs them against `timescale/timescaledb:2.30.2-pg18`.
6. Verified external API behavior: keep the bullet list from the v1 README (charts, games, votes, recommendations, search, Rolimon's, place-to-universe), and add the multiget thumbnails endpoint, verified on 2026-10-20.
7. Production: "Phase 1b provisions the server (systemd timers, backups, deployment)."

**Step 4: Final validation**

Run: `npm run validate`
Expected: lint, typecheck, test and build pass (database suites skipped locally without `TEST_DATABASE_URL`).

**Step 5: Commit, push, confirm CI**

```bash
git add README.md .env.example AGENTS.md
git commit -m "docs: document the v2 data core"
git push && gh run watch --exit-status
```

Expected: CI green with every database suite executed.

---

## Execution notes (changes made after Task 1 review)

- CI runs Node 24 LTS (bundles npm 11, like the developer machine); `package.json` declares `engines.npm >= 11` so an npm 10 install warns. npm 10 and npm 11 disagree on optional nested lockfile entries.
- `.gitignore` ignores `.env*.local`; local database tests read `TEST_DATABASE_URL` from `.env.test.local`.
- `normalizeTitle` strips bracketed markers only on whole words, and leading markers only when followed by punctuation or written in capitals, so real titles such as "New York Roleplay" or "[Alphabet Lore] Morphs" keep their words.
- CI health check uses TCP (`pg_isready -h 127.0.0.1`), and the job has a 15-minute timeout, read-only permissions and a concurrency group.
- Before phase 2 classifies from `contentFingerprint`, finish `normalizeTitle`: let `update`/`upd` swallow a version token (`UPDATE 2!`, `UPD 2.5`), handle trailing markers after `|` or ` - `, repeat the leading rule up to three times, and fall back to the emoji-free title when markers leave it empty.
- If phase 1b adds deployment to CI, the concurrency group must not cancel runs on the deploy branch.
- After Task 2 review: fingerprints use `toLowerCase()` (never locale-dependent casing) and tests pin their exact values. Metadata versions compare against `games.metadata_fingerprint` through PostgreSQL 18 `RETURNING old.*`, so reverts are recorded; the `game_versions` unique key includes `observed_at` to keep retries and imports idempotent.
- After Task 3 review: raw retention is 365 days; aggregates keep min/avg/max CCU and visits as a maximum; `game_hourly` and `census_hourly` compress after 30 days; `chart_placements` is segmented by game. Test databases are created from `template0` (so `CREATE EXTENSION` runs as in production) and pause TimescaleDB jobs after migrating. The pool logs idle-client errors, times out connections after 10 s and sets `application_name`. Jobs and `collect` refuse to run against a database holding v1 tables. The legacy import never re-imports raw rows older than the retention window. `@next/env` is a direct dependency, pinned to the installed `next` version.
- After Task 4 review: `executeJob` pings start before touching the database and abandons stale `running` rows; `scripts/job.ts` sends a fail ping when a job cannot even start, refuses to run without `HEALTHCHECKS_PING_BASE` when `RADAR_REQUIRE_HEALTHCHECKS=1`, sets `statement_timeout`/`lock_timeout`, and bounds the final pool close. A fully successful run also pings `radar-<job>-quality`, so sustained degradation alerts through that check's period. `latestCompletedRun` was removed; the census baseline is the newest run of the last 6 hours whose `stats.listQuality` is `success` (`latestRunWithStat`), whatever the run status. `errorMessage` includes the `cause` chain.
- After Task 6 review: `upsertGameDetails` sorts by id, ignores stale writes (`excluded.last_observed_at >= games.last_observed_at`), keeps `first_observed_at` as the minimum, reuses stored name/description when the fingerprint is unchanged, and fills null place mappings with a targeted UPDATE; `savePlaceResolution` never erases a known mapping; `recordDiscoveries` sorts and merges duplicate windows; `games` uses fillfactor 80 for HOT updates; PostgreSQL 18 is checked before migrating and before every job. The Task 6 code blocks above predate these changes; the committed code is authoritative.
- After Task 11: charts store each sort as soon as it is read and replace its slot atomically; an empty sort counts as failed. The legacy import stops v1 chart placements at the first v2 charts slot (`job_runs`), so a slot never mixes two rankings. Chart, search and recommendation items are validated one by one; chart ranks keep their original positions (gaps for skipped items), a game listed both sponsored and organic keeps its organic rank, a sort above `maximumMalformedShare` malformed entries counts as failed, a terminal 429 stops the charts run, and replacements of the same slot are serialized with an advisory lock. Rank-based analysis in phase 3 should still filter `is_sponsored is not true`.
- After Task 7 review: writers return rows actually written (`rowCount`), sort by full key, and are tested against compressed chunks; charts replace a sort's whole slot atomically on retry (`replaceChartSlot`); the legacy import must keep per-statement commits (TimescaleDB limits tuples decompressed per transaction) and is tested to never overwrite v2 data.
- After Task 6 re-review: no writer may set `games.last_observed_at` later than real time (the stale-write guard compares against it); the legacy import reads v1 games in universe-id order. Migrations 0000 and 0001 were edited in place only because no persistent v2 database existed yet; from now on, schema changes go into new migrations.
- After Task 9 review: poll and votes gate quality on `returned / requested >= minimumReturnedShare` (no shedding allowance); `runBatchesWithDeadline` stops on a terminal 429 (`stopOn`) or after `maximumConsecutiveFailedBatches` failed batches in a row; poll's deadline is 180 s; observations are written per batch; the active set ignores `last_ccu` older than 24 h, uses `bucket >= time_bucket(1 hour, now - 24h)`, and keeps young games for 7 days after their last non-zero CCU (`games.last_active_at`, migration 0002); an empty active set degrades poll; poll stats carry HTTP metrics and `shedBelowCcu`. Task 10 (votes) must use the same stop rules (`stopOn` 429, consecutive failures) as committed in `batching.ts`. `runBatchesWithDeadline` takes an options object and `evaluateCollectionQuality` takes `{ requested, returned, minimumReturnedShare }`; the Task 9 code blocks above predate this, the committed code is authoritative. The legacy import also backfills `last_active_at`. On a fresh database, poll reports degraded until census has promoted games.
- Follow-up (accepted trade-off): a batch started before the poll deadline can still overrun the 270 s timeout when Roblox sends `Retry-After` on 429 or 5xx responses; such a run ends `failed` (which alerts) and keeps its per-batch data. The fix is to add `signal: AbortSignal` to `JobContext`, abort it shortly before `timeoutMs`, and thread it into `fetchJson` with abortable retry sleeps.
- After Task 5 re-review: thumbnails also report `"pending"` (processing or in review), Blocked counts as no thumbnail, `countPerUniverse=3` falls back to an approved image, icons are best-effort per batch, and a thumbnails run where Roblox answered for no game fails.
- After Task 5 review: `getGameThumbnails` uses `defaults=false` (with `defaults=true`, games without media come back as shared generic `GameMediaItem` images marked Completed), parses items one by one, and returns a custom thumbnail, `null` (no custom thumbnail) or no entry (unknown). Thumbnail versions are keyed on the media asset id through `games.thumbnail_key` (migration 0003).
- Before phase 3: analysis must exclude every slot whose run was not `success` (failed runs can leave partial writes), not only degraded ones. Exception: census slots are filtered on `job_runs.stats.listQuality`, because a census run can be degraded by resolution or promotion problems while its list is complete.
- After Task 8 review: game details, votes and Rolimon's entries are validated item by item (a malformed item is skipped and logged, a broken envelope still throws); a missing place resolves to `{"universeId": null}` with HTTP 200 (not 404), stored as unresolvable; census degrades when the Games API fails during promotion (`PromotionApiError`; database errors fail the run), or when resolution is stalled (nothing answered and either rate-limited, out of budget, or at least `stalledResolutionFailures` failures; resolving stops after that many consecutive failures); its list is degraded below `minimumListed` or above `maximumRejectedShare` rejected entries; charts and explore catch only `PromotionApiError`. The Task 8 code blocks above predate these changes; the committed code is authoritative.
- Before phase 3: raw SQL over aggregates returns `int8`, `numeric` and `timestamptz` as strings; convert with `Number()`/`new Date()` or declare the views with `pgView(...).existing()`. Exclude the partial current UTC day from daily analysis; `game_daily` computes it in real time.
- Before phase 4: cache the dashboard database instance on `globalThis` so Next dev hot reloads do not open new pools.
- Task 17: update design section 2 (separate `vote_observations`, 365-day raw retention, aggregate columns).
- Before phase 2: measure how often description fingerprints change on phase-1 `game_versions` data, and store the fingerprint algorithm version with each classification so a normalizer change does not trigger a mass reclassification.

## Out of scope for this plan (phase 1b)

- Deploy from the `radar-v2` branch until cutover: merging it into `main` removes the v1 scheduler workflow.
- Provision Healthchecks checks through the management API (`POST /api/v3/checks/` with `unique: ["slug"]`), derived from `JOB_CONFIG`: each job check uses the job's real period with a grace near `timeoutMs`; each `-quality` check uses the job's period with a grace equal to the tolerated degradation (about 60 minutes; add `qualityGraceMinutes` per job), which must stay below the census `baselineMaxAgeHours`. Auto-created checks default to a 1-day period and would alert about 25 hours late.
- PostgreSQL tuning sets `client_connection_check_interval` (about 10 s) so statements of a killed job process stop server-side.
- PostgreSQL tuning also sets `checkpoint_timeout` to at least 15 minutes and `wal_compression` on, to limit full-page images from the 5-minute `games` updates; monitor `n_tup_hot_upd / n_tup_upd` on `games`.
- systemd units set `RADAR_REQUIRE_HEALTHCHECKS=1` and an `OnFailure=` unit that sends the fail ping for process deaths the code cannot report.
- Timers use `AccuracySec=1s` (the 1-minute default can push a 270 s run into the next tick, which systemd then merges silently) and are offset so jobs sharing a Roblox host (poll, votes, census promotion, charts, explore) do not start in the same minute; HTTP spacing is per process.
- Run `EXPLAIN (ANALYZE, BUFFERS)` on the active-set query with real data to confirm chunk exclusion in the real-time half of `game_hourly`.
- Provisioning creates both checks per job before the first run and sends one test ping to prove the ping key works; with `create=1` alone, a wrong key or a job degraded from its first run would never create its check.
- Server provisioning script, PostgreSQL roles (application owner, read-only analysis role), TimescaleDB tuning, Node 24 LTS.
- systemd units and timers per job, a pull-based deploy timer, the web service behind `tailscale serve`.
- pgBackRest archiving to R2 or B2, the weekly restore test, disk monitoring, Healthchecks periods and grace times.
- First production run: `npm run db:migrate`, `npm run import:legacy`, enabling timers, a 24-hour observation period.
