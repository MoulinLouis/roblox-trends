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
    intervalMinutes: 5,
    timeoutMs: 270_000,
    // Leaves room before the timeout for a batch that started just before the deadline and is still in its retries.
    deadlineMs: 180_000,
    batchSize: 50,
    minimumReturnedShare: 0.95,
    maximumConsecutiveFailedBatches: 3,
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

// The database sessions of the scripts and how they end. A job's statement timeout is its own timeoutMs.
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
  trackedWithinMinutes: 15,
  // The window of the run counts, the 429 figures, the last error, the census list lookup and the data totals.
  summaryWindowHours: 24,
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
