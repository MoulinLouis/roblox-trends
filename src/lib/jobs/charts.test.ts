import { describe, expect, it } from "vitest";
import type { RobloxSortGame } from "@/lib/api/roblox";
import { toChartPlacements } from "./charts";

const observedAt = new Date("2026-10-20T14:00:00Z");

function listed(universeId: number, position: number, overrides: Partial<RobloxSortGame> = {}): RobloxSortGame {
  return { universeId, rootPlaceId: universeId * 10, name: `Game ${universeId}`, playerCount: 100, position, ...overrides };
}

function ranks(games: RobloxSortGame[]) {
  return toChartPlacements("top-trending", games, observedAt).map((row) => [row.universeId, row.rank, row.isSponsored]);
}

describe("toChartPlacements", () => {
  it("ranks each game at its listed position and rounds its player count", () => {
    // Position 2 was a malformed entry: the rank keeps its gap.
    expect(toChartPlacements("top-trending", [listed(10, 1, { isSponsored: false }), listed(20, 3, { playerCount: 300.4 })], observedAt)).toEqual([
      { sortId: "top-trending", universeId: 10, observedAt, rank: 1, playerCount: 100, isSponsored: false },
      { sortId: "top-trending", universeId: 20, observedAt, rank: 3, playerCount: 300, isSponsored: null },
    ]);
  });

  it("keeps the organic placement of a game also listed as sponsored", () => {
    expect(ranks([listed(10, 1, { isSponsored: true }), listed(20, 2), listed(10, 3, { isSponsored: false })])).toEqual([
      [20, 2, null],
      [10, 3, false],
    ]);
    // A placement whose flag is unknown counts as organic.
    expect(ranks([listed(10, 1, { isSponsored: true }), listed(10, 2)])).toEqual([[10, 2, null]]);
    expect(ranks([listed(10, 1), listed(10, 2, { isSponsored: true })])).toEqual([[10, 1, null]]);
  });

  it("keeps the first placement of a game listed twice the same way", () => {
    expect(ranks([listed(10, 1, { isSponsored: false }), listed(10, 2, { isSponsored: false })])).toEqual([[10, 1, false]]);
    expect(ranks([listed(10, 1, { isSponsored: true }), listed(10, 2, { isSponsored: true })])).toEqual([[10, 1, true]]);
  });
});
