import { describe, expect, it } from "vitest";
import { chartLabel, discoveryLabel } from "./labels";

describe("labels", () => {
  it("names the discovery sorts", () => {
    expect(chartLabel("top-trending")).toBe("Top Trending");
    expect(chartLabel("trending-in-roleplay-and-avatar-sim")).toBe("Trending in Roleplay & Avatar Sim");
    expect(chartLabel("trending-in-rpg")).toBe("Trending in RPG");
    expect(chartLabel("fun-with-friends")).toBe("Fun with Friends");
  });

  it("describes how a game was found", () => {
    expect(discoveryLabel("rolimons", "")).toBe("Rolimon's list");
    expect(discoveryLabel("chart", "up-and-coming")).toBe("the Up & Coming chart");
    expect(discoveryLabel("search", "fake an egg")).toBe("a search for “fake an egg”");
    expect(discoveryLabel("recommendation", "10769384180")).toBe("recommendations from universe 10769384180");
  });
});
