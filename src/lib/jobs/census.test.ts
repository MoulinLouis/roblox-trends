import { describe, expect, it } from "vitest";
import type { RolimonsGame } from "@/lib/api/rolimons";
import { censusListFingerprint, evaluateCensusQuality, selectPlacesToResolve } from "./census";

function listed(placeId: string, ccu: number): RolimonsGame {
  return { placeId, name: `Place ${placeId}`, ccu, thumbnailUrl: "" };
}

describe("evaluateCensusQuality", () => {
  const limits = { maximumListSizeChange: 0.3, minimumListed: 1_000, maximumRejectedShare: 0.05 };

  function list(listed: number, rejected = 0) {
    return { listed, rejected };
  }

  it("accepts the first run", () => {
    expect(evaluateCensusQuality(list(7_800), null, limits)).toBe("success");
  });

  it("accepts normal variation", () => {
    expect(evaluateCensusQuality(list(7_000), 7_800, limits)).toBe("success");
  });

  it("accepts a change of exactly the maximum", () => {
    expect(evaluateCensusQuality(list(7_000), 10_000, limits)).toBe("success");
    expect(evaluateCensusQuality(list(13_000), 10_000, limits)).toBe("success");
  });

  it("flags a sudden drop", () => {
    expect(evaluateCensusQuality(list(4_000), 7_800, limits)).toBe("degraded");
  });

  it("flags a sudden growth", () => {
    expect(evaluateCensusQuality(list(11_000), 8_000, limits)).toBe("degraded");
  });

  it("flags an empty list", () => {
    expect(evaluateCensusQuality(list(0), null, limits)).toBe("degraded");
  });

  it("flags a list below the minimum even without a baseline", () => {
    expect(evaluateCensusQuality(list(999), null, limits)).toBe("degraded");
    expect(evaluateCensusQuality(list(999), 1_000, limits)).toBe("degraded");
  });

  it("accepts rejected entries up to the maximum share", () => {
    expect(evaluateCensusQuality(list(9_500, 500), null, limits)).toBe("success");
  });

  it("flags a list with a larger share of rejected entries, even when its size is stable", () => {
    expect(evaluateCensusQuality(list(9_000, 1_000), null, limits)).toBe("degraded");
    expect(evaluateCensusQuality(list(9_000, 1_000), 9_000, limits)).toBe("degraded");
  });
});

describe("censusListFingerprint", () => {
  it("does not depend on the order of the places", () => {
    expect(censusListFingerprint([listed("2", 20), listed("1", 10)])).toBe(
      censusListFingerprint([listed("1", 10), listed("2", 20)]),
    );
  });

  it("changes when a CCU, a place or the size of the list changes", () => {
    const base = censusListFingerprint([listed("1", 10), listed("2", 20)]);
    expect(censusListFingerprint([listed("1", 10), listed("2", 21)])).not.toBe(base);
    expect(censusListFingerprint([listed("1", 10), listed("3", 20)])).not.toBe(base);
    expect(censusListFingerprint([listed("1", 10)])).not.toBe(base);
  });
});

describe("selectPlacesToResolve", () => {
  it("keeps unknown places at or above the threshold, highest CCU first", () => {
    const games = [listed("1", 90), listed("2", 150), listed("3", 400), listed("4", 1_000)];
    expect(selectPlacesToResolve(games, new Set([4]), 100).map((game) => game.placeId)).toEqual(["3", "2"]);
  });
});
