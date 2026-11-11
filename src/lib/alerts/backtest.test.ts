import { describe, expect, it } from "vitest";
import { replayAlerts } from "./backtest";
import type { Breakout } from "./types";

const at = (iso: string) => new Date(iso);
const breakout = (universeId: number, crossedAt: string, keys: string[]): Breakout => ({
  universeId,
  createdAt: at("2026-01-01T00:00:00Z"),
  crossedAt: at(crossedAt),
  keys,
  classified: true,
});

const from = at("2026-09-01T00:00:00Z");
const to = at("2026-09-20T00:00:00Z");

describe("replayAlerts", () => {
  it("makes the first crossing of a key a first breakout and the second a wave, then keeps the pattern silent", () => {
    const result = replayAlerts({
      breakouts: [
        breakout(1, "2026-09-02T10:00:00Z", ["word:ragdoll"]),
        breakout(2, "2026-09-04T10:00:00Z", ["word:ragdoll"]),
        breakout(3, "2026-09-06T10:00:00Z", ["word:ragdoll"]),
      ],
      from,
      to,
    });
    expect(result.firstBreakouts.map((entry) => entry.decision.universeId)).toEqual([1]);
    // The wave of game 2 puts the key in its cooldown, so the third crossing stays silent.
    expect(result.pushes.map((push) => [push.decision.universeId, push.at.toISOString().slice(0, 10)])).toEqual([[2, "2026-09-04"]]);
  });

  it("sends first breakouts in the next digest, at the job's run after 08:00 Paris time", () => {
    // Day 1: a game before 08:00 Paris (06:00 UTC is 08:00 CEST) sends day 1's digest at 08:56 Paris time.
    const result = replayAlerts({
      breakouts: [
        breakout(1, "2026-09-02T05:10:00Z", ["word:a"]),
        breakout(2, "2026-09-02T07:00:00Z", ["word:b"]),
      ],
      from,
      to,
    });
    expect(result.digests.map((digest) => [digest.day, digest.sentAt.toISOString(), digest.decisions.map((d) => d.universeId)])).toEqual([
      ["2026-09-02", "2026-09-02T06:56:30.000Z", [1]],
      ["2026-09-03", "2026-09-03T06:56:30.000Z", [2]],
    ]);
  });

  it("sends a lone first breakout of 09:00 Paris time the same day, as the job does", () => {
    const result = replayAlerts({ breakouts: [breakout(2, "2026-09-02T07:00:00Z", ["word:b"])], from, to });
    expect(result.digests.map((digest) => [digest.day, digest.sentAt.toISOString()])).toEqual([["2026-09-02", "2026-09-02T07:56:30.000Z"]]);
  });

  it("keeps decisions about games that crossed before from out of the report but uses them as past alerts", () => {
    const result = replayAlerts({
      breakouts: [
        breakout(1, "2026-08-31T10:00:00Z", ["word:a"]),
        breakout(2, "2026-09-01T10:00:00Z", ["word:a"]),
      ],
      from,
      to,
    });
    expect(result.firstBreakouts).toEqual([]);
    expect(result.digests).toEqual([]);
    expect(result.pushes.map((push) => push.decision.universeId)).toEqual([2]);
  });

  it("counts every week of the range, and the weekly counts add up", () => {
    const result = replayAlerts({
      breakouts: [
        breakout(1, "2026-09-02T10:00:00Z", ["word:ragdoll", "word:x"]),
        breakout(2, "2026-09-04T10:00:00Z", ["word:ragdoll"]),
        breakout(3, "2026-09-06T10:00:00Z", ["word:ragdoll"]),
        breakout(4, "2026-09-15T10:00:00Z", ["word:y"]),
        breakout(5, "2026-09-16T10:00:00Z", ["word:y"]),
      ],
      from,
      to,
    });
    expect(result.weekly.map((row) => row.week)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(result.weekly.reduce((sum, row) => sum + row.pushes, 0)).toBe(result.pushes.length);
    expect(result.weekly.reduce((sum, row) => sum + row.firstBreakouts, 0)).toBe(result.firstBreakouts.length);
    expect(result.pushes).toHaveLength(2);
    expect(result.firstBreakouts).toHaveLength(2);
    expect(result.weekly[1]).toEqual({ week: "2026-09-07", pushes: 0, firstBreakouts: 0 });
  });
});
