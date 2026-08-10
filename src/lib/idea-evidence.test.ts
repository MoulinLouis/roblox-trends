import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./config";
import { calculateAlgorithmEvidence, calculateDurabilityAssessment } from "./idea-evidence";
import { buildDeterministicRecommendations } from "./ideas";
import type { GameDatasetItem } from "@/db/repository";
import type { GameTag } from "./types";

const qualifyingEvidence = {
  ageDays: 30,
  historyHours: 24,
  currentCcu: 10_000,
  growth24h: 50,
  gain24h: 3_000,
  newVisits24h: 500_000,
  rankMovement24h: 5,
  persistence: 67,
  momentumScore: 65,
};

describe("algorithm breakout evidence", () => {
  it("recognizes a recent game with verified growth and meaningful scale", () => {
    const result = calculateAlgorithmEvidence(qualifyingEvidence);

    expect(result.algorithmProof).toBe(true);
    expect(result.evidenceScore).toBeGreaterThan(50);
  });

  it.each([
    { ageDays: 120 },
    { historyHours: 8 },
    { currentCcu: 500 },
    { growth24h: 5 },
    { gain24h: 100 },
    { newVisits24h: 10_000 },
  ])("rejects evidence that does not prove recent algorithm discovery: %o", (override) => {
    expect(calculateAlgorithmEvidence({ ...qualifyingEvidence, ...override }).algorithmProof).toBe(false);
  });

  it("rewards chart movement without requiring it for the proof gate", () => {
    const stationary = calculateAlgorithmEvidence({ ...qualifyingEvidence, rankMovement24h: 0 });
    const climbing = calculateAlgorithmEvidence({ ...qualifyingEvidence, rankMovement24h: 20 });

    expect(stationary.algorithmProof).toBe(true);
    expect(climbing.evidenceScore).toBeGreaterThan(stationary.evidenceScore);
  });
});

describe("deterministic recommendations", () => {
  it("produces distinct product concepts instead of generic workshops", () => {
    const recommendations = buildDeterministicRecommendations(DEFAULT_SETTINGS, [], [
      gameFixture(
        "2 Player Build a Rocket Base",
        "Team up with a friend, build machines together, and launch.",
        [tag("coreLoop", "Tycoon"), tag("social", "Cooperation")],
      ),
      gameFixture(
        "Catch 1 Billion Bugs",
        "Catch and collect rare bugs across the world.",
        [tag("coreLoop", "Collection")],
      ),
      gameFixture(
        "Chameleon Hide-and-Seek",
        "Paint and seek, blend into the room, and survive.",
        [tag("coreLoop", "Survival")],
      ),
    ]);

    const titles = recommendations.map(({ idea }) => idea.workingTitle);
    expect(titles[0]).toBe("2 Player Build a Rocket");
    expect(titles).toEqual(expect.arrayContaining(["Catch 1 Billion Bugs", "Paint to Hide!"]));
    expect(recommendations.every(({ idea }) => idea.alternativeTitles.length >= 2)).toBe(true);
    expect(recommendations.every(({ idea }) => !/workshop/i.test(`${idea.workingTitle} ${idea.pitch}`))).toBe(true);
    expect(recommendations.every(({ idea }) => idea.relevance.includes("discovery-breakout gate"))).toBe(true);
    expect(recommendations.every(({ idea }) => idea.relevance.includes("Durability is unverified"))).toBe(true);
  });
});

describe("medium-term durability", () => {
  it("keeps a one-day breakout explicitly unverified", () => {
    const result = calculateDurabilityAssessment(durabilityPoints([7_000, 10_000]));

    expect(result.durabilityStatus).toBe("unverified");
    expect(result.observedDailyWindows).toBe(1);
    expect(result.durabilityConfidence).toBeLessThan(60);
  });

  it("requires several positive daily windows and limited peak drawdown", () => {
    const result = calculateDurabilityAssessment(durabilityPoints([4_000, 6_000, 8_000, 10_000]));

    expect(result.durabilityStatus).toBe("durable");
    expect(result.positiveDailyWindows).toBe(3);
    expect(result.peakDrawdownPercent).toBe(0);
  });

  it("marks a sharp post-spike reversal as fragile", () => {
    const result = calculateDurabilityAssessment(durabilityPoints([6_000, 7_000, 8_000, 5_000]));

    expect(result.durabilityStatus).toBe("fragile");
    expect(result.peakDrawdownPercent).toBeGreaterThanOrEqual(35);
  });

  it("flags promotional title markers as possible event risk", () => {
    const result = calculateDurabilityAssessment(durabilityPoints([4_000, 6_000, 8_000, 10_000]), "[UPD] Example Game");

    expect(result.eventRisk).toBe(true);
    expect(result.durabilityWarnings.join(" ")).toMatch(/update|event/i);
  });
});

function tag(dimension: GameTag["dimension"], value: string): GameTag {
  return { dimension, tag: value, source: "automatic" };
}

function gameFixture(name: string, description: string, tags: GameTag[]): GameDatasetItem {
  const now = new Date("2026-08-10T10:00:00.000Z");
  const universeId = name.toLowerCase().replace(/\W+/g, "-");
  return {
    game: {
      universeId,
      rootPlaceId: universeId,
      name,
      normalizedTitle: name,
      description,
      creatorId: `${universeId}-creator`,
      creatorName: `${name} Studio`,
      creatorType: "Group",
      createdAt: new Date(now.getTime() - 30 * 86_400_000),
      updatedAt: now,
      firstSeenAt: new Date(now.getTime() - 24 * 3_600_000),
      lastSeenAt: now,
      thumbnailUrl: null,
      genre: null,
    },
    tags,
    snapshots: [
      { collectedAt: new Date(now.getTime() - 24 * 3_600_000), ccu: 7_000, visits: 1_000_000, favorites: 20_000, rank: 15, chart: "Top Trending" },
      { collectedAt: now, ccu: 10_000, visits: 1_500_000, favorites: 25_000, rank: 10, chart: "Top Trending" },
    ],
    analysis: {
      universeId,
      momentumScore: qualifyingEvidence.momentumScore,
      analyzedAt: now,
      metrics: {
        growth1h: 5,
        growth24h: qualifyingEvidence.growth24h,
        growth72h: 0,
        growth7d: 0,
        gain1h: 500,
        gain24h: qualifyingEvidence.gain24h,
        gain72h: 0,
        gain7d: 0,
        acceleration: 20,
        newVisits24h: qualifyingEvidence.newVisits24h,
        newFavorites24h: 5_000,
        rankMovement24h: qualifyingEvidence.rankMovement24h,
        ageDays: qualifyingEvidence.ageDays,
        persistence: qualifyingEvidence.persistence,
        momentum: { score: qualifyingEvidence.momentumScore, breakdown: [] },
      },
    },
  };
}

function durabilityPoints(ccuByDay: number[]) {
  const start = new Date("2026-08-07T10:00:00.000Z");
  return ccuByDay.map((ccu, index) => ({
    collectedAt: new Date(start.getTime() + index * 24 * 3_600_000),
    ccu,
  }));
}
