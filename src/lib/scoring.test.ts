import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./config";
import { calculateGameMetrics, calculateOpportunity, calculateTrendStage, protectedGrowth } from "./scoring";
import type { GameSnapshotPoint, TrendMetrics } from "./types";

describe("growth calculations", () => {
  it("calculates percentage growth when the baseline is credible", () => {
    expect(protectedGrowth(100, 175, 25, 50)).toBe(75);
  });

  it("suppresses a small-denominator jump without meaningful absolute gain", () => {
    expect(protectedGrowth(2, 10, 25, 50)).toBe(0);
  });

  it("keeps a breakout from a small baseline when absolute gain is meaningful", () => {
    expect(protectedGrowth(10, 110, 25, 50)).toBe(1000);
  });
});

describe("momentum score", () => {
  it("rewards persistent growth and exposes a complete breakdown", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const points: GameSnapshotPoint[] = [
      point(now, 168, 90, 1000, 100, 80),
      point(now, 72, 140, 1600, 150, 60),
      point(now, 48, 190, 2200, 210, 45),
      point(now, 24, 300, 3300, 320, 30),
      point(now, 1, 560, 5900, 560, 14),
      point(now, 0, 600, 6400, 610, 12),
    ];
    const result = calculateGameMetrics(points, new Date("2026-07-28T12:00:00Z"), DEFAULT_SETTINGS, now);
    expect(result.growth24h).toBe(100);
    expect(result.gain24h).toBe(300);
    expect(result.momentum.score).toBeGreaterThan(60);
    expect(result.momentum.breakdown).toHaveLength(7);
    expect(result.momentum.breakdown.every((part) => part.explanation.length > 0)).toBe(true);
  });

  it("uses seven-day averages once two comparable weeks exist", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const points = Array.from({ length: 15 }, (_, index) => {
      const daysAgo = 14 - index;
      const ccu = daysAgo >= 8 ? 100 : 200;
      return point(now, daysAgo * 24, ccu, 10_000 + index * 1_000, 100 + index * 10, 50);
    });
    const result = calculateGameMetrics(points, new Date("2026-06-01T00:00:00Z"), DEFAULT_SETTINGS, now);
    expect(result.durableWindowHours).toBe(168);
    expect(result.durableGrowth).toBe(100);
    expect(result.durabilityConfidence).toBe(100);
  });

  it("keeps rank movement comparable within the same chart", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const baseline = point(now, 24, 1_000, 100_000, 1_000, 80);
    baseline.chart = "Trending in Simulation";
    baseline.chartRanks = { "Trending in Simulation": 80 };
    const current = point(now, 0, 2_000, 200_000, 2_000, 5);
    current.chart = "Top Trending";
    current.chartRanks = { "Top Trending": 5 };
    const result = calculateGameMetrics([baseline, current], new Date("2026-08-01T00:00:00Z"), DEFAULT_SETTINGS, now);
    expect(result.rankMovement24h).toBe(0);
    expect(result.enteredMainChart24h).toBe(true);
  });

  it("calculates approval velocity only from known vote snapshots", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const baseline = { ...point(now, 24, 1_000, 100_000, 1_000, 50), upVotes: 500, downVotes: 50 };
    const current = { ...point(now, 0, 1_500, 200_000, 2_000, 40), upVotes: 1_500, downVotes: 100 };
    const result = calculateGameMetrics([baseline, current], new Date("2026-08-01T00:00:00Z"), DEFAULT_SETTINGS, now);
    expect(result.newUpVotes24h).toBe(1_000);
    expect(result.likesPerThousandVisits24h).toBe(10);
    expect(result.approvalRate).toBeCloseTo(93.75);
  });
});

describe("trend and opportunity scoring", () => {
  it("detects saturation when supply grows but combined demand is flat", () => {
    const metrics: TrendMetrics = { gameCount: 9, creatorCount: 8, combinedCcu: 5200, combinedGrowth72h: 3, newGames7d: 5, growingShare: 33, leaderShare: 42, historyCoverage: 100 };
    expect(calculateTrendStage(metrics, DEFAULT_SETTINGS)).toBe("saturated");
  });

  it("detects expansion only with breadth across creators", () => {
    const metrics: TrendMetrics = { gameCount: 4, creatorCount: 4, combinedCcu: 8400, combinedGrowth72h: 55, newGames7d: 2, growingShare: 75, leaderShare: 35, historyCoverage: 100 };
    expect(calculateTrendStage(metrics, DEFAULT_SETTINGS)).toBe("expanding");
  });

  it("keeps a broad but history-free signal at spark", () => {
    const metrics: TrendMetrics = { gameCount: 12, creatorCount: 10, combinedCcu: 12000, combinedGrowth72h: 0, newGames7d: 12, growingShare: 0, leaderShare: 25, historyCoverage: 0 };
    expect(calculateTrendStage(metrics, DEFAULT_SETTINGS)).toBe("spark");
  });

  it("scores a reusable simple loop above a costly meme concept", () => {
    const simple = calculateOpportunity(78, 25, [
      { dimension: "coreLoop", tag: "Tycoon", source: "automatic" },
      { dimension: "progression", tag: "Upgrade", source: "automatic" },
      { dimension: "theme", tag: "Animals", source: "automatic" },
    ], DEFAULT_SETTINGS.developerProfile, DEFAULT_SETTINGS);
    const costly = calculateOpportunity(78, 25, [
      { dimension: "coreLoop", tag: "Combat", source: "automatic" },
      { dimension: "social", tag: "Raid", source: "automatic" },
      { dimension: "theme", tag: "Anime", source: "automatic" },
      { dimension: "theme", tag: "Brainrot", source: "automatic" },
    ], DEFAULT_SETTINGS.developerProfile, DEFAULT_SETTINGS);
    expect(simple.score).toBeGreaterThan(costly.score);
    expect(simple.breakdown).toHaveLength(7);
  });
});

function point(now: Date, hoursAgo: number, ccu: number, visits: number, favorites: number, rank: number): GameSnapshotPoint {
  return { collectedAt: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000), ccu, visits, favorites, rank };
}
