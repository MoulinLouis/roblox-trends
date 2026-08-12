import { describe, expect, it } from "vitest";
import { buildScheduledJobSlots, floorToInterval, latestDailySlot } from "./scheduler";

describe("durable scheduler slots", () => {
  it("uses stable interval slots across repeated reconciliation ticks", () => {
    const first = new Date("2026-08-12T08:01:00Z");
    const retry = new Date("2026-08-12T08:59:00Z");
    expect(floorToInterval(first, 60)).toEqual(new Date("2026-08-12T08:00:00Z"));
    expect(floorToInterval(retry, 60)).toEqual(new Date("2026-08-12T08:00:00Z"));
  });

  it("uses the previous daily slot before the configured UTC hour", () => {
    expect(latestDailySlot(new Date("2026-08-12T04:59:00Z"), 5)).toEqual(
      new Date("2026-08-11T05:00:00Z"),
    );
    expect(latestDailySlot(new Date("2026-08-12T05:00:00Z"), 5)).toEqual(
      new Date("2026-08-12T05:00:00Z"),
    );
  });

  it("orders frontier discovery before collection, analysis, and daily work", () => {
    const slots = buildScheduledJobSlots(new Date("2026-08-12T09:17:00Z"), 60);
    expect(slots.map((slot) => slot.jobName)).toEqual([
      "frontier",
      "collect",
      "analyze",
      "brief",
      "report",
      "maintenance",
    ]);
    expect(slots[0].scheduledFor).toEqual(new Date("2026-08-12T09:15:00Z"));
    expect(slots[1].scheduledFor).toEqual(new Date("2026-08-12T09:00:00Z"));
    expect(slots[2].scheduledFor).toEqual(new Date("2026-08-12T08:00:00Z"));
    expect(slots[3].scheduledFor).toEqual(new Date("2026-08-12T05:00:00Z"));
  });
});
