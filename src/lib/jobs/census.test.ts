import { describe, expect, it } from "vitest";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { evaluateCensusQuality, selectPlacesToResolve } from "./census";

function listed(placeId: string, ccu: number): RolimonsGame {
  return { placeId, name: `Place ${placeId}`, ccu, thumbnailUrl: "" };
}

describe("evaluateCensusQuality", () => {
  it("accepts the first run", () => {
    expect(evaluateCensusQuality(7_800, null, 0.3)).toBe("success");
  });

  it("accepts normal variation", () => {
    expect(evaluateCensusQuality(7_000, 7_800, 0.3)).toBe("success");
  });

  it("flags a sudden drop", () => {
    expect(evaluateCensusQuality(4_000, 7_800, 0.3)).toBe("degraded");
  });

  it("flags an empty list", () => {
    expect(evaluateCensusQuality(0, null, 0.3)).toBe("degraded");
  });
});

describe("selectPlacesToResolve", () => {
  it("keeps unknown places at or above the threshold, highest CCU first", () => {
    const games = [listed("1", 90), listed("2", 150), listed("3", 400), listed("4", 1_000)];
    expect(selectPlacesToResolve(games, new Set([4]), 100).map((game) => game.placeId)).toEqual(["3", "2"]);
  });
});
