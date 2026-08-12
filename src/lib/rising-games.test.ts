import { describe, expect, it } from "vitest";
import { detectRisingGameSignal } from "./rising-games";
import type { GameSnapshotPoint } from "./types";

const NOW = new Date("2026-08-13T12:00:00Z");

describe("rising game detection", () => {
  it("detects a recent game accelerating through the 1k CCU milestone", () => {
    const signal = detectRisingGameSignal({
      universeId: "launch",
      name: "Tiny Factory",
      createdAt: hoursBefore(48),
      firstSeenAt: hoursBefore(8),
      snapshots: [point(6, 420), point(3, 720), point(1, 930), point(0, 1_480)],
    }, NOW);

    expect(signal?.signalType).toBe("launch_breakout");
    expect(signal?.metrics.crossedMilestone).toBe(1_000);
    expect(signal?.metrics.strongestWindow?.gain).toBeGreaterThanOrEqual(500);
    expect(signal?.reasons.join(" ")).toContain("Crossed 1,000");
  });

  it("detects a game discovered at meaningful scale before a full baseline exists", () => {
    const signal = detectRisingGameSignal({
      universeId: "rapid",
      name: "Instant Obby",
      createdAt: hoursBefore(12),
      firstSeenAt: hoursBefore(2),
      snapshots: [point(2, 1_100), point(0, 3_200)],
    }, NOW);

    expect(signal?.signalType).toBe("launch_breakout");
    expect(signal?.confidence).toBe("early");
    expect(signal?.reasons).toContain("Reached meaningful demand within the first observed hours");
  });

  it("detects an old game establishing a new high against its recent history", () => {
    const signal = detectRisingGameSignal({
      universeId: "resurgence",
      name: "Classic Survival",
      createdAt: hoursBefore(24 * 900),
      firstSeenAt: hoursBefore(80),
      snapshots: [
        point(72, 900),
        point(48, 850),
        point(30, 1_000),
        point(24, 1_100),
        point(6, 1_350),
        point(0, 3_100),
      ],
    }, NOW);

    expect(signal?.signalType).toBe("resurgence");
    expect(signal?.metrics.newHighSinceTracking).toBe(true);
    expect(signal?.metrics.medianMultiple).toBeGreaterThan(2);
    expect(signal?.reasons.join(" ")).toContain("new high");
  });

  it("does not call ordinary high CCU demand a resurgence without relative movement", () => {
    const signal = detectRisingGameSignal({
      universeId: "flat",
      name: "Stable Classic",
      createdAt: hoursBefore(24 * 1_000),
      firstSeenAt: hoursBefore(80),
      snapshots: [point(72, 8_000), point(48, 8_200), point(24, 7_900), point(6, 8_100), point(0, 8_250)],
    }, NOW);

    expect(signal).toBeNull();
  });

  it("labels update-driven breakouts as risk instead of silently discarding them", () => {
    const signal = detectRisingGameSignal({
      universeId: "event",
      name: "[UPDATE] Arena",
      createdAt: hoursBefore(24 * 400),
      firstSeenAt: hoursBefore(80),
      snapshots: [point(72, 700), point(48, 800), point(24, 850), point(6, 1_000), point(0, 4_500)],
    }, NOW);

    expect(signal?.signalType).toBe("resurgence");
    expect(signal?.risks.join(" ")).toContain("temporary event");
  });
});

function point(hoursAgo: number, ccu: number): GameSnapshotPoint {
  return {
    collectedAt: hoursBefore(hoursAgo),
    ccu,
    visits: ccu * 1_000,
    favorites: ccu * 10,
    rank: ccu >= 1_000 ? 25 : null,
    chart: ccu >= 1_000 ? "Top Trending" : "Direct tracking",
  };
}

function hoursBefore(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}
