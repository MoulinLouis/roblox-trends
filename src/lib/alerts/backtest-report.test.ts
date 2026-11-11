import { describe, expect, it } from "vitest";
import type { ReplayResult } from "./backtest";
import { formatBacktestReport } from "./backtest-report";

const decision = (universeId: number, kind: "wave" | "first_breakout", keys: string[], priors: Record<string, number[]> = {}) => ({
  kind,
  universeId,
  keys,
  priors,
});

describe("formatBacktestReport", () => {
  const result: ReplayResult = {
    pushes: [{ at: new Date("2026-10-21T10:56:30Z"), decision: decision(2, "wave", ["word:ragdoll", "word:zed"], { "word:ragdoll": [1], "word:zed": [1] }) }],
    firstBreakouts: [
      { at: new Date("2026-10-20T06:56:30Z"), decision: decision(1, "first_breakout", ["word:ragdoll"]) },
      { at: new Date("2026-10-20T06:56:30Z"), decision: decision(3, "first_breakout", ["template:{verb} for {reward}"]) },
    ],
    digests: [
      { day: "2026-10-20", sentAt: new Date("2026-10-20T06:56:30Z"), decisions: [decision(1, "first_breakout", []), decision(3, "first_breakout", [])] },
    ],
    weekly: [
      { week: "2026-10-19", pushes: 1, firstBreakouts: 2 },
      { week: "2026-10-26", pushes: 0, firstBreakouts: 0 },
    ],
  };
  const text = formatBacktestReport({
    result,
    from: new Date("2026-10-19T00:00:00Z"),
    to: new Date("2026-11-02T00:00:00Z"),
    wordsOnly: false,
    coverageFrom: new Date("2026-10-19T00:00:00Z"),
    trackedGames: 10,
    breakouts: 3,
    names: new Map([[1, "Ragdoll Alpha"], [2, "Ragdoll Beta"], [3, "Chop for Gold"]]),
    peaks: new Map([[1, 100], [3, 900]]),
    crossedAt: new Map([[1, new Date("2026-10-20T01:00:00Z")]]),
  });

  it("prints the header, weekly table and the averages of the full weeks", () => {
    expect(text).toContain("tracked games: 10, breakouts read: 3");
    expect(text).toContain("2026-10-19");
    expect(text).toContain("total pushes: 1");
    expect(text).toContain("pushes per week: 0.50");
    expect(text).toContain("full weeks from 2026-10-19 (2): pushes per week 0.50, digest games per day 0.14");
  });

  it("lists pushes with their prior games and dates, and digests with their top games by peak", () => {
    expect(text).toContain("2026-10-21 10:56  Ragdoll Beta (2)");
    expect(text).toContain("word:ragdoll: Ragdoll Alpha (2026-10-20)");
    expect(text).toContain("2026-10-20  2 games  top: Chop for Gold, Ragdoll Alpha");
  });

  it("reports the tracked patterns, with none for an absent one", () => {
    expect(text).toContain("word:ragdoll: first push 2026-10-21, first first breakout 2026-10-20");
    expect(text).toContain("template:{verb} for {reward}: first push none, first first breakout 2026-10-20");
    expect(text).toContain("other keys with ragdoll pushed: none");
  });
});
