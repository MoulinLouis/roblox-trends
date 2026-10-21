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
    // A term must be shared by this many titles; with fewer titles available, one title is enough.
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
    refreshMinimumCcu: 50,
    maximumGamesPerRun: 4_000,
    // Every answer counts, including "no custom thumbnail", "pending" and "error"; only unanswered games are missing.
    minimumAnsweredShare: 0.9,
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
