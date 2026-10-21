import { describe, expect, it } from "vitest";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { evaluateCensusQuality, selectPlacesToResolve } from "./census";

function listed(placeId: string, ccu: number): RolimonsGame {
  return { placeId, name: `Place ${placeId}`, ccu, thumbnailUrl: "" };
}

describe("evaluateCensusQuality", () => {
  const limits = { maximumChange: 0.3, minimumListed: 1_000 };

  it("accepts the first run", () => {
    expect(evaluateCensusQuality(7_800, null, limits)).toBe("success");
  });

  it("accepts normal variation", () => {
    expect(evaluateCensusQuality(7_000, 7_800, limits)).toBe("success");
  });

  it("accepts a change of exactly the maximum", () => {
    expect(evaluateCensusQuality(7_000, 10_000, limits)).toBe("success");
    expect(evaluateCensusQuality(13_000, 10_000, limits)).toBe("success");
  });

  it("flags a sudden drop", () => {
    expect(evaluateCensusQuality(4_000, 7_800, limits)).toBe("degraded");
  });

  it("flags a sudden growth", () => {
    expect(evaluateCensusQuality(11_000, 8_000, limits)).toBe("degraded");
  });

  it("flags an empty list", () => {
    expect(evaluateCensusQuality(0, null, limits)).toBe("degraded");
  });

  it("flags a list below the minimum even without a baseline", () => {
    expect(evaluateCensusQuality(999, null, limits)).toBe("degraded");
    expect(evaluateCensusQuality(999, 1_000, limits)).toBe("degraded");
  });
});

describe("selectPlacesToResolve", () => {
  it("keeps unknown places at or above the threshold, highest CCU first", () => {
    const games = [listed("1", 90), listed("2", 150), listed("3", 400), listed("4", 1_000)];
    expect(selectPlacesToResolve(games, new Set([4]), 100).map((game) => game.placeId)).toEqual(["3", "2"]);
  });
});
