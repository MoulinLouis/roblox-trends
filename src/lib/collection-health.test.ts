import { describe, expect, it } from "vitest";
import {
  classifyCollectionHealth,
  detectCollectionHealthTransition,
  selectRotatingWindow,
} from "./collection-health";

describe("collection keyword rotation", () => {
  it("covers a stable window for retries in the same bucket", () => {
    const keywords = ["a", "b", "c", "d", "e", "f"];
    const first = selectRotatingWindow(keywords, 2, new Date("2026-08-12T03:02:00Z"), 60);
    const retry = selectRotatingWindow(keywords, 2, new Date("2026-08-12T03:58:00Z"), 60);
    expect(first).toEqual(retry);
  });

  it("rotates through every keyword across consecutive buckets", () => {
    const keywords = ["a", "b", "c", "d", "e", "f"];
    const selected = [0, 1, 2].flatMap((offset) =>
      selectRotatingWindow(keywords, 2, new Date(`2026-08-12T0${offset}:00:00Z`), 60),
    );
    expect(new Set(selected)).toEqual(new Set(keywords));
  });
});

describe("collection health", () => {
  it("treats optional discovery failures as degraded", () => {
    expect(classifyCollectionHealth({
      errors: [{ source: "roblox-search", message: "429" }],
      snapshots: 1_000,
      expectedCharts: 22,
      completedCharts: 22,
      expectedGames: 800,
      completedGames: 800,
    }).status).toBe("degraded");
  });

  it("treats missing game detail chunks as critical", () => {
    expect(classifyCollectionHealth({
      errors: [{ source: "roblox-games", message: "429" }],
      snapshots: 800,
      expectedCharts: 22,
      completedCharts: 22,
      expectedGames: 800,
      completedGames: 750,
    }).status).toBe("critical");
  });

  it("requires broad chart coverage", () => {
    expect(classifyCollectionHealth({
      errors: [],
      snapshots: 800,
      expectedCharts: 22,
      completedCharts: 10,
      expectedGames: 800,
      completedGames: 800,
    }).status).toBe("critical");
  });

  it("requires broad game-detail coverage", () => {
    expect(classifyCollectionHealth({
      errors: [],
      snapshots: 700,
      expectedCharts: 22,
      completedCharts: 22,
      expectedGames: 1_000,
      completedGames: 700,
    }).status).toBe("critical");
  });
});

describe("collection health alerts", () => {
  it("alerts immediately when collection becomes critical", () => {
    expect(detectCollectionHealthTransition(["critical", "healthy"])).toBe("critical");
    expect(detectCollectionHealthTransition(["critical", "critical"])).toBeNull();
  });

  it("waits for two consecutive degraded attempts", () => {
    expect(detectCollectionHealthTransition(["degraded", "healthy"])).toBeNull();
    expect(detectCollectionHealthTransition(["degraded", "degraded", "healthy"])).toBe("degraded");
    expect(detectCollectionHealthTransition(["degraded", "degraded", "degraded"])).toBeNull();
  });

  it("announces recovery from an unhealthy attempt", () => {
    expect(detectCollectionHealthTransition(["healthy", "critical"])).toBe("recovered");
    expect(detectCollectionHealthTransition(["healthy", "healthy"])).toBeNull();
  });
});
