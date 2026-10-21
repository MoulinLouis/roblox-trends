import { describe, expect, it } from "vitest";
import { INTEGER_MAX, legacyCount, legacyDiscovery, parseLegacyId, sortIdFromLegacyChartLabel } from "./mapping";

describe("sortIdFromLegacyChartLabel", () => {
  it.each([
    ["Top Trending", "top-trending"],
    ["Up-and-Coming", "up-and-coming"],
    ["Trending in Sports & Racing", "trending-in-sports-and-racing"],
    ["Trending in Roleplay & Avatar Sim", "trending-in-roleplay-and-avatar-sim"],
    ["Trending in RPG", "trending-in-rpg"],
    ["Fun with Friends", "fun-with-friends"],
  ])("maps %s to %s", (label, sortId) => {
    expect(sortIdFromLegacyChartLabel(label)).toBe(sortId);
  });

  it("rejects labels that are not discovery charts", () => {
    expect(sortIdFromLegacyChartLabel("Direct tracking")).toBeNull();
    expect(sortIdFromLegacyChartLabel("Search: Defense")).toBeNull();
  });
});

describe("legacyDiscovery", () => {
  it("maps every v1 discovery source", () => {
    expect(legacyDiscovery("roblox-charts", "Top Earning")).toEqual({ source: "chart", detail: "top-earning" });
    expect(legacyDiscovery("roblox-search", "Search: Collection + Kitty")).toEqual({ source: "search", detail: "Collection + Kitty" });
    expect(legacyDiscovery("roblox-recommendations", "Recommendations from 10765298801")).toEqual({ source: "recommendation", detail: "10765298801" });
    expect(legacyDiscovery("rolimons", "Rolimon's discovery")).toEqual({ source: "rolimons", detail: "" });
  });

  it("ignores direct tracking and unknown sources", () => {
    expect(legacyDiscovery("roblox-tracked", "Direct tracking")).toBeNull();
    expect(legacyDiscovery("other", "x")).toBeNull();
  });
});

describe("parseLegacyId", () => {
  it("reads v1 text ids", () => {
    expect(parseLegacyId("10765298801")).toBe(10765298801);
  });

  it.each(["", " 1", "1.5", "-1", "1e3", "abc", "9007199254740993"])("rejects %j", (value) => {
    expect(parseLegacyId(value)).toBeNull();
  });
});

describe("legacyCount", () => {
  it("rounds v1 reals to the integers v2 stores", () => {
    expect(legacyCount(5_000_100.4)).toBe(5_000_100);
    expect(legacyCount(0)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 3.4e38])("rejects %d", (value) => {
    expect(legacyCount(value)).toBeNull();
  });

  it("rejects values above the column's maximum", () => {
    expect(legacyCount(INTEGER_MAX, INTEGER_MAX)).toBe(INTEGER_MAX);
    expect(legacyCount(INTEGER_MAX + 1, INTEGER_MAX)).toBeNull();
  });
});
