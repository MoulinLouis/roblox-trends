import type {
  AppSettings,
  DeveloperProfile,
  GameMetrics,
  GameSnapshotPoint,
  GameTag,
  MomentumResult,
  ScorePart,
  TrendMetrics,
} from "./types";

const HOUR = 60 * 60 * 1000;

export interface GameAnalysisContext {
  metadataEventRisk?: boolean;
}

export function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}

export function protectedGrowth(
  previous: number,
  current: number,
  minimumBaselineCcu: number,
  minimumAbsoluteGain: number,
): number {
  const gain = current - previous;
  if (previous < minimumBaselineCcu && gain < minimumAbsoluteGain) return 0;
  if (previous <= 0) return gain >= minimumAbsoluteGain ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

export function findBaseline(points: GameSnapshotPoint[], targetTime: number): GameSnapshotPoint | null {
  const before = points.filter((point) => point.collectedAt.getTime() <= targetTime);
  if (before.length) return before.at(-1) ?? null;
  return points.find((point) => point.collectedAt.getTime() >= targetTime) ?? null;
}

export function calculateGameMetrics(
  inputPoints: GameSnapshotPoint[],
  createdAt: Date,
  settings: AppSettings,
  now = new Date(),
  context: GameAnalysisContext = {},
): GameMetrics {
  const points = [...inputPoints].sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime());
  const current = points.at(-1) ?? {
    collectedAt: now,
    ccu: 0,
    visits: 0,
    favorites: 0,
    rank: null,
  };
  const baselines = [1, 24, 72, 168].map(
    (hours) => findBaseline(points, current.collectedAt.getTime() - hours * HOUR) ?? current,
  );
  const growths = baselines.map((point) =>
    protectedGrowth(
      point.ccu,
      current.ccu,
      settings.thresholds.minimumBaselineCcu,
      settings.thresholds.minimumAbsoluteGain,
    ),
  );
  const gains = baselines.map((point) => current.ccu - point.ccu);
  const previousDayStart = findBaseline(points, current.collectedAt.getTime() - 48 * HOUR) ?? baselines[1];
  const priorGrowth = protectedGrowth(
    previousDayStart.ccu,
    baselines[1].ccu,
    settings.thresholds.minimumBaselineCcu,
    settings.thresholds.minimumAbsoluteGain,
  );
  const acceleration = growths[1] - priorGrowth;
  const dailySegments = calculateDailySegments(points, current.collectedAt.getTime());
  const persistence = dailySegments.length
    ? (dailySegments.filter((segment) => segment > 0).length / dailySegments.length) * 100
    : 0;
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / (24 * HOUR));
  const historyHours = points.length > 1
    ? Math.max(0, (current.collectedAt.getTime() - points[0].collectedAt.getTime()) / HOUR)
    : 0;
  const durableSignal = calculateDurableSignal(points, current, settings);
  const recentPoints = points.filter(
    (point) => point.collectedAt.getTime() >= current.collectedAt.getTime() - 72 * HOUR,
  );
  const peakCcu72h = Math.max(current.ccu, ...recentPoints.map((point) => point.ccu));
  const peakDrawdown72h = peakCcu72h > 0 ? ((peakCcu72h - current.ccu) / peakCcu72h) * 100 : 0;
  const sponsoredDiscoveryRisk = recentPoints.some((point) => point.isSponsored === true);
  const eventRisk = Boolean(context.metadataEventRisk || sponsoredDiscoveryRisk || peakDrawdown72h >= 35);
  const newUpVotes24h = differenceWhenKnown(current.upVotes, baselines[1].upVotes);
  const newDownVotes24h = differenceWhenKnown(current.downVotes, baselines[1].downVotes);
  const totalVotes = (current.upVotes ?? 0) + (current.downVotes ?? 0);
  const approvalRate = totalVotes > 0 ? ((current.upVotes ?? 0) / totalVotes) * 100 : 0;
  const newVisits24h = Math.max(0, current.visits - baselines[1].visits);
  const newFavorites24h = Math.max(0, current.favorites - baselines[1].favorites);
  const likesPerThousandVisits24h = newVisits24h > 0 ? (newUpVotes24h / newVisits24h) * 1_000 : 0;
  const favoritesPerThousandVisits24h = newVisits24h > 0 ? (newFavorites24h / newVisits24h) * 1_000 : 0;
  const rankMovement24h = calculateSameChartRankMovement(current, baselines[1]);
  const enteredMainChart24h = enteredMainChart(current, baselines[1]);
  const chartBreadth = Object.keys(current.chartRanks ?? {}).length;
  const metrics = {
    growth1h: growths[0],
    growth24h: growths[1],
    growth72h: growths[2],
    growth7d: growths[3],
    gain1h: gains[0],
    gain24h: gains[1],
    gain72h: gains[2],
    gain7d: gains[3],
    acceleration,
    newVisits24h,
    newFavorites24h,
    newUpVotes24h,
    newDownVotes24h,
    approvalRate,
    likesPerThousandVisits24h,
    favoritesPerThousandVisits24h,
    rankMovement24h,
    enteredMainChart24h,
    chartBreadth,
    ageDays,
    persistence,
    historyHours,
    durableGrowth: durableSignal.growth,
    durableGain: durableSignal.gain,
    durableWindowHours: durableSignal.windowHours,
    durabilityConfidence: clamp((historyHours / 168) * 100),
    peakDrawdown72h,
    eventRisk,
    sponsoredDiscoveryRisk,
  };

  return { ...metrics, momentum: calculateMomentum(metrics, settings) };
}

type MomentumInputs = Omit<GameMetrics, "momentum">;

export function calculateMomentum(metrics: MomentumInputs, settings: AppSettings): MomentumResult {
  const weights = settings.momentumWeights;
  const durableConfidenceFactor = 0.35 + (metrics.durabilityConfidence / 100) * 0.65;
  const stability = clamp(
    70 + Math.min(30, metrics.acceleration) - metrics.peakDrawdown72h * 1.5 - (metrics.eventRisk ? 20 : 0),
  );
  const visitVelocity = clamp((Math.log10(metrics.newVisits24h + 1) / 6) * 100);
  const qualityConversion = metrics.newVisits24h >= 1_000
    ? clamp(metrics.likesPerThousandVisits24h * 8 + metrics.favoritesPerThousandVisits24h * 2)
    : 0;
  const demandQuality = qualityConversion > 0 ? visitVelocity * 0.8 + qualityConversion * 0.2 : visitVelocity;
  const inputs: Array<Omit<ScorePart, "points">> = [
    {
      key: "ccuGrowth",
      label: "Sustained CCU growth",
      raw: metrics.durableGrowth,
      normalized: clamp(metrics.durableGrowth / 2) * durableConfidenceFactor,
      weight: weights.ccuGrowth,
      explanation: `${formatSigned(metrics.durableGrowth)}% between compared ${formatWindow(metrics.durableWindowHours)} averages; ${Math.round(metrics.durabilityConfidence)}% history confidence`,
    },
    {
      key: "acceleration",
      label: "Acceleration and spike resilience",
      raw: stability,
      normalized: stability,
      weight: weights.acceleration,
      explanation: `${formatSigned(metrics.acceleration)} acceleration points; ${Math.round(metrics.peakDrawdown72h)}% below the 72h peak${metrics.eventRisk ? "; temporary-spike risk detected" : ""}`,
    },
    {
      key: "absoluteGain",
      label: "Sustained player gain",
      raw: metrics.durableGain,
      normalized: clamp((Math.log10(Math.max(0, metrics.durableGain) + 1) / 4) * 100) * durableConfidenceFactor,
      weight: weights.absoluteGain,
      explanation: `${formatNumber(metrics.durableGain)} average concurrent players gained across the compared window`,
    },
    {
      key: "visitGrowth",
      label: "Demand and approval velocity",
      raw: metrics.newVisits24h,
      normalized: demandQuality,
      weight: weights.visitGrowth,
      explanation: `${formatNumber(metrics.newVisits24h)} new visits; ${metrics.likesPerThousandVisits24h.toFixed(1)} likes and ${metrics.favoritesPerThousandVisits24h.toFixed(1)} favorites per 1,000 new visits`,
    },
    {
      key: "rankImprovement",
      label: "Comparable chart movement",
      raw: metrics.rankMovement24h + (metrics.enteredMainChart24h ? 20 : 0),
      normalized: metrics.enteredMainChart24h
        ? 100
        : clamp(metrics.rankMovement24h * 5 + Math.min(20, metrics.chartBreadth * 4)),
      weight: weights.rankImprovement,
      explanation: metrics.enteredMainChart24h
        ? `Entered a main discovery chart and now appears across ${metrics.chartBreadth} charts`
        : `${metrics.rankMovement24h} places gained within the same chart; present across ${metrics.chartBreadth} charts`,
    },
    {
      key: "freshness",
      label: "Game freshness",
      raw: metrics.ageDays,
      normalized: clamp(100 - metrics.ageDays * 1.4),
      weight: weights.freshness,
      explanation: `${Math.round(metrics.ageDays)} days old`,
    },
    {
      key: "persistence",
      label: "Growth persistence",
      raw: metrics.persistence,
      normalized: clamp(metrics.persistence),
      weight: weights.persistence,
      explanation: `Growth held across ${Math.round(metrics.persistence)}% of recent periods`,
    },
  ];
  const totalWeight = inputs.reduce((sum, item) => sum + item.weight, 0) || 1;
  const breakdown = inputs.map((item) => ({
    ...item,
    points: (item.normalized * item.weight) / totalWeight,
  }));
  return { score: Math.round(breakdown.reduce((sum, item) => sum + item.points, 0)), breakdown };
}

function calculateDurableSignal(
  points: GameSnapshotPoint[],
  current: GameSnapshotPoint,
  settings: AppSettings,
): { growth: number; gain: number; windowHours: number } {
  const currentTime = current.collectedAt.getTime();
  for (const windowHours of [168, 72, 24]) {
    const previous = points.filter((point) => {
      const ageHours = (currentTime - point.collectedAt.getTime()) / HOUR;
      return ageHours > windowHours && ageHours <= windowHours * 2;
    });
    const recent = points.filter((point) => {
      const ageHours = (currentTime - point.collectedAt.getTime()) / HOUR;
      return ageHours >= 0 && ageHours <= windowHours;
    });
    if (previous.length < 2 || recent.length < 2) continue;
    const previousAverage = average(previous.map((point) => point.ccu));
    const recentAverage = average(recent.map((point) => point.ccu));
    return {
      growth: protectedGrowth(
        previousAverage,
        recentAverage,
        settings.thresholds.minimumBaselineCcu,
        settings.thresholds.minimumAbsoluteGain,
      ),
      gain: recentAverage - previousAverage,
      windowHours,
    };
  }
  const first = points.at(0) ?? current;
  const windowHours = Math.max(1, Math.min(24, (currentTime - first.collectedAt.getTime()) / HOUR));
  return {
    growth: protectedGrowth(
      first.ccu,
      current.ccu,
      settings.thresholds.minimumBaselineCcu,
      settings.thresholds.minimumAbsoluteGain,
    ),
    gain: current.ccu - first.ccu,
    windowHours,
  };
}

function calculateDailySegments(points: GameSnapshotPoint[], currentTime: number): number[] {
  const segments: number[] = [];
  for (let day = 0; day < 7; day += 1) {
    const newer = nearestPoint(points, currentTime - day * 24 * HOUR, 3 * HOUR);
    const older = nearestPoint(points, currentTime - (day + 1) * 24 * HOUR, 3 * HOUR);
    if (!newer || !older) continue;
    segments.push(newer.ccu - older.ccu);
  }
  return segments;
}

function nearestPoint(points: GameSnapshotPoint[], targetTime: number, tolerance: number): GameSnapshotPoint | null {
  let result: GameSnapshotPoint | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const nextDistance = Math.abs(point.collectedAt.getTime() - targetTime);
    if (nextDistance < distance) {
      result = point;
      distance = nextDistance;
    }
  }
  return distance <= tolerance ? result : null;
}

function differenceWhenKnown(current: number | null | undefined, baseline: number | null | undefined): number {
  if (current === null || current === undefined || baseline === null || baseline === undefined) return 0;
  return Math.max(0, current - baseline);
}

function calculateSameChartRankMovement(current: GameSnapshotPoint, baseline: GameSnapshotPoint): number {
  const currentRanks = current.chartRanks ?? {};
  const baselineRanks = baseline.chartRanks ?? {};
  return Math.max(
    0,
    ...Object.entries(currentRanks).map(([chart, rank]) =>
      baselineRanks[chart] === undefined ? 0 : baselineRanks[chart] - rank,
    ),
  );
}

function enteredMainChart(current: GameSnapshotPoint, baseline: GameSnapshotPoint): boolean {
  const baselineRanks = baseline.chartRanks ?? {};
  return Object.keys(current.chartRanks ?? {}).some((chart) => isMainChart(chart) && baselineRanks[chart] === undefined);
}

function isMainChart(chart: string): boolean {
  return ["top playing now", "top trending", "most popular", "top earning", "top revisited"].includes(
    chart.toLowerCase(),
  );
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatWindow(hours: number): string {
  if (hours >= 168) return "7-day";
  if (hours >= 72) return "72-hour";
  if (hours >= 24) return "24-hour";
  return `${Math.round(hours)}-hour discovery`;
}

export function calculateTrendStage(metrics: TrendMetrics, settings: AppSettings) {
  const threshold = settings.thresholds;
  if (metrics.combinedGrowth72h < -10) return "declining" as const;
  if (
    metrics.historyCoverage >= 50 &&
    metrics.gameCount >= threshold.saturationMinGames &&
    metrics.newGames7d >= threshold.saturationNewGames7d &&
    metrics.combinedGrowth72h <= threshold.saturationFlatGrowth
  ) {
    return "saturated" as const;
  }
  if (
    metrics.historyCoverage >= 35 &&
    metrics.gameCount >= threshold.saturationMinGames &&
    metrics.newGames7d >= threshold.saturationNewGames7d
  ) {
    return "copy_wave" as const;
  }
  if (
    metrics.historyCoverage >= 50 &&
    metrics.creatorCount >= 3 &&
    metrics.growingShare >= 50 &&
    metrics.combinedGrowth72h >= 25
  ) {
    return "expanding" as const;
  }
  if (
    metrics.historyCoverage >= 50 &&
    metrics.gameCount >= 3 &&
    metrics.creatorCount >= 2 &&
    metrics.combinedGrowth72h >= 10
  ) {
    return "emerging" as const;
  }
  return "spark" as const;
}

export function calculateTrendScore(metrics: TrendMetrics): number {
  return Math.round(
    clamp(
      clamp(metrics.combinedGrowth72h, 0, 150) * 0.28 +
        clamp(metrics.creatorCount * 13) * 0.2 +
        clamp((Math.log10(metrics.combinedCcu + 1) / 5) * 100) * 0.2 +
        metrics.growingShare * 0.2 +
        clamp(metrics.newGames7d * 15) * 0.12,
    ),
  );
}

export function calculateSaturation(metrics: TrendMetrics): number {
  const supplyPressure = clamp(metrics.gameCount * 7 + metrics.newGames7d * 10);
  const flatDemand = metrics.historyCoverage >= 50
    ? clamp(100 - Math.max(0, metrics.combinedGrowth72h) * 2)
    : 20;
  const concentrationRisk = clamp(metrics.leaderShare);
  return Math.round(supplyPressure * 0.5 + flatDemand * 0.3 + concentrationRisk * 0.2);
}

export function calculateOpportunity(
  trendScore: number,
  saturation: number,
  tags: GameTag[],
  profile: DeveloperProfile,
  settings: AppSettings,
): { score: number; breakdown: ScorePart[] } {
  const tagNames = new Set(tags.map((tag) => tag.tag.toLowerCase()));
  const costly = ["combat", "anime", "horror", "raid"].filter((tag) => tagNames.has(tag)).length;
  const reusable = profile.reusableSystems.some((system) => tagNames.has(system.toLowerCase()));
  const memeDependent = tagNames.has("brainrot") ? 1 : 0;
  const clearLoop = ["idle", "tycoon", "obby", "collection", "steal", "grow"].some((tag) => tagNames.has(tag));
  const retention = ["collection", "training", "upgrade", "rebirth", "merge", "mutation"].filter((tag) =>
    tagNames.has(tag),
  ).length;
  const licensedIpRisk = tagNames.has("anime") ? 1 : 0;
  const estimatedWeeks = 2 + costly * 1.25 + Math.max(0, tags.length - 3) * 0.5;
  const scheduleFit = estimatedWeeks <= profile.preferredWeeksMax
    ? 94
    : clamp(94 - (estimatedWeeks - profile.preferredWeeksMax) * 20);
  const experiencePenalty = profile.robloxExperience === "recent"
    ? costly * 7
    : profile.robloxExperience === "intermediate"
      ? costly * 3
      : 0;
  const technicalFit = clamp(96 - costly * 18 - experiencePenalty);
  const assetHeavyTags = ["combat", "anime", "horror", "animals"].filter((tag) => tagNames.has(tag)).length;
  const budgetPenalty = profile.budget === "limited"
    ? assetHeavyTags * 14
    : profile.budget === "moderate"
      ? assetHeavyTags * 7
      : 0;
  const assetFit = clamp(94 - budgetPenalty);
  const teamAdjustment = clamp((profile.teamSize - 1) * 3, 0, 12);
  const feasibility = clamp((scheduleFit + technicalFit + assetFit) / 3 + teamAdjustment);
  const weights = settings.opportunityWeights;
  const inputs = [
    ["trendStrength", "Trend strength", trendScore, weights.trendStrength, `${trendScore}/100 trend score`],
    [
      "differentiation",
      "Room for differentiation",
      clamp(100 - saturation),
      weights.differentiation,
      `${saturation}/100 saturation leaves ${100 - saturation} points of whitespace`,
    ],
    [
      "feasibility",
      "Solo feasibility",
      feasibility,
      weights.feasibility,
      `About ${estimatedWeeks.toFixed(1)} weeks; technical fit ${Math.round(technicalFit)}/100 and asset fit ${Math.round(assetFit)}/100`,
    ],
    [
      "mobileClarity",
      "Mobile clarity",
      clamp((clearLoop ? 80 : 48) + profile.uiUxSkill * 2),
      weights.mobileClarity,
      clearLoop ? "The core loop is immediately readable" : "The loop needs more onboarding",
    ],
    [
      "reusePotential",
      "System reuse",
      clamp((reusable ? 88 : 48) + profile.webProductSkill * 1.4),
      weights.reusePotential,
      reusable ? "Matches an existing reusable system" : "Requires more net-new systems",
    ],
    [
      "retention",
      "Retention potential",
      clamp(50 + retention * 18),
      weights.retention,
      `${retention} progression or collection hooks`,
    ],
    [
      "durability",
      "Theme durability",
      clamp(86 - memeDependent * 48 - licensedIpRisk * 24),
      weights.durability,
      memeDependent
        ? "Depends on a short-lived meme"
        : licensedIpRisk
          ? "Anime framing can drift toward licensed-IP dependence"
          : "Low dependence on short-lived memes or licensed IP",
    ],
  ] as const;
  const totalWeight = inputs.reduce((sum, item) => sum + item[3], 0) || 1;
  const breakdown: ScorePart[] = inputs.map(([key, label, normalized, weight, explanation]) => ({
    key,
    label,
    raw: normalized,
    normalized,
    weight,
    points: (normalized * weight) / totalWeight,
    explanation,
  }));
  return { score: Math.round(breakdown.reduce((sum, item) => sum + item.points, 0)), breakdown };
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
