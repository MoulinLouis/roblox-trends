import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatCount,
  formatDay,
  formatElapsed,
  formatHours,
  formatMultiplier,
  formatPercent,
  formatUtc,
} from "./format";

const now = new Date("2026-10-22T10:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("format", () => {
  it("formats counts and shows a dash for missing values", () => {
    expect(formatCount(12_345.6)).toBe("12,346");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("formats compact numbers", () => {
    expect(formatCompact(1_000)).toBe("1K");
    expect(formatCompact(12_345)).toBe("12.3K");
    expect(formatCompact(null)).toBe("—");
  });

  it("formats multipliers with the precision their size needs", () => {
    expect(formatMultiplier(3.006)).toBe("×3.0");
    expect(formatMultiplier(0.7516)).toBe("×0.75");
    expect(formatMultiplier(12.4)).toBe("×12");
    expect(formatMultiplier(null)).toBe("—");
  });

  it("formats shares as percentages", () => {
    expect(formatPercent(0.9633)).toBe("96.3%");
    expect(formatPercent(0.003, 2)).toBe("0.30%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats elapsed time like radar status", () => {
    expect(formatElapsed(minutesAgo(3), now)).toBe("3m");
    expect(formatElapsed(minutesAgo(119), now)).toBe("119m");
    expect(formatElapsed(minutesAgo(120), now)).toBe("2h");
    expect(formatElapsed(minutesAgo(47 * 60), now)).toBe("47h");
    expect(formatElapsed(minutesAgo(48 * 60), now)).toBe("2d");
    // A clock skew never prints a negative age.
    expect(formatElapsed(new Date(now.getTime() + 60_000), now)).toBe("0m");
  });

  it("formats durations in hours", () => {
    expect(formatHours(8)).toBe("8h");
    expect(formatHours(47.6)).toBe("48h");
    expect(formatHours(72)).toBe("3.0d");
    expect(formatHours(null)).toBe("—");
  });

  it("formats instants in UTC", () => {
    expect(formatUtc(new Date("2026-10-21T23:13:30Z"))).toBe("2026-10-21 23:13 UTC");
    expect(formatDay(new Date("2026-10-21T23:13:30Z"))).toBe("Oct 21");
  });
});
