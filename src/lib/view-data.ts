import {
  getIdeas,
  getActiveRisingGameSignals,
  getRecentCollectionAttempts,
  getRecentSourceRuns,
  getSettings,
  getTrendLinks,
  getTrends,
  loadGameDataset,
  type GameDatasetItem,
} from "@/db/repository";
import type { TrendStage } from "./types";
import { ensureAppReady } from "./app-ready";

export async function loadApplicationData() {
  await ensureAppReady();
  const [settings, dataset, trends, ideas, sourceRuns, collectionAttempts, links, risingSignals] = await Promise.all([
    getSettings(),
    loadGameDataset(),
    getTrends(),
    getIdeas(),
    getRecentSourceRuns(36),
    getRecentCollectionAttempts(),
    getTrendLinks(),
    getActiveRisingGameSignals(),
  ]);
  const trendById = new Map(trends.map((trend) => [trend.id, trend]));
  const stagesByGame = new Map<string, Set<TrendStage>>();
  for (const link of links) {
    const stage = trendById.get(link.trendId)?.stage;
    if (!stage) continue;
    const stages = stagesByGame.get(link.universeId) ?? new Set<TrendStage>();
    stages.add(stage);
    stagesByGame.set(link.universeId, stages);
  }
  return { settings, dataset, trends, ideas, sourceRuns, collectionAttempts, links, stagesByGame, risingSignals };
}

export function currentPoint(item: GameDatasetItem) {
  return item.snapshots.at(-1) ?? null;
}

export function latestCollectionTime(dataset: GameDatasetItem[]): Date | null {
  const timestamps = dataset.flatMap((item) => item.snapshots.at(-1)?.collectedAt.getTime() ?? []);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}
