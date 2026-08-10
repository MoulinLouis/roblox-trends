import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./config";
import { assessDecisionReadiness, calculateVerifiedWindow } from "./agent-brief";
import type { GameSnapshotPoint } from "./types";

describe("agent decision readiness", () => {
  it("caps confidence while less than one daily cycle is available", () => {
    const result = assessDecisionReadiness({
      historyHours: 20,
      freshnessMinutes: 10,
      collectionIntervalMinutes: 30,
      coverage: { oneHour: 90, twentyFourHours: 0, seventyTwoHours: 0, sevenDays: 0 },
    });
    expect(result.level).toBe("collecting");
    expect(result.confidenceCap).toBe(30);
  });

  it("requires meaningful seven-day coverage for strong readiness", () => {
    const result = assessDecisionReadiness({
      historyHours: 190,
      freshnessMinutes: 10,
      collectionIntervalMinutes: 30,
      coverage: { oneHour: 95, twentyFourHours: 80, seventyTwoHours: 60, sevenDays: 35 },
    });
    expect(result.level).toBe("strong");
    expect(result.confidenceCap).toBe(100);
  });
});

describe("verified evidence windows", () => {
  it("does not label a short observation as 24-hour growth", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const points = [point(now, 4, 100), point(now, 0, 200)];
    expect(calculateVerifiedWindow(points, 24, DEFAULT_SETTINGS)).toBeNull();
  });

  it("calculates growth only when the requested baseline exists", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const points = [point(now, 24, 100), point(now, 0, 200)];
    const result = calculateVerifiedWindow(points, 24, DEFAULT_SETTINGS);
    expect(result?.growth).toBe(100);
    expect(result?.gain).toBe(100);
  });
});

function point(now: Date, hoursAgo: number, ccu: number): GameSnapshotPoint {
  return {
    collectedAt: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
    ccu,
    visits: ccu * 100,
    favorites: ccu * 10,
    rank: 50,
  };
}
