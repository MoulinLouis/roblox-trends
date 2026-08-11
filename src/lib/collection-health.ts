import { COLLECTION_DISCOVERY_CONFIG } from "./config";
import type { CollectionError } from "./types";

export type CollectionHealthStatus = "healthy" | "degraded" | "critical";
export type CollectionAttemptStatus = CollectionHealthStatus | "running";
export type CollectionHealthTransition = "critical" | "degraded" | "recovered";

export interface CollectionHealthInput {
  errors: CollectionError[];
  snapshots: number;
  expectedCharts: number;
  completedCharts: number;
  expectedGames: number;
  completedGames: number;
}

export interface CollectionHealth {
  status: CollectionHealthStatus;
  reasons: string[];
}

export function selectRotatingWindow<T>(
  items: readonly T[],
  size: number,
  bucketAt: Date,
  intervalMinutes: number,
): T[] {
  if (!items.length || size <= 0) return [];
  if (size >= items.length) return [...items];
  const bucketIndex = Math.floor(bucketAt.getTime() / (intervalMinutes * 60_000));
  const start = (bucketIndex * size) % items.length;
  return Array.from({ length: size }, (_, offset) => items[(start + offset) % items.length]);
}

export function classifyCollectionHealth(input: CollectionHealthInput): CollectionHealth {
  const reasons: string[] = [];
  const minimumCharts = Math.max(
    1,
    Math.ceil(input.expectedCharts * COLLECTION_DISCOVERY_CONFIG.minimumChartCoverageRatio),
  );
  const criticalErrors = input.errors.filter(
    (error) => error.source === "roblox-charts" || error.source === "roblox-games",
  );

  if (input.snapshots === 0) reasons.push("No snapshots were persisted.");
  if (input.completedCharts < minimumCharts) {
    reasons.push(`Only ${input.completedCharts} of ${input.expectedCharts} configured charts completed.`);
  }
  const minimumGames = Math.ceil(
    input.expectedGames * COLLECTION_DISCOVERY_CONFIG.minimumGameDetailCoverageRatio,
  );
  if (input.completedGames < minimumGames) {
    reasons.push(`Only ${input.completedGames} of ${input.expectedGames} requested game details completed.`);
  }
  if (criticalErrors.length) reasons.push(...criticalErrors.map((error) => error.message));
  if (reasons.length) return { status: "critical", reasons: [...new Set(reasons)] };

  if (input.errors.length) {
    return {
      status: "degraded",
      reasons: [...new Set(input.errors.map((error) => `${error.source}: ${error.message}`))],
    };
  }
  return { status: "healthy", reasons: [] };
}

export function detectCollectionHealthTransition(
  statuses: readonly CollectionAttemptStatus[],
): CollectionHealthTransition | null {
  const [current, previous, beforePrevious] = statuses;
  if (current === "critical" && previous !== "critical") return "critical";
  if (current === "degraded" && previous === "degraded" && beforePrevious !== "degraded") return "degraded";
  if (current === "healthy" && (previous === "degraded" || previous === "critical")) return "recovered";
  return null;
}
