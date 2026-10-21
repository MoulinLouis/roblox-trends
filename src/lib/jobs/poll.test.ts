import { describe, expect, it } from "vitest";
import type { ActiveUniverse } from "@/db/active-set";
import { planPollRun } from "./poll";

const now = new Date("2026-10-20T14:07:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

// Active games arrive highest priority first, as selectActiveUniverses returns them.
function game(universeId: number, priority: number, lastDetailsAt: Date | null): ActiveUniverse {
  return { universeId, priority, lastDetailsAt };
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
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 2 }, now);
    expect(ids(plan.hot)).toEqual([1, 2]);
    expect(ids(plan.requested).slice(0, 2)).toEqual([1, 2]);
  });

  it("requests the tail games whose details are the oldest, never-detailed games first, lowest universe id on a tie", () => {
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 4 }, now);
    expect(ids(plan.tail)).toEqual([3, 4, 5, 6, 7]);
    expect(ids(plan.tailRequested)).toEqual([5, 4, 7, 3]);
    expect(ids(plan.requested)).toEqual([1, 2, 5, 4, 7, 3]);
  });

  it("caps the tail games requested per run", () => {
    const plan = planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 2 }, now);
    expect(plan.tail).toHaveLength(5);
    expect(ids(plan.tailRequested)).toEqual([5, 4]);
    expect(ids(plan.requested)).toEqual([1, 2, 5, 4]);
  });

  it("requests the whole tail when it fits the cap", () => {
    const plan = planPollRun(active, { hotUniverses: 5, tailUniversesPerRun: 10 }, now);
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 7, 6]);
  });

  it("has no tail when the active set fits the hot set", () => {
    const plan = planPollRun(active, { hotUniverses: 10, tailUniversesPerRun: 2 }, now);
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.tail).toEqual([]);
    expect(plan.tailRequested).toEqual([]);
    expect(plan.oldestTailDetailsMinutes).toBeNull();
  });

  it("reports the age of the oldest details among the tail games requested, skipping never-detailed games", () => {
    expect(planPollRun(active, { hotUniverses: 2, tailUniversesPerRun: 2 }, now).oldestTailDetailsMinutes).toBe(50);
    expect(planPollRun(active, { hotUniverses: 5, tailUniversesPerRun: 1 }, now).oldestTailDetailsMinutes).toBe(50);
    expect(planPollRun(active, { hotUniverses: 4, tailUniversesPerRun: 1 }, now).oldestTailDetailsMinutes).toBeNull();
  });

  it("plans nothing for an empty active set", () => {
    const plan = planPollRun([], { hotUniverses: 2, tailUniversesPerRun: 2 }, now);
    expect(plan).toEqual({ hot: [], tail: [], tailRequested: [], requested: [], oldestTailDetailsMinutes: null });
  });
});
