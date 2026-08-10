import type { GameDatasetItem } from "@/db/repository";
import { IDEA_EVIDENCE_CONFIG } from "./config";

export interface AlgorithmEvidenceInput {
  ageDays: number;
  historyHours: number;
  currentCcu: number;
  growth24h: number;
  gain24h: number;
  newVisits24h: number;
  rankMovement24h: number;
  persistence: number;
  momentumScore: number;
}

export interface IdeaGameEvidence extends AlgorithmEvidenceInput {
  universeId: string;
  name: string;
  creatorName: string;
  createdAt: string;
  chart: string;
  algorithmProof: boolean;
  evidenceScore: number;
  durabilityStatus: DurabilityStatus;
  durabilityConfidence: number;
  observedDailyWindows: number;
  positiveDailyWindows: number;
  peakDrawdownPercent: number;
  eventRisk: boolean;
  durabilityWarnings: string[];
}

export type DurabilityStatus = "unverified" | "mixed" | "durable" | "fragile";

export interface DurabilityAssessment {
  durabilityStatus: DurabilityStatus;
  durabilityConfidence: number;
  observedDailyWindows: number;
  positiveDailyWindows: number;
  peakDrawdownPercent: number;
  eventRisk: boolean;
  durabilityWarnings: string[];
}

interface DurabilityPoint {
  collectedAt: Date;
  ccu: number;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalized(value: number, strongValue: number): number {
  return clamp((Math.max(0, value) / strongValue) * 100);
}

export function calculateAlgorithmEvidence(input: AlgorithmEvidenceInput): {
  algorithmProof: boolean;
  evidenceScore: number;
} {
  const config = IDEA_EVIDENCE_CONFIG;
  const weights = config.evidenceWeights;
  const freshness = clamp((1 - input.ageDays / config.recentGameMaxAgeDays) * 100);
  const weightedScore =
    input.momentumScore * weights.momentum +
    freshness * weights.freshness +
    normalized(input.growth24h, config.strongGrowth24h) * weights.growth24h +
    normalized(input.gain24h, config.strongGain24h) * weights.gain24h +
    normalized(input.newVisits24h, config.strongNewVisits24h) * weights.newVisits24h +
    normalized(input.rankMovement24h, config.strongRankMovement24h) * weights.rankMovement24h +
    clamp(input.persistence) * weights.persistence;
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const algorithmProof =
    input.ageDays <= config.recentGameMaxAgeDays &&
    input.historyHours >= config.minimumHistoryHours &&
    input.currentCcu >= config.minimumCurrentCcu &&
    input.gain24h >= config.minimumGain24h &&
    input.growth24h >= config.minimumGrowth24h &&
    input.newVisits24h >= config.minimumNewVisits24h;

  return { algorithmProof, evidenceScore: Math.round(weightedScore / totalWeight) };
}

export function buildIdeaGameEvidence(item: GameDatasetItem): IdeaGameEvidence | null {
  const metrics = item.analysis?.metrics;
  const firstPoint = item.snapshots.at(0);
  const currentPoint = item.snapshots.at(-1);
  if (!metrics || !firstPoint || !currentPoint) return null;

  const input: AlgorithmEvidenceInput = {
    ageDays: metrics.ageDays,
    historyHours: Math.max(0, (currentPoint.collectedAt.getTime() - firstPoint.collectedAt.getTime()) / 3_600_000),
    currentCcu: currentPoint.ccu,
    growth24h: metrics.growth24h,
    gain24h: metrics.gain24h,
    newVisits24h: metrics.newVisits24h,
    rankMovement24h: metrics.rankMovement24h,
    persistence: metrics.persistence,
    momentumScore: item.analysis?.momentumScore ?? 0,
  };
  const result = calculateAlgorithmEvidence(input);
  const durability = calculateDurabilityAssessment(item.snapshots, item.game.name);
  return {
    universeId: item.game.universeId,
    name: item.game.name,
    creatorName: item.game.creatorName,
    createdAt: item.game.createdAt.toISOString(),
    chart: currentPoint.chart ?? "Unknown chart",
    ...input,
    ...result,
    ...durability,
  };
}

export function calculateDurabilityAssessment(
  points: DurabilityPoint[],
  gameName = "",
): DurabilityAssessment {
  const config = IDEA_EVIDENCE_CONFIG.durability;
  const ordered = [...points].sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime());
  const first = ordered.at(0);
  const latest = ordered.at(-1);
  if (!first || !latest) {
    return {
      durabilityStatus: "unverified",
      durabilityConfidence: 0,
      observedDailyWindows: 0,
      positiveDailyWindows: 0,
      peakDrawdownPercent: 0,
      eventRisk: false,
      durabilityWarnings: ["No historical snapshots are available"],
    };
  }

  const historyHours = Math.max(0, (latest.collectedAt.getTime() - first.collectedAt.getTime()) / 3_600_000);
  const maximumDailyWindows = Math.min(7, Math.floor(historyHours / 24));
  const endpoints = Array.from({ length: maximumDailyWindows + 1 }, (_, index) =>
    nearestPoint(ordered, latest.collectedAt.getTime() - index * 24 * 3_600_000, config.dailyWindowToleranceHours),
  );
  const dailyWindows = endpoints.slice(0, -1).flatMap((current, index) => {
    const baseline = endpoints[index + 1];
    if (!current || !baseline || baseline.ccu <= 0) return [];
    const gain = current.ccu - baseline.ccu;
    return [{ gain, growth: (gain / baseline.ccu) * 100 }];
  });
  const positiveDailyWindows = dailyWindows.filter(
    (window) => window.gain >= config.minimumDailyGain && window.growth >= config.minimumDailyGrowth,
  ).length;
  const recentCutoff = latest.collectedAt.getTime() - config.strongHours * 3_600_000;
  const recentPoints = ordered.filter((point) => point.collectedAt.getTime() >= recentCutoff);
  const peakCcu = Math.max(latest.ccu, ...recentPoints.map((point) => point.ccu));
  const peakDrawdownPercent = peakCcu > 0 ? Math.max(0, ((peakCcu - latest.ccu) / peakCcu) * 100) : 0;
  const latestDailyGrowth = dailyWindows[0]?.growth ?? 0;
  const hasPromotionalMarker = config.eventMarkers.some((marker) => gameName.toLowerCase().includes(marker));
  const durabilityWarnings: string[] = [];
  if (historyHours < config.minimumHours || dailyWindows.length < 3) {
    durabilityWarnings.push(
      `Only ${Math.round(historyHours)} of ${config.minimumHours} required hours are available; an event spike cannot be ruled out`,
    );
  }
  if (hasPromotionalMarker) {
    durabilityWarnings.push("The title contains an update, event, or multiplier marker that may explain a temporary spike");
  }
  if (peakDrawdownPercent >= config.fragilePeakDrawdown) {
    durabilityWarnings.push(`CCU is ${Math.round(peakDrawdownPercent)}% below the observed peak`);
  }
  if (latestDailyGrowth <= config.fragileDailyReversal) {
    durabilityWarnings.push(`The latest daily window reversed by ${Math.abs(Math.round(latestDailyGrowth))}%`);
  }

  let durabilityStatus: DurabilityStatus = "mixed";
  if (historyHours < config.minimumHours || dailyWindows.length < 3) durabilityStatus = "unverified";
  else if (
    peakDrawdownPercent >= config.fragilePeakDrawdown ||
    latestDailyGrowth <= config.fragileDailyReversal
  ) durabilityStatus = "fragile";
  else if (
    positiveDailyWindows >= config.minimumPositiveDailyWindows &&
    peakDrawdownPercent <= config.durableMaximumPeakDrawdown
  ) durabilityStatus = "durable";

  return {
    durabilityStatus,
    durabilityConfidence: durabilityConfidence(historyHours, config.minimumHours, config.strongHours),
    observedDailyWindows: dailyWindows.length,
    positiveDailyWindows,
    peakDrawdownPercent: Math.round(peakDrawdownPercent * 10) / 10,
    eventRisk: hasPromotionalMarker || durabilityStatus === "fragile",
    durabilityWarnings,
  };
}

function nearestPoint(
  points: DurabilityPoint[],
  targetTime: number,
  toleranceHours: number,
): DurabilityPoint | null {
  let nearest: DurabilityPoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point.collectedAt.getTime() - targetTime);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= toleranceHours * 3_600_000 ? nearest : null;
}

function durabilityConfidence(historyHours: number, minimumHours: number, strongHours: number): number {
  if (historyHours < 24) return Math.round((historyHours / 24) * 30);
  if (historyHours < minimumHours) return Math.round(30 + ((historyHours - 24) / (minimumHours - 24)) * 30);
  if (historyHours < strongHours) return Math.round(60 + ((historyHours - minimumHours) / (strongHours - minimumHours)) * 40);
  return 100;
}
