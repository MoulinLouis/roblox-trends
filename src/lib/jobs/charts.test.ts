import { describe, expect, it } from "vitest";
import { toChartPlacements } from "./charts";

describe("toChartPlacements", () => {
  it("ranks games from 1 and keeps the best rank of a repeated game", () => {
    const observedAt = new Date("2026-10-20T14:00:00Z");
    const placements = toChartPlacements("top-trending", [
      { universeId: 10, rootPlaceId: 1, name: "A", playerCount: 500, isSponsored: true },
      { universeId: 20, rootPlaceId: 2, name: "B", playerCount: 300.4 },
      { universeId: 10, rootPlaceId: 1, name: "A", playerCount: 500 },
    ], observedAt);
    expect(placements).toEqual([
      { sortId: "top-trending", universeId: 10, observedAt, rank: 1, playerCount: 500, isSponsored: true },
      { sortId: "top-trending", universeId: 20, observedAt, rank: 2, playerCount: 300, isSponsored: null },
    ]);
  });
});
