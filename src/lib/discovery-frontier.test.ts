import { describe, expect, it } from "vitest";
import { evaluateDiscoveryFrontierGame } from "./discovery-frontier";

const NOW = new Date("2026-08-13T12:00:00Z");

describe("discovery frontier", () => {
  it("promotes a game growing quickly before it reaches 1k CCU", () => {
    const state = evaluateDiscoveryFrontierGame(game(850), {
      currentCcu: 550,
      peakCcu: 550,
      history: [point(1, 550)],
      firstSeenAt: hoursBefore(1),
      observations: 4,
    }, NOW);

    expect(state.qualifies).toBe(true);
    expect(state.gain1h).toBe(300);
    expect(state.growth1h).toBeGreaterThan(50);
  });

  it("immediately promotes an unseen game already above 1k CCU", () => {
    const state = evaluateDiscoveryFrontierGame(game(1_500), undefined, NOW);

    expect(state.qualifies).toBe(true);
    expect(state.observations).toBe(1);
  });

  it("keeps ordinary low-level games out of the enrichment queue", () => {
    const state = evaluateDiscoveryFrontierGame(game(500), {
      currentCcu: 480,
      peakCcu: 500,
      history: [point(1, 480)],
      firstSeenAt: hoursBefore(4),
      observations: 4,
    }, NOW);

    expect(state.qualifies).toBe(false);
  });
});

function game(ccu: number) {
  return { placeId: "123", name: "Candidate", ccu, thumbnailUrl: "https://example.com/game.webp" };
}

function point(hoursAgo: number, ccu: number) {
  return { at: hoursBefore(hoursAgo).toISOString(), ccu };
}

function hoursBefore(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}
