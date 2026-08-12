import { RISING_GAMES_CONFIG, ROBLOX_EVENT_MARKERS } from "./config";
import type {
  RisingGameConfidence,
  RisingGameMetrics,
  RisingGameSignalCandidate,
  RisingGameTier,
  RisingWindowEvidence,
} from "./rising-game-types";
import type { GameSnapshotPoint } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_HOURS = [1, 3, 6, 24] as const;

export interface RisingGameInput {
  universeId: string;
  name: string;
  createdAt: Date;
  firstSeenAt: Date;
  snapshots: GameSnapshotPoint[];
  recentMetadataText?: string;
}

export function detectRisingGameSignal(
  input: RisingGameInput,
  now = new Date(),
): RisingGameSignalCandidate | null {
  const points = [...input.snapshots].sort(
    (left, right) => left.collectedAt.getTime() - right.collectedAt.getTime(),
  );
  const current = points.at(-1);
  if (!current || current.ccu < RISING_GAMES_CONFIG.minimumCurrentCcu) return null;

  const first = points[0] ?? current;
  const observedHours = Math.max(0, (current.collectedAt.getTime() - first.collectedAt.getTime()) / HOUR);
  const ageDays = Math.max(0, (current.collectedAt.getTime() - input.createdAt.getTime()) / DAY);
  const firstSeenHoursAgo = Math.max(0, (now.getTime() - input.firstSeenAt.getTime()) / HOUR);
  const windows = Object.fromEntries(
    WINDOW_HOURS.flatMap((hours) => {
      const evidence = calculateRisingWindow(points, hours);
      return evidence ? [[String(hours), evidence]] : [];
    }),
  ) as RisingGameMetrics["windows"];
  const strongestWindow = selectStrongestWindow(windows);
  const historical = points.filter(
    (point) =>
      point.collectedAt.getTime() >=
        current.collectedAt.getTime() - RISING_GAMES_CONFIG.resurgence.historicalLookbackDays * DAY &&
      point.collectedAt.getTime() <=
        current.collectedAt.getTime() - RISING_GAMES_CONFIG.resurgence.recentPeakExclusionHours * HOUR,
  );
  const priorPeakCcu = Math.max(0, ...historical.map((point) => point.ccu));
  const historicalMedianCcu = median(historical.map((point) => point.ccu));
  const medianMultiple = historicalMedianCcu > 0 ? current.ccu / historicalMedianCcu : 0;
  const recentPoints = points.filter(
    (point) => point.collectedAt.getTime() >= current.collectedAt.getTime() - 24 * HOUR,
  );
  const peakCcu = Math.max(current.ccu, ...recentPoints.map((point) => point.ccu));
  const peakDrawdownPercent = peakCcu > 0 ? ((peakCcu - current.ccu) / peakCcu) * 100 : 0;
  const crossedMilestone = findCrossedMilestone(current.ccu, Object.values(windows));
  const newHighSinceTracking =
    observedHours >= RISING_GAMES_CONFIG.resurgenceMinimumHistoryHours &&
    priorPeakCcu > 0 &&
    current.ccu >= priorPeakCcu * RISING_GAMES_CONFIG.resurgence.minimumNewHighRatio &&
    current.ccu - priorPeakCcu >= RISING_GAMES_CONFIG.resurgence.minimumNewHighGain;
  const enteredDiscoveryChart = Boolean(
    current.rank && points.slice(0, -1).every((point) => !point.rank),
  );
  const rapidDiscovery =
    ageDays <= RISING_GAMES_CONFIG.launchMaximumAgeDays &&
    observedHours <= RISING_GAMES_CONFIG.rapidDiscoveryMaximumObservedHours &&
    firstSeenHoursAgo <=
      RISING_GAMES_CONFIG.rapidDiscoveryMaximumObservedHours +
        RISING_GAMES_CONFIG.rapidDiscoveryFirstSeenToleranceHours &&
    current.ccu >= RISING_GAMES_CONFIG.rapidDiscoveryMinimumCcu;
  const signalType = ageDays <= RISING_GAMES_CONFIG.launchMaximumAgeDays
    ? "launch_breakout"
    : "resurgence";
  const qualifies = signalType === "launch_breakout"
    ? rapidDiscovery || crossedMilestone !== null || hasQualifyingLaunchWindow(windows)
    : qualifiesAsResurgence({ windows, medianMultiple, newHighSinceTracking, observedHours });
  if (!qualifies) return null;

  const risks = detectRisks(input, current, peakDrawdownPercent);
  const score = calculateRisingScore({
    signalType,
    currentCcu: current.ccu,
    strongestWindow,
    observedHours,
    crossedMilestone,
    newHighSinceTracking,
    medianMultiple,
    rapidDiscovery,
    enteredDiscoveryChart,
    risks,
  });
  if (score < RISING_GAMES_CONFIG.score.minimum) return null;

  const metrics: RisingGameMetrics = {
    currentCcu: current.ccu,
    observedHours: round(observedHours),
    ageDays: round(ageDays),
    firstSeenHoursAgo: round(firstSeenHoursAgo),
    strongestWindow,
    windows,
    priorPeakCcu,
    historicalMedianCcu,
    medianMultiple: round(medianMultiple),
    peakDrawdownPercent: round(peakDrawdownPercent),
    crossedMilestone,
    newHighSinceTracking,
    enteredDiscoveryChart,
    chart: current.chart ?? null,
  };
  return {
    universeId: input.universeId,
    signalType,
    score,
    tier: tierForScore(score),
    confidence: confidenceForHistory(observedHours),
    detectedAt: now,
    metrics,
    reasons: buildReasons({ signalType, metrics, rapidDiscovery }),
    risks,
  };
}

export function detectRisingGameSignals(
  inputs: RisingGameInput[],
  now = new Date(),
): RisingGameSignalCandidate[] {
  return inputs
    .map((input) => detectRisingGameSignal(input, now))
    .filter((signal): signal is RisingGameSignalCandidate => signal !== null)
    .sort((left, right) => right.score - left.score || right.metrics.currentCcu - left.metrics.currentCcu);
}

export function calculateRisingWindow(
  points: GameSnapshotPoint[],
  hours: (typeof WINDOW_HOURS)[number],
): RisingWindowEvidence | null {
  const current = points.at(-1);
  if (!current) return null;
  const target = current.collectedAt.getTime() - hours * HOUR;
  const baseline = [...points].reverse().find((point) => point.collectedAt.getTime() <= target);
  if (!baseline) return null;
  const actualHours = (current.collectedAt.getTime() - baseline.collectedAt.getTime()) / HOUR;
  const tolerance = RISING_GAMES_CONFIG.windows[hours].toleranceHours;
  if (actualHours > hours + tolerance) return null;
  const gain = current.ccu - baseline.ccu;
  const growthPercent = baseline.ccu > 0 ? (gain / baseline.ccu) * 100 : gain > 0 ? 100 : 0;
  return {
    hours,
    actualHours: round(actualHours),
    baselineAt: baseline.collectedAt.toISOString(),
    baselineCcu: baseline.ccu,
    currentCcu: current.ccu,
    gain,
    growthPercent: round(growthPercent),
    visitsGain: Math.max(0, current.visits - baseline.visits),
    favoritesGain: Math.max(0, current.favorites - baseline.favorites),
  };
}

function hasQualifyingLaunchWindow(windows: RisingGameMetrics["windows"]): boolean {
  return WINDOW_HOURS.some((hours) => {
    const evidence = windows[String(hours) as keyof typeof windows];
    const threshold = RISING_GAMES_CONFIG.windows[hours];
    return Boolean(
      evidence &&
        evidence.gain >= threshold.minimumGain &&
        evidence.growthPercent >= threshold.minimumGrowthPercent,
    );
  });
}

function qualifiesAsResurgence(input: {
  windows: RisingGameMetrics["windows"];
  medianMultiple: number;
  newHighSinceTracking: boolean;
  observedHours: number;
}): boolean {
  if (input.observedHours < RISING_GAMES_CONFIG.resurgenceMinimumHistoryHours) return false;
  const sixHours = input.windows["6"];
  const oneDay = input.windows["24"];
  return Boolean(
    input.newHighSinceTracking ||
      input.medianMultiple >= RISING_GAMES_CONFIG.resurgence.minimumMedianMultiple ||
      (sixHours &&
        sixHours.gain >= RISING_GAMES_CONFIG.resurgence.minimumGain6h &&
        sixHours.growthPercent >= RISING_GAMES_CONFIG.resurgence.minimumGrowth6h) ||
      (oneDay &&
        oneDay.gain >= RISING_GAMES_CONFIG.resurgence.minimumGain24h &&
        oneDay.growthPercent >= RISING_GAMES_CONFIG.resurgence.minimumGrowth24h),
  );
}

function calculateRisingScore(input: {
  signalType: RisingGameSignalCandidate["signalType"];
  currentCcu: number;
  strongestWindow: RisingWindowEvidence | null;
  observedHours: number;
  crossedMilestone: number | null;
  newHighSinceTracking: boolean;
  medianMultiple: number;
  rapidDiscovery: boolean;
  enteredDiscoveryChart: boolean;
  risks: string[];
}): number {
  const gain = Math.max(0, input.strongestWindow?.gain ?? 0);
  const growth = Math.max(0, input.strongestWindow?.growthPercent ?? 0);
  const weights = RISING_GAMES_CONFIG.score.weights;
  let score = weights.base;
  score += Math.min(
    weights.currentCcuMaximum,
    Math.log10(input.currentCcu / RISING_GAMES_CONFIG.minimumCurrentCcu + 1) *
      weights.currentCcuLogMultiplier,
  );
  score += Math.min(weights.gainMaximum, Math.log10(gain + 1) * weights.gainLogMultiplier);
  score += Math.min(weights.growthMaximum, growth / weights.growthDivisor);
  score += Math.min(weights.historyMaximum, input.observedHours / weights.historyDivisor);
  if (input.crossedMilestone) score += weights.milestone;
  if (input.rapidDiscovery) score += weights.rapidDiscovery;
  if (input.enteredDiscoveryChart) score += weights.discoveryChartEntry;
  if (input.signalType === "resurgence") {
    score += Math.min(
      weights.resurgenceMedianMaximum,
      Math.max(0, input.medianMultiple - 1) * weights.resurgenceMedianMultiplier,
    );
    if (input.newHighSinceTracking) score += weights.newHigh;
  }
  score -= input.risks.length * weights.riskPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildReasons(input: {
  signalType: RisingGameSignalCandidate["signalType"];
  metrics: RisingGameMetrics;
  rapidDiscovery: boolean;
}): string[] {
  const reasons: string[] = [];
  const strongest = input.metrics.strongestWindow;
  if (strongest) {
    reasons.push(
      `${formatSigned(strongest.gain)} CCU (${formatSigned(strongest.growthPercent)}%) over ${strongest.actualHours}h`,
    );
  }
  if (input.metrics.crossedMilestone) {
    reasons.push(`Crossed ${formatNumber(input.metrics.crossedMilestone)} concurrent players`);
  }
  if (input.rapidDiscovery) reasons.push("Reached meaningful demand within the first observed hours");
  if (input.metrics.newHighSinceTracking) reasons.push("Set a new high since tracking began");
  if (input.signalType === "resurgence" && input.metrics.medianMultiple > 1) {
    reasons.push(`${input.metrics.medianMultiple.toFixed(1)}× the recent historical median`);
  }
  if (input.metrics.enteredDiscoveryChart) reasons.push("Visible on a Roblox discovery chart");
  return reasons.slice(0, 5);
}

function detectRisks(
  input: RisingGameInput,
  current: GameSnapshotPoint,
  peakDrawdownPercent: number,
): string[] {
  const risks: string[] = [];
  const text = `${input.name} ${input.recentMetadataText ?? ""}`.toLowerCase();
  if (ROBLOX_EVENT_MARKERS.some((marker) => text.includes(marker))) {
    risks.push("Recent title or metadata suggests an update or temporary event");
  }
  if (current.isSponsored) risks.push("Current discovery observation is sponsored");
  if (peakDrawdownPercent >= RISING_GAMES_CONFIG.riskPeakDrawdownPercent) {
    risks.push(`${Math.round(peakDrawdownPercent)}% below the recent peak`);
  }
  return risks;
}

function selectStrongestWindow(
  windows: RisingGameMetrics["windows"],
): RisingWindowEvidence | null {
  return Object.values(windows)
    .filter((window): window is RisingWindowEvidence => Boolean(window))
    .sort((left, right) => {
      const leftScore = Math.max(0, left.growthPercent) + Math.log10(Math.max(0, left.gain) + 1) * 20;
      const rightScore = Math.max(0, right.growthPercent) + Math.log10(Math.max(0, right.gain) + 1) * 20;
      return rightScore - leftScore;
    })[0] ?? null;
}

function findCrossedMilestone(
  currentCcu: number,
  windows: Array<RisingWindowEvidence | undefined>,
): number | null {
  return [...RISING_GAMES_CONFIG.ccuMilestones]
    .reverse()
    .find(
      (milestone) =>
        currentCcu >= milestone &&
        windows.some((window) => window && window.baselineCcu < milestone),
    ) ?? null;
}

function tierForScore(score: number): RisingGameTier {
  if (score >= RISING_GAMES_CONFIG.score.explosive) return "explosive";
  if (score >= RISING_GAMES_CONFIG.score.surging) return "surging";
  return "rising";
}

function confidenceForHistory(observedHours: number): RisingGameConfidence {
  if (observedHours >= RISING_GAMES_CONFIG.confidence.establishedHistoryHours) return "established";
  if (observedHours >= RISING_GAMES_CONFIG.confidence.verifiedHistoryHours) return "verified";
  return "early";
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString("en-US")}`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
