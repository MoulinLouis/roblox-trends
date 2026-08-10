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
  const recentSegments = [24, 48, 72].map((hours) => {
    const newer = findBaseline(points, current.collectedAt.getTime() - (hours - 24) * HOUR) ?? current;
    const older = findBaseline(points, current.collectedAt.getTime() - hours * HOUR) ?? newer;
    return newer.ccu > older.ccu;
  });
  const persistence = (recentSegments.filter(Boolean).length / recentSegments.length) * 100;
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / (24 * HOUR));
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
    newVisits24h: Math.max(0, current.visits - baselines[1].visits),
    newFavorites24h: Math.max(0, current.favorites - baselines[1].favorites),
    rankMovement24h:
      current.rank && baselines[1].rank ? Math.max(0, baselines[1].rank - current.rank) : 0,
    ageDays,
    persistence,
  };

  return { ...metrics, momentum: calculateMomentum(metrics, settings) };
}

type MomentumInputs = Omit<GameMetrics, "momentum">;

export function calculateMomentum(metrics: MomentumInputs, settings: AppSettings): MomentumResult {
  const weights = settings.momentumWeights;
  const inputs: Array<Omit<ScorePart, "points">> = [
    {
      key: "ccuGrowth",
      label: "24h CCU growth",
      raw: metrics.growth24h,
      normalized: clamp(metrics.growth24h / 2),
      weight: weights.ccuGrowth,
      explanation: `${formatSigned(metrics.growth24h)}% in 24 hours`,
    },
    {
      key: "acceleration",
      label: "Acceleration",
      raw: metrics.acceleration,
      normalized: clamp(50 + metrics.acceleration),
      weight: weights.acceleration,
      explanation: `${formatSigned(metrics.acceleration)} points versus the previous day`,
    },
    {
      key: "absoluteGain",
      label: "Absolute player gain",
      raw: metrics.gain24h,
      normalized: clamp((Math.log10(Math.max(0, metrics.gain24h) + 1) / 4) * 100),
      weight: weights.absoluteGain,
      explanation: `${formatNumber(metrics.gain24h)} net players in 24 hours`,
    },
    {
      key: "visitGrowth",
      label: "New visits",
      raw: metrics.newVisits24h,
      normalized: clamp((Math.log10(metrics.newVisits24h + 1) / 6) * 100),
      weight: weights.visitGrowth,
      explanation: `${formatNumber(metrics.newVisits24h)} new visits in 24 hours`,
    },
    {
      key: "rankImprovement",
      label: "Chart rank movement",
      raw: metrics.rankMovement24h,
      normalized: clamp(metrics.rankMovement24h * 5),
      weight: weights.rankImprovement,
      explanation: `${metrics.rankMovement24h} places gained`,
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
