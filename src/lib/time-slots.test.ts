import { describe, expect, it } from "vitest";
import { floorToSlot } from "./time-slots";

describe("floorToSlot", () => {
  it("floors to the start of a five-minute slot", () => {
    expect(floorToSlot(new Date("2026-10-20T14:07:59.999Z"), 5).toISOString()).toBe("2026-10-20T14:05:00.000Z");
  });

  it("keeps an exact slot boundary", () => {
    expect(floorToSlot(new Date("2026-10-20T14:10:00.000Z"), 10).toISOString()).toBe("2026-10-20T14:10:00.000Z");
  });

  it("floors hourly slots", () => {
    expect(floorToSlot(new Date("2026-10-20T14:59:00.000Z"), 60).toISOString()).toBe("2026-10-20T14:00:00.000Z");
  });

  it("rejects a non-positive slot size", () => {
    expect(() => floorToSlot(new Date(), 0)).toThrow();
  });
});
