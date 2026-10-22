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
  // Keyed by host and exact path, without the query string (pacedEndpoint in src/lib/api/http.ts). A request waits for
  // both its host's spacing and its endpoint's.
  minimumIntervalByEndpoint: {
    // Game details. Production measured a hidden per-IP limit on 2026-10-21 that counts ids, not requests: 50 ids every
    // 2 s got a 429 on the 6th request (300 ids in about 10 s); at 0.5 s every poll run got about four 429s, each
    // followed by a 33–55 s reset, about 500 ids per minute; 1 id every 2 s ran 40 requests without one. The
    // x-ratelimit-* headers kept reporting "300;w=60" with 287–290 remaining, so they do not describe this limit, and
    // /v1/games/votes on the same host is not affected. 50 ids every 7 s is about 430 ids per minute.
    "games.roblox.com/v1/games": 7_000,
  } satisfies Record<string, number>,
  // A 429 from an endpoint above multiplies its spacing by this for the rest of the process, up to the maximum.
  rateLimitSlowdownFactor: 1.5,
  maximumEndpointIntervalMs: 30_000,
} as const;

export const ROBLOX_REGION = {
  country: process.env.ROBLOX_COUNTRY || "all",
  device: process.env.ROBLOX_DEVICE || "computer",
} as const;

// Intervals and timeouts must match ops/systemd (src/lib/ops/systemd.test.ts checks them).
export const JOB_CONFIG = {
  census: {
    intervalMinutes: 10,
    timeoutMs: 9 * 60_000,
    promotionMinimumCcu: 100,
    resolutionBudgetMs: 150_000,
    resolutionRetryDays: 7,
    maximumListSizeChange: 0.3,
    // A shorter list is truncated even without a baseline; Rolimon's lists about 7,800 places.
    minimumListed: 1_000,
    // A larger share of malformed entries means Rolimon's changed its format.
    maximumRejectedShare: 0.05,
    baselineMaxAgeHours: 6,
    // Fewer failures with nothing resolved are one bad place, not an outage of the resolution API.
    stalledResolutionFailures: 3,
  },
  poll: {
    // Every 10 minutes, the design's fallback once the game details endpoint proved rate limited: at its 7 s spacing
    // (EXTERNAL_REQUEST_CONFIG.minimumIntervalByEndpoint) the active set no longer fits a 5-minute slot.
    intervalMinutes: 10,
    timeoutMs: 9 * 60_000,
    // 450 s at one request every 7 s is about 64 requests of 50 games, about 3,200 games; the games planned beyond
    // that are shed, last in the request order first. Leaves 90 s before the timeout for a batch that started just
    // before the deadline and is still in its retries.
    deadlineMs: 7.5 * 60_000,
    batchSize: 50,
    // The active set (about 4,300 games on 2026-10-21, growing toward 5,000 as census promotes every place at or above
    // 100 CCU) no longer fits one run. Each run requests the hot set, the first hotUniverses of the active set in
    // priority order, then at most tailUniversesPerRun of the other games, the tail, whose details were stored or
    // requested the longest ago (never either first): a game Roblox does not answer is retried once per tail cycle,
    // not on every run. The hot set goes first, so the deadline sheds tail games before any hot game.
    // Hot 2,000 = 40 requests, plus tail 1,150 = 23 requests, gives 63 requests × 7 s ≈ 441 s, within the 450 s
    // deadline. With about 2,300–3,000 tail games, each is refreshed every 20–30 minutes; census still counts their CCU
    // every 10 minutes.
    hotUniverses: 2_000,
    tailUniversesPerRun: 1_150,
    // Of the games requested (the hot set and the tail slice), not of the whole active set.
    minimumReturnedShare: 0.95,
    maximumConsecutiveFailedBatches: 3,
    // Universe ids of the requested games Roblox did not answer, kept in the run's stats (missingSample).
    missingSampleSize: 10,
  },
  votes: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    deadlineMs: 25 * 60_000,
    batchSize: 50,
    minimumReturnedShare: 0.95,
    maximumConsecutiveFailedBatches: 3,
  },
  charts: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    minimumSortShare: 0.8,
    // A sort with a larger share of malformed entries is too incomplete to stand for the ranking: it counts as failed.
    maximumMalformedShare: 0.2,
  },
  explore: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    // Rising young games: the average hourly CCU of the current window against the same window a day earlier.
    seedMaximumAgeDays: 60,
    currentWindowHours: 6,
    previousWindowOffsetHours: 24,
    // Growth is ln((current + k) / (previous + k)): k keeps a game going from 5 to 50 CCU from outranking real risers.
    seedSmoothingCcu: 100,
    seedMinimumCurrentCcu: 150,
    // Recommendations expand the top seeds; search terms come from the titles of a wider set of rising games.
    seedCount: 10,
    recommendationsPerSeed: 20,
    termTitleCount: 50,
    // A term must be shared by this many titles; with fewer titles available, by every one of them.
    minimumTermTitles: 3,
    searchTermCount: 4,
    minimumDiscoveryCcu: 50,
  },
  thumbnails: {
    intervalMinutes: 60,
    timeoutMs: 30 * 60_000,
    // Leaves room before the timeout for a batch that started just before the deadline and is still in its retries.
    deadlineMs: 20 * 60_000,
    batchSize: 50,
    // Unanswered batches in a row that point to an outage of the thumbnail endpoint rather than to bad games.
    maximumConsecutiveFailedBatches: 3,
    refreshHours: 24,
    // A never-checked game that Roblox answered as pending, with an error or not at all waits this long, behind new
    // games and refreshes, before it is requested again: an image in review still arrives within hours, while deleted
    // or moderated games no longer head every run. Each one costs four requests a day instead of 24.
    retryUnansweredAfterHours: 6,
    refreshMinimumCcu: 50,
    // A checked game is refreshed only while its CCU is this recent: a game Roblox stops returning keeps its last CCU.
    refreshMaximumCcuAgeHours: 24,
    maximumGamesPerRun: 4_000,
    // Every answer counts, including "no custom thumbnail", "pending" and "error"; only unanswered games are missing.
    minimumAnsweredShare: 0.9,
  },
} as const;

// The database sessions of the scripts and the dashboard, and how they end. A job's statement timeout is its own
// timeoutMs.
export const DATABASE_SESSION_CONFIG = {
  // Jobs, `collect` and the legacy import: a blocked lock fails its statement instead of stalling the run.
  lockTimeoutMs: 30_000,
  // Migrations take exclusive locks: one blocked behind a running job gives up instead of queueing every later query
  // on the table behind it.
  migrationLockTimeoutMs: 10_000,
  // `status` is read-only and interactive: it gives up quickly rather than waiting behind a migration or a lock.
  statusStatementTimeoutMs: 30_000,
  statusLockTimeoutMs: 5_000,
  // Every statement of the legacy import commits on its own and stays short: one window, one page or one refresh.
  legacyImportStatementTimeoutMs: 10 * 60_000,
  // The dashboard (radar-web) only reads: its sessions are read-only, a slow page gives up instead of holding a
  // connection, and its pool stays small beside the jobs' connections.
  dashboardStatementTimeoutMs: 15_000,
  dashboardLockTimeoutMs: 5_000,
  dashboardMaxConnections: 5,
  // Scripts exit after this even when a query left running by a timed-out job keeps its client checked out.
  closeTimeoutMs: 5_000,
  // A run still marked running this long after its timeout belongs to a process that crashed or was killed.
  abandonedRunGraceMs: 60_000,
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
  // Observations carry their slot, the run's start floored to 10 minutes, and a game is read up to the 7.5-minute
  // deadline into its run. Poll reads a tail game every 2–3 runs (JOB_CONFIG.poll.tailUniversesPerRun), so its next
  // observation arrives up to about 38 minutes after the slot of its last one, and a 20-minute window would count a
  // healthy rotation as untracked. 60 minutes also covers a tail of up to about 5,700 games (5 runs) or a run that
  // shed its tail.
  trackedWithinMinutes: 60,
  // The window of the run counts, the 429 figures, the last error, the census list lookup and the data totals.
  summaryWindowHours: 24,
} as const;

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

// The Healthchecks checks (npm run provision:healthchecks). Periods come from JOB_CONFIG; graces from here.
export const HEALTHCHECKS_CONFIG = {
  // A run may use its whole timeoutMs before it pings, so a heartbeat is late only after that plus this margin.
  heartbeatGraceMarginMinutes: 5,
  // A degraded run pings only the heartbeat: the quality check alerts after this long without a fully successful
  // run. It stays below the census baselineMaxAgeHours, so an alert fires before the census loses its baseline.
  qualityGraceMinutes: 60,
  // Checks of the operations units (ops/systemd); ops/bin scripts ping the same slugs.
  operations: {
    deploy: {
      slug: "radar-deploy",
      name: "deploy",
      periodMinutes: 5,
      graceMinutes: 30,
      description: "Every run of radar-deploy.timer, also when there is nothing to deploy.",
    },
    system: {
      slug: "radar-system",
      name: "system",
      periodMinutes: 15,
      graceMinutes: 15,
      description: "Disk usage, WAL archiving and TimescaleDB policies (npm run system-check).",
    },
    backup: {
      slug: "radar-backup",
      name: "backup",
      periodMinutes: 24 * 60,
      graceMinutes: 3 * 60,
      description: "Daily pgBackRest backup to R2 (differential, full on Sundays).",
    },
    restoreTest: {
      slug: "radar-restore-test",
      name: "restore test",
      periodMinutes: 7 * 24 * 60,
      graceMinutes: 6 * 60,
      description: "Weekly restore of the latest backup into a scratch cluster.",
    },
  },
} as const;

// npm run system-check, every 15 minutes (radar-system-check.timer), reported to the radar-system check.
export const SYSTEM_CHECK_CONFIG = {
  // Past this share of the root filesystem there is still time to add a volume or prune before PostgreSQL stops.
  maximumDiskUsedShare: 0.7,
  // archive_timeout (ops/bin/configure-backups.sh) archives a WAL segment at least every 5 minutes while the database
  // writes: no archive for this long means archiving stalled and point-in-time recovery stopped.
  maximumArchiveAgeMinutes: 30,
  // A TimescaleDB policy is late after this many schedule intervals without success (and at least the minimum):
  // compression, retention and aggregate refreshes keep the active-set query fast and the disk bounded.
  lateJobIntervals: 3,
  minimumLateJobMinutes: 60,
} as const;
