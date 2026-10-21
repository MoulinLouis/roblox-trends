import { describe, expect, it } from "vitest";
import type { ActiveUniverse } from "@/db/active-set";
import { oldestTailDetailsMinutes, planPollRun } from "./poll";

const now = new Date("2026-10-20T14:07:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

// Active games arrive highest priority first, as selectActiveUniverses returns them. A game's latest details request
// is its details time unless a later request went unanswered.
function game(
  universeId: number,
  priority: number,
  lastDetailsAt: Date | null,
  lastDetailsRequestAt: Date | null = lastDetailsAt,
): ActiveUniverse {
  return { universeId, priority, lastDetailsAt, lastDetailsRequestAt };
}

function ids(games: readonly ActiveUniverse[]): number[] {
  return games.map((item) => item.universeId);
}

describe("planPollRun", () => {
  const active = [
    game(1, 900, minutesAgo(0)),
    game(2, 800, minutesAgo(0)),
    game(3, 700, minutesAgo(30)),
    game(4, 600, minutesAgo(50)),
    game(5, 500, null),
    game(6, 400, minutesAgo(10)),
    game(7, 300, minutesAgo(50)),
  ];

  it("requests the hot set first, in priority order, even when its details are the freshest", () => {
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 2 });
    expect(ids(plan.hot)).toEqual([1, 2]);
    expect(ids(plan.requested).slice(0, 2)).toEqual([1, 2]);
  });

  it("requests the tail games whose details are the oldest, never-detailed games first, lowest universe id on a tie", () => {
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 4 });
    expect(ids(plan.tail)).toEqual([3, 4, 5, 6, 7]);
    expect(ids(plan.tailRequested)).toEqual([5, 4, 7, 3]);
    expect(ids(plan.requested)).toEqual([1, 2, 5, 4, 7, 3]);
  });

  it("orders the tail on the latest details request, so a game Roblox did not answer waits behind the others", () => {
    // Game 4 was requested 5 minutes ago and not answered: its details are 26 days old, but it is due after game 6.
    // Game 5 was requested once and never answered: it no longer heads the tail.
    const plan = planPollRun(
      [
        game(1, 900, minutesAgo(0)),
        game(3, 700, minutesAgo(30)),
        game(4, 600, minutesAgo(26 * 24 * 60), minutesAgo(5)),
        game(5, 500, null, minutesAgo(20)),
        game(6, 400, minutesAgo(10)),
      ],
      { hotUniverses: 1, tailUniversesPerRun: 4 },
    );
    expect(ids(plan.tailRequested)).toEqual([3, 5, 6, 4]);
  });

  it("caps the tail games requested per run", () => {
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 2 });
    expect(plan.tail).toHaveLength(5);
    expect(ids(plan.tailRequested)).toEqual([5, 4]);
    expect(ids(plan.requested)).toEqual([1, 2, 5, 4]);
  });

  it("requests the whole tail when it fits the cap", () => {
    const plan = planPollRun(active, { hotUniverses: 5, tailUniversesPerRun: 10 });
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 7, 6]);
  });

  it("has no tail when the active set fits the hot set", () => {
    const plan = planPollRun(active, { hotUniverses: 10, tailUniversesPerRun: 2 });
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.tail).toEqual([]);
    expect(plan.tailRequested).toEqual([]);
  });

  it("plans nothing for an empty active set", () => {
    const plan = planPollRun([], { hotUniverses: 2, tailUniversesPerRun: 2 });
    expect(plan).toEqual({ hot: [], tail: [], tailRequested: [], requested: [] });
  });
});

describe("oldestTailDetailsMinutes", () => {
  const tailRequested = [
    game(5, 500, null),
    game(8, 450, minutesAgo(26 * 24 * 60), minutesAgo(30)),
    game(4, 600, minutesAgo(50)),
    game(7, 300, minutesAgo(40)),
  ];

  it("reports the age of the oldest details among the tail games requested, skipping never-detailed games", () => {
    expect(oldestTailDetailsMinutes(tailRequested, new Set(), now)).toBe(26 * 24 * 60);
    expect(oldestTailDetailsMinutes(tailRequested.slice(2), new Set(), now)).toBe(50);
    expect(oldestTailDetailsMinutes(tailRequested.slice(0, 1), new Set(), now)).toBeNull();
    expect(oldestTailDetailsMinutes([], new Set(), now)).toBeNull();
  });

  it("leaves out the games Roblox did not answer, whose details stay old forever", () => {
    expect(oldestTailDetailsMinutes(tailRequested, new Set([8]), now)).toBe(50);
    expect(oldestTailDetailsMinutes(tailRequested, new Set([8, 4]), now)).toBe(40);
    expect(oldestTailDetailsMinutes(tailRequested, new Set([8, 4, 7]), now)).toBeNull();
  });

  it("never reports a negative age", () => {
    expect(oldestTailDetailsMinutes([game(9, 100, new Date(now.getTime() + 60_000))], new Set(), now)).toBe(0);
  });
});
