import { describe, expect, it } from "vitest";
import { ALERT_CONFIG } from "../config";
import { decideAlerts as decide } from "./decide";
import type { Breakout, PastAlert } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-11T12:00:00Z");

function at(daysAgo: number, hoursAgo = 0): Date {
  return new Date(NOW.getTime() - daysAgo * DAY - hoursAgo * HOUR);
}

function breakout(universeId: number, crossedAt: Date, keys: string[], classified = true): Breakout {
  return { universeId, createdAt: new Date(crossedAt.getTime() - 3 * DAY), crossedAt, keys, classified };
}

function pastAlert(kind: PastAlert["kind"], universeId: number, keys: string[], createdAt: Date): PastAlert {
  return { kind, universeId, keys, createdAt };
}

const KEY = "word:ragdoll";

// These tests are about the decision rules (a wave for the 2nd and 3rd breakout within 14 days), not the values
// ALERT_CONFIG is tuned to, so they pin the ranks and the window.
const PINNED = { ...ALERT_CONFIG, waveRanks: [2, 3], waveWindowDays: 14 } as unknown as typeof ALERT_CONFIG;
const decideAlerts = (input: Parameters<typeof decide>[0]) => decide(input, PINNED);

describe("decideAlerts", () => {
  it("gives a first_breakout for the first breakout of a key", () => {
    const decisions = decideAlerts({ breakouts: [breakout(1, at(0, 2), [KEY])], pastAlerts: [], now: NOW });
    expect(decisions).toEqual([{ kind: "first_breakout", universeId: 1, keys: [KEY], priors: { [KEY]: [] } }]);
  });

  it("gives waves to the 2nd and 3rd breakouts within 14 days and none to the 4th, each judged on its own", () => {
    const crossings = [at(10), at(6), at(3), at(1)];
    const breakouts = crossings.map((crossedAt, index) => breakout(index + 1, crossedAt, [KEY]));
    const kinds = crossings.map((crossedAt) =>
      decideAlerts({ breakouts, pastAlerts: [], now: new Date(crossedAt.getTime() + HOUR) }).map((d) => d.kind),
    );
    expect(kinds).toEqual([["first_breakout"], ["wave"], ["wave"], []]);
  });

  it("gives the wave of the 2nd breakout with its priors", () => {
    const breakouts = [breakout(1, at(5), [KEY]), breakout(2, at(0, 1), [KEY])];
    expect(decideAlerts({ breakouts, pastAlerts: [], now: NOW })).toEqual([
      { kind: "wave", universeId: 2, keys: [KEY], priors: { [KEY]: [1] } },
    ]);
  });

  it("gives no wave to a 2nd breakout 15 days after the first", () => {
    const breakouts = [breakout(1, at(15, 1), [KEY]), breakout(2, at(0, 1), [KEY])];
    expect(decideAlerts({ breakouts, pastAlerts: [], now: NOW })).toEqual([]);
  });

  it("silences a key pushed as a wave 10 days ago, but not one pushed 31 days ago", () => {
    const breakouts = [breakout(1, at(5), [KEY]), breakout(2, at(0, 1), [KEY])];
    const blocked = [pastAlert("wave", 9, [KEY], at(10))];
    const expired = [pastAlert("wave", 9, [KEY], at(31))];
    expect(decideAlerts({ breakouts, pastAlerts: blocked, now: NOW })).toEqual([]);
    expect(decideAlerts({ breakouts, pastAlerts: expired, now: NOW }).map((d) => d.kind)).toEqual(["wave"]);
  });

  it("gives no wave to a 3rd breakout when the 2nd's wave was pushed 5 days ago", () => {
    const breakouts = [breakout(1, at(8), [KEY]), breakout(2, at(5), [KEY]), breakout(3, at(0, 1), [KEY])];
    const pastAlerts = [pastAlert("wave", 2, [KEY], at(5))];
    expect(decideAlerts({ breakouts, pastAlerts, now: NOW })).toEqual([]);
  });

  it("pushes a key at most once within one call", () => {
    const breakouts = [breakout(1, at(8), [KEY]), breakout(2, at(0, 3), [KEY]), breakout(3, at(0, 1), [KEY])];
    const decisions = decideAlerts({ breakouts, pastAlerts: [], now: NOW });
    expect(decisions.map((d) => [d.kind, d.universeId])).toEqual([["wave", 2]]);
  });

  it("gives a game at most one wave in one call, even through another key", () => {
    const breakouts = [
      breakout(1, at(8), ["word:a", "word:b"]),
      breakout(2, at(7), ["word:a"]),
      breakout(3, at(0, 3), ["word:a", "word:b"]),
    ];
    const decisions = decideAlerts({ breakouts, pastAlerts: [], now: NOW });
    expect(decisions).toEqual([
      { kind: "wave", universeId: 3, keys: ["word:a", "word:b"], priors: { "word:a": [1, 2], "word:b": [1] } },
    ]);
  });

  it("ignores a prior breakout 61 days before the candidate", () => {
    const breakouts = [breakout(1, at(61, 1), [KEY]), breakout(2, at(0, 1), [KEY])];
    const decisions = decideAlerts({ breakouts, pastAlerts: [], now: NOW });
    expect(decisions).toEqual([{ kind: "first_breakout", universeId: 2, keys: [KEY], priors: { [KEY]: [] } }]);
  });

  it("orders by crossing, not by creation", () => {
    const a = breakout(1, at(0, 1), [KEY]);
    const b = { ...breakout(2, at(0, 5), [KEY]), createdAt: new Date(a.createdAt.getTime() - 10 * DAY) };
    const decisions = decideAlerts({ breakouts: [a, b], pastAlerts: [], now: NOW });
    expect(decisions).toEqual([
      { kind: "first_breakout", universeId: 2, keys: [KEY], priors: { [KEY]: [] } },
      { kind: "wave", universeId: 1, keys: [KEY], priors: { [KEY]: [2] } },
    ]);
  });

  it("breaks a tie on the crossing time by universe id", () => {
    const crossedAt = at(0, 1);
    const decisions = decideAlerts({
      breakouts: [breakout(7, crossedAt, [KEY]), breakout(3, crossedAt, [KEY])],
      pastAlerts: [],
      now: NOW,
    });
    expect(decisions.map((d) => [d.kind, d.universeId])).toEqual([
      ["first_breakout", 3],
      ["wave", 7],
    ]);
  });

  it("blocks a second first_breakout and a second wave for the same game", () => {
    const first = [breakout(1, at(0, 1), [KEY])];
    const blockedFirst = [pastAlert("first_breakout", 1, [KEY], at(0, 1))];
    expect(decideAlerts({ breakouts: first, pastAlerts: blockedFirst, now: NOW })).toEqual([]);

    const second = [breakout(1, at(5), [KEY]), breakout(2, at(0, 1), [KEY])];
    const blockedWave = [pastAlert("wave", 2, ["word:other"], at(40))];
    expect(decideAlerts({ breakouts: second, pastAlerts: blockedWave, now: NOW })).toEqual([]);
  });

  it("can give both kinds to one candidate, wave first", () => {
    const breakouts = [breakout(1, at(5), ["word:a"]), breakout(2, at(0, 1), ["word:a", "word:b"])];
    expect(decideAlerts({ breakouts, pastAlerts: [], now: NOW })).toEqual([
      { kind: "wave", universeId: 2, keys: ["word:a"], priors: { "word:a": [1] } },
      { kind: "first_breakout", universeId: 2, keys: ["word:b"], priors: { "word:b": [] } },
    ]);
  });

  it("skips an unclassified candidate 3 hours after its crossing, then keeps only its word keys", () => {
    const keys = [KEY, "action:racing|drive", "template:obby"];
    const early = [breakout(1, at(0, 3), keys, false)];
    expect(decideAlerts({ breakouts: early, pastAlerts: [], now: NOW })).toEqual([]);
    const late = [breakout(1, at(0, 13), keys, false)];
    expect(decideAlerts({ breakouts: late, pastAlerts: [], now: NOW })).toEqual([
      { kind: "first_breakout", universeId: 1, keys: [KEY], priors: { [KEY]: [] } },
    ]);
  });

  it("counts a prior breakout under every key it carries", () => {
    const breakouts = [breakout(1, at(5), ["template:obby"], false), breakout(2, at(0, 1), ["template:obby"])];
    expect(decideAlerts({ breakouts, pastAlerts: [], now: NOW }).map((d) => d.kind)).toEqual(["wave"]);
  });

  it("does not take a breakout that crossed 49 hours ago as a candidate", () => {
    expect(decideAlerts({ breakouts: [breakout(1, at(0, 49), [KEY])], pastAlerts: [], now: NOW })).toEqual([]);
  });

  it("lists the earlier breakouts' universe ids per key in crossing order", () => {
    const breakouts = [
      breakout(30, at(4), ["word:a"]),
      breakout(10, at(6), ["word:a", "word:b"]),
      breakout(20, at(5), ["word:b"]),
      breakout(40, at(0, 1), ["word:a", "word:b"]),
    ];
    const [decision] = decideAlerts({ breakouts, pastAlerts: [], now: NOW });
    expect(decision.priors).toEqual({ "word:a": [10, 30], "word:b": [10, 20] });
  });

  it("follows the tuned ranks and window by default: a wave for the 3rd breakout within a week only", () => {
    const within = [breakout(1, at(6), [KEY]), breakout(2, at(3), [KEY]), breakout(3, at(0, 1), [KEY])];
    expect(decide({ breakouts: within, pastAlerts: [], now: NOW })).toEqual([
      { kind: "wave", universeId: 3, keys: [KEY], priors: { [KEY]: [1, 2] } },
    ]);
    const second = [breakout(1, at(3), [KEY]), breakout(2, at(0, 1), [KEY])];
    expect(decide({ breakouts: second, pastAlerts: [], now: NOW })).toEqual([]);
    const slow = [breakout(1, at(9), [KEY]), breakout(2, at(5), [KEY]), breakout(3, at(0, 1), [KEY])];
    expect(decide({ breakouts: slow, pastAlerts: [], now: NOW })).toEqual([]);
  });
});
