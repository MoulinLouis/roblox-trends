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
  return {
    universeId: item.game.universeId,
    name: item.game.name,
    creatorName: item.game.creatorName,
    createdAt: item.game.createdAt.toISOString(),
    chart: currentPoint.chart ?? "Unknown chart",
    ...input,
    ...result,
  };
}
