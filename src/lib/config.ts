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
    // Recommendations, one path per universe. They advertise 200 requests per minute (x-ratelimit-limit "200;w=60",
    // also from production on 2026-10-22), but the game details endpoint on the same host proved to hide a stricter
    // limit: explore spreads them over its hour at 24 per minute, beside its searches, which wait a minute each.
    "games.roblox.com/v1/games/recommendations/game/*": 2_500,
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
    // The active set (about 4,300 games on 2026-10-21, 9,768 on 2026-10-25 once explore promoted what it found) no
    // longer fits one run. Each run requests the hot set, the first hotUniverses of the active set in priority order,
    // then at most tailUniversesPerRun of the other games, the tail, furthest past their lane's refresh interval
    // (never-requested games first): a game Roblox does not answer is retried once per interval, not on every run.
    // The hot set goes first, so the deadline sheds tail games before any hot game.
    // Hot 2,000 = 40 requests, plus tail 1,150 = 23 requests, gives 63 requests × 7 s ≈ 441 s, within the 450 s
    // deadline.
    hotUniverses: 2_000,
    tailUniversesPerRun: 1_150,
    // How long a tail game waits between two requests. Young games, created within the Radar's widest age filter
    // (RADAR_CONFIG.ageOptionsDays), are the only ones the Radar lists, and their hourly readings date its crossings
    // and pair its weekday-safe growth. Census counts the CCU of nearly every established tail game every 10 minutes,
    // so poll adds little more than their visits, favorites and metadata; a game that breaks out joins the hot set.
    // On 2026-10-25 the tail held 2,240 young and 5,528 established games: about 2,240 × 2 + 5,528 / 4 ≈ 5,860
    // requests an hour, against 6,300–6,900 (1,150 a run, fewer when candidates take their place). One rotating tail
    // refreshed every game every 70 minutes. When the tail outgrows the budget, both lanes slow down in proportion.
    tailRefreshMinutes: { young: 30, established: 240 },
    // Of the games requested (the hot set and the tail slice), not of the whole active set.
    minimumReturnedShare: 0.95,
    maximumConsecutiveFailedBatches: 3,
    // Universe ids of the requested games Roblox did not answer, kept in the run's stats (missingSample).
    missingSampleSize: 10,
    // Universes that explore found and the games table does not hold (discovery_candidates). Each run requests the
    // busiest of them after the hot set, in place of as many tail games: promotion then stays within the game details
    // budget instead of adding requests beside poll's. 100 per run promotes up to 600 games an hour.
    candidatesPerRun: 100,
    // A candidate no discovery listed again for this long is dropped: it lost its players or left the results.
    candidateMaximumAgeHours: 24,
    // A candidate Roblox did not answer (moderated or deleted) waits this long before it is requested again.
    candidateRetryHours: 6,
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
    // Search answers one request per minute from the production IP (x-ratelimit-limit "1;w=60", enforced with 429s,
    // measured on 2026-10-22; a residential IP gets 4 per second), so the run spends most of its hour searching.
    timeoutMs: 55 * 60_000,
    // No request starts after this. Leaves time for the wait of a search that started just before it, and for writes.
    deadlineMs: 45 * 60_000,
    // Seeds: the young games with at least this average hourly CCU over the window, busiest first. Their
    // recommendations are expanded and their titles make the search vocabulary.
    seedMaximumAgeDays: 60,
    seedWindowHours: 6,
    seedMinimumCcu: 50,
    // At the recommendations' 2.5 s spacing (EXTERNAL_REQUEST_CONFIG.minimumIntervalByEndpoint), 1,000 seeds take about
    // 42 minutes, within the deadline: the quietest seeds are the ones it sheds.
    seedCount: 1_000,
    // Roblox returns at most 6 recommendations whatever maxRows asks for, and its next pages repeat them (2026-10-22).
    recommendationsPerSeed: 6,
    // A word becomes a search term once this many seed titles share it; with fewer titles available, every one of them.
    minimumTermTitles: 2,
    // Page 2 lists smaller games than page 1: on 2026-10-22 it found more untracked games than page 1 did.
    searchPagesPerTerm: 2,
    // Terms are searched in order of titles × hours since their last search, the hours capped here (a term not searched
    // within the cap counts the cap). The most shared words come back every run or two and the rarest every one to four
    // days. A one-day cap would starve them: simulated on 2026-10-22, a vocabulary twice today's 232 words left every
    // word of two titles unsearched for good.
    termRecencyCapHours: 7 * 24,
    // The global sorts list a game only once it leads worldwide; a game rising in one market enters that country's
    // sorts first (on 2026-10-22, Steal the Moon was in Up-and-Coming for the US and Great Britain only).
    countrySortIds: ["up-and-coming", "top-trending"],
    // Every country answers its own lists. On 2026-10-22, right after a run had queued what the first 14 listed, the
    // others listed 114 more untracked games at 50+ CCU, 28 of them above 1,000; +1 Paper Plane (3.3k) was in
    // Up-and-Coming for Egypt, Lebanon, Palestine, Uzbekistan and Armenia only. The sort endpoint allows 50 requests a
    // minute from the production IP (x-ratelimit-limit "50;w=60", measured the same day) and apis.roblox.com's 1.3 s
    // spacing keeps a run under 47: the 218 sorts take about 5 minutes, beside the recommendations, before the search.
    countries: [
      "us", "br", "ph", "id", "mx", "gb", "de", "fr", "ca", "au", "th", "sa", "vn", "tr",
      "ae", "al", "am", "ar", "at", "az", "ba", "bd", "be", "bg", "bh", "bo", "by", "ch", "cl", "co", "cr", "cy",
      "cz", "dk", "do", "dz", "ec", "ee", "eg", "es", "fi", "ge", "gh", "gr", "gt", "hk", "hn", "hr", "hu", "ie",
      "il", "in", "iq", "is", "it", "jm", "jo", "jp", "ke", "kh", "kr", "kw", "kz", "la", "lb", "lk", "lt", "lu",
      "lv", "ly", "ma", "md", "mk", "mm", "mn", "mt", "my", "ng", "ni", "nl", "no", "np", "nz", "om", "pa", "pe",
      "pk", "pl", "pr", "ps", "pt", "py", "qa", "ro", "rs", "ru", "se", "sg", "si", "sk", "sv", "tn", "tt", "tw",
      "ua", "uy", "uz", "ve", "za",
    ],
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
  // A listed place counts as tracked when poll read its game within this window. Poll reads an established tail game
  // every 4 hours (JOB_CONFIG.poll.tailRefreshMinutes), and an observation carries its slot, the run's start floored to
  // 10 minutes, while the game is read up to the 7.5-minute deadline into its run: 6 hours leaves room for a few shed
  // runs. A place outside it is one the radar does not follow at all (unresolved, never promoted, or a game Roblox
  // does not answer) or a tail that fell far behind; how long each lane waits is the tail refresh (poll's
  // medianTailDetailsMinutes).
  trackedWithinMinutes: 6 * 60,
  // The window of the run counts, the 429 figures, the last error, the census list lookup and the data totals.
  summaryWindowHours: 24,
} as const;

// The Radar page and rising_games (drizzle/0009_rising_games_execute.sql, design section 5A). The SQL function takes
// every value below as a parameter; docs/operations.md shows a call with them for analysis sessions.
export const RADAR_CONFIG = {
  // Filters on the real age, from the Roblox creation date.
  ageOptionsDays: [14, 30, 90],
  defaultAgeDays: 30,
  minimumCcuOptions: [50, 100, 500, 1_000, 5_000],
  defaultMinimumCcu: 100,
  // The current window: the whole UTC hours before as_of. Acceleration compares its average CCU with the window
  // before it; weekday-safe growth compares the game's share of tracked CCU with its share in the same hours one week
  // earlier, among the games read in both.
  windowHours: 24,
  // The growth score is ln((share now × market + k) / (share a week ago × market + k)), in CCU at the current market
  // size: k keeps a game going from 5 to 50 CCU from outranking real risers. A game poll did not read a week ago is
  // compared through the census of its places when Rolimon's listed them in both windows. Otherwise it counts from 0,
  // ln((CCU + k) / k), when it is new or when census stored a list in every hour of the week-ago window without it (too
  // few players for Rolimon's); otherwise it has no score.
  smoothingCcu: 100,
  // A peak that reaches this multiple of the window's median hourly CCU, while the window's last hour is back under
  // it, is an event (admin abuse, a promotion) rather than organic growth. The median of the same window, not of seven
  // days: a game rising tenfold in a week would otherwise flag every hour of its rise; and a breakout still rising at
  // the end of the window is no event.
  eventPeakToMedianRatio: 3,
  eventMinimumSamples: 12,
  // Velocity: hours from the start to the middle threshold and from the middle to the end one, measured only when
  // the radar (poll or census) saw the game below the threshold it starts from.
  velocityThresholds: { start: 100, middle: 1_000, end: 10_000 },
  // Velocity is measured only when the reading before each crossing is at most this many hours older: v2 reads every
  // game the Radar lists at least hourly (poll every 30 minutes, census every 10), while v1 read 6–7 hours a day, so a
  // crossing across a longer gap cannot be dated.
  velocityMaximumGapHours: 2,
  pageSize: 100,
} as const;

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

// npm run concept (scripts/concept.ts): every Roblox attempt at a concept, for analysis sessions on the owner's
// machine. The diagnosis thresholds come from the stone-skipping check of 2026-10-26: the attempts before the owner's
// game had 6,720 to 57,235 visits, the two from early September 88% and 93% likes on 24 and 681 votes, and none had
// players.
export const CONCEPT_CHECK_CONFIG = {
  // Page 2 lists smaller games than page 1, as for explore's terms.
  searchPagesPerPhrase: 2,
  // Attempts created this recently mean the race has started.
  recentDays: 14,
  // The daily curve of a tracked attempt goes back this far.
  historyDays: 60,
  diagnosis: {
    // Fewer visits and players than these: no audience. A new attempt with few visits but players already has one.
    noAudienceMaximumVisits: 10_000,
    noAudienceMaximumPlayers: 100,
    // At least this share of likes on at least this many votes, with fewer players and visits than the maximums: liked
    // but stuck. The visits cap keeps out games that found an audience and lost it: on the live check of 2026-10-26,
    // "[NEW]Stone Miner Evolution" had 91% likes, 2 players and 8.7 million visits; the liked attempts it should name had
    // 9,309 to 174,791.
    likedMinimumRatio: 0.85,
    likedMinimumVotes: 20,
    stuckMaximumPlayers: 100,
    stuckMaximumVisits: 1_000_000,
    // Players at most this share of a tracked peak of at least the minimum: fading.
    fadingMinimumPeakCcu: 1_000,
    fadingMaximumShareOfPeak: 0.1,
  },
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

// The classification trial (docs/plans/2026-10-28-radar-v2-classification-trial.md); the production job reuses the
// request settings, prices and description length.
export const CLASSIFICATION_CONFIG = {
  effort: "low",
  // Thinking counts against it; a classification answer is a few hundred tokens.
  maxTokens: 8_000,
  // Descriptions are keyword-stuffed: the start carries the pitch, the rest is codes and update notes.
  descriptionMaxCharacters: 1_000,
  thumbnailJpegQuality: 80,
  thumbnailDownloadConcurrency: 8,
  batchPollIntervalMs: 30_000,
  // Most batches end within an hour; a rerun of the command resumes polling after this.
  batchMaximumWaitMs: 2 * 60 * 60_000,
  // USD per million tokens, Anthropic list prices on 2026-10-28. A 5-minute cache write costs 1.25 times the input
  // price. Batches bill half of every price.
  pricing: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  },
  cacheWriteMultiplier: 1.25,
  batchDiscount: 0.5,
  sample: {
    youngDays: 60,
    // Postgres regular expressions on the title, tried in this order; the first match sets the game's stratum.
    waves: [
      { stratum: "plus-one", pattern: "(^|[^0-9a-z])\\+1([^0-9]|$)" },
      { stratum: "verb-for-reward", pattern: "\\mfor\\M.*\\m(eggs?|animals?|pets?|dinos?|brainrots?)\\M" },
      { stratum: "steal", pattern: "\\msteal\\M" },
      { stratum: "eggs", pattern: "\\meggs?\\M" },
      { stratum: "fart", pattern: "\\mfart" },
    ],
    // Young games that match no wave, by all-time peak CCU.
    youngPeakBuckets: [
      { stratum: "young-under-100", below: 100 },
      { stratum: "young-100-1k", below: 1_000 },
      { stratum: "young-1k-10k", below: 10_000 },
      { stratum: "young-10k-plus", below: null },
    ],
  },
  trials: {
    // The owner's +1 Stone Skipping is always in the comparison.
    comparison: {
      seed: "comparison-2026-10-28",
      requiredUniverseIds: [10765298801],
      quotas: {
        "plus-one": 20, "verb-for-reward": 12, steal: 12, eggs: 16, fart: 5,
        "young-under-100": 25, "young-100-1k": 30, "young-1k-10k": 30, "young-10k-plus": 25, established: 24,
      },
    },
    review: {
      seed: "review-2026-10-28",
      requiredUniverseIds: [],
      quotas: {
        "plus-one": 10, "verb-for-reward": 6, steal: 6, eggs: 8, fart: 2,
        "young-under-100": 13, "young-100-1k": 15, "young-1k-10k": 15, "young-10k-plus": 13, established: 12,
      },
    },
  },
} as const;
