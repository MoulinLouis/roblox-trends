import type { GameDatasetItem, RisingGameSignalRow } from "@/db/repository";
import { RISING_GAMES_CONFIG } from "./config";

export interface RisingGameCluster {
  tag: string;
  dimension: string;
  gameCount: number;
  totalCcu: number;
  averageScore: number;
  launchBreakouts: number;
  resurgences: number;
}

export function buildRisingGameClusters(
  signals: RisingGameSignalRow[],
  dataset: GameDatasetItem[],
): RisingGameCluster[] {
  const itemsByUniverse = new Map(dataset.map((item) => [item.game.universeId, item]));
  const clusters = new Map<string, RisingGameCluster & { scoreTotal: number }>();
  for (const signal of signals) {
    const item = itemsByUniverse.get(signal.universeId);
    for (const tag of item?.tags ?? []) {
      const key = `${tag.dimension}:${tag.tag}`;
      const cluster = clusters.get(key) ?? {
        tag: tag.tag,
        dimension: tag.dimension,
        gameCount: 0,
        totalCcu: 0,
        averageScore: 0,
        scoreTotal: 0,
        launchBreakouts: 0,
        resurgences: 0,
      };
      cluster.gameCount += 1;
      cluster.totalCcu += signal.currentCcu;
      cluster.scoreTotal += signal.score;
      cluster.averageScore = Math.round(cluster.scoreTotal / cluster.gameCount);
      if (signal.signalType === "launch_breakout") cluster.launchBreakouts += 1;
      else cluster.resurgences += 1;
      clusters.set(key, cluster);
    }
  }
  return [...clusters.values()]
    .filter((cluster) => cluster.gameCount >= RISING_GAMES_CONFIG.clusters.minimumGames)
    .sort(
      (left, right) =>
        right.gameCount - left.gameCount ||
        right.averageScore - left.averageScore ||
        right.totalCcu - left.totalCcu,
    )
    .map((cluster) => ({
      tag: cluster.tag,
      dimension: cluster.dimension,
      gameCount: cluster.gameCount,
      totalCcu: cluster.totalCcu,
      averageScore: cluster.averageScore,
      launchBreakouts: cluster.launchBreakouts,
      resurgences: cluster.resurgences,
    }));
}
