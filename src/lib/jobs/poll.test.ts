import { describe, expect, it } from "vitest";
import type { ActiveUniverse } from "@/db/active-set";
import { medianTailDetailsMinutes, medianTailDetailsMinutesByLane, planPollRun, type PollLimits, tailLane } from "./poll";

const now = new Date("2026-10-20T14:07:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

const young = new Date("2026-10-10T00:00:00Z");
const established = new Date("2025-01-01T00:00:00Z");

// Active games arrive highest priority first, as selectActiveUniverses returns them. A game's latest details request
// is its details time unless a later request went unanswered. Games are young unless a test says otherwise.
function game(
  universeId: number,
  priority: number,
  lastDetailsAt: Date | null,
  lastDetailsRequestAt: Date | null = lastDetailsAt,
  robloxCreatedAt: Date = young,
): ActiveUniverse {
  return { universeId, priority, robloxCreatedAt, lastDetailsAt, lastDetailsRequestAt };
}

// A young tail game is due every 30 minutes and an established one every 4 hours.
function limits(hotUniverses: number, tailUniversesPerRun: number): PollLimits {
  return {
    hotUniverses,
    tailUniversesPerRun,
    youngMaximumAgeDays: 90,
    tailRefreshMinutes: { young: 30, established: 240 },
  };
}

function ids(games: readonly { universeId: number }[]): number[] {
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
    const plan = planPollRun(active, limits(2, 2), now);
    expect(ids(plan.hot)).toEqual([1, 2]);
    expect(ids(plan.requested).slice(0, 2)).toEqual([1, 2]);
  });

  it("requests the tail games whose details are the oldest, never-detailed games first, lowest universe id on a tie", () => {
    const plan = planPollRun(active, limits(2, 4), now);
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
      limits(1, 4),
      now,
    );
    expect(ids(plan.tailRequested)).toEqual([3, 5, 6, 4]);
  });

  it("caps the tail games requested per run", () => {
    const plan = planPollRun(active, limits(2, 2), now);
    expect(plan.tail).toHaveLength(5);
    expect(ids(plan.tailRequested)).toEqual([5, 4]);
    expect(ids(plan.requested)).toEqual([1, 2, 5, 4]);
  });

  it("requests the whole tail when it fits the cap", () => {
    const plan = planPollRun(active, limits(5, 10), now);
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 7, 6]);
  });

  it("has no tail when the active set fits the hot set", () => {
    const plan = planPollRun(active, limits(10, 2), now);
    expect(ids(plan.requested)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.tail).toEqual([]);
    expect(plan.tailRequested).toEqual([]);
  });

  it("plans nothing for an empty active set", () => {
    const plan = planPollRun([], limits(2, 2), now);
    expect(plan).toEqual({ hot: [], candidates: [], tail: [], tailRequested: [], requested: [] });
  });

  it("requests the promotion candidates after the hot set, in place of as many tail games", () => {
    const candidates = [
      { universeId: 50, playerCount: 8_000 },
      { universeId: 51, playerCount: 600 },
    ];
    const plan = planPollRun(active, limits(2, 3), now, candidates);
    expect(plan.candidates).toEqual([
      { universeId: 50, priority: 8_000, lastDetailsAt: null, lastDetailsRequestAt: null },
      { universeId: 51, priority: 600, lastDetailsAt: null, lastDetailsRequestAt: null },
    ]);
    expect(ids(plan.tailRequested)).toEqual([5]);
    expect(ids(plan.requested)).toEqual([1, 2, 50, 51, 5]);
  });

  it("requests the tail games furthest past their lane's refresh interval first", () => {
    // Overdue ratios, the wait since the latest request over the lane's interval: 11 (young, 45 of 30 minutes) 1.5,
    // 12 (established, 300 of 240) 1.25, 13 (young, 20 of 30) 0.67, 14 (established, 120 of 240) 0.5. Game 15 was
    // never requested.
    const plan = planPollRun(
      [
        game(1, 900, minutesAgo(0)),
        game(14, 800, minutesAgo(120), minutesAgo(120), established),
        game(13, 700, minutesAgo(20)),
        game(12, 600, minutesAgo(300), minutesAgo(300), established),
        game(11, 500, minutesAgo(45)),
        game(15, 400, null, null, established),
      ],
      limits(1, 4),
      now,
    );
    expect(ids(plan.tailRequested)).toEqual([15, 11, 12, 13]);
  });

  it("leaves an established game requested an hour ago behind a young game requested 40 minutes ago", () => {
    const plan = planPollRun(
      [game(1, 900, minutesAgo(0)), game(2, 800, minutesAgo(60), minutesAgo(60), established), game(3, 700, minutesAgo(40))],
      limits(1, 1),
      now,
    );
    expect(ids(plan.tailRequested)).toEqual([3]);
  });

  it("requests no more candidates than the tail slice holds", () => {
    const candidates = [50, 51, 52].map((universeId) => ({ universeId, playerCount: 100 }));
    const plan = planPollRun(active, limits(2, 2), now, candidates);
    expect(ids(plan.requested)).toEqual([1, 2, 50, 51]);
    expect(plan.tailRequested).toEqual([]);
  });
});

describe("tailLane", () => {
  const days = (count: number) => count * 24 * 60;

  it("counts a game created within the maximum age as young and one created exactly that long ago as established", () => {
    expect(tailLane(game(1, 100, null, null, minutesAgo(days(90) - 1)), now, 90)).toBe("young");
    expect(tailLane(game(1, 100, null, null, minutesAgo(days(90))), now, 90)).toBe("established");
    expect(tailLane(game(1, 100, null, null, established), now, 90)).toBe("established");
  });
});

describe("medianTailDetailsMinutesByLane", () => {
  it("reports the median details age of each lane among the tail games requested", () => {
    const requested = [
      game(11, 100, minutesAgo(30)),
      game(12, 100, minutesAgo(40)),
      game(13, 100, minutesAgo(200), minutesAgo(200), established),
      game(14, 100, minutesAgo(260), minutesAgo(260), established),
      game(15, 100, minutesAgo(300), minutesAgo(300), established),
    ];
    expect(medianTailDetailsMinutesByLane(requested, new Set(), now, 90)).toEqual({ young: 35, established: 260 });
    // Game 14 was not answered.
    expect(medianTailDetailsMinutesByLane(requested, new Set([14]), now, 90)).toEqual({ young: 35, established: 250 });
  });

  it("reports no age for a lane without a requested game", () => {
    expect(medianTailDetailsMinutesByLane([game(11, 100, minutesAgo(30))], new Set(), now, 90)).toEqual({
      young: 30,
      established: null,
    });
  });
});

describe("medianTailDetailsMinutes", () => {
  const tailRequested = [
    game(5, 500, null),
    game(8, 450, minutesAgo(26 * 24 * 60), minutesAgo(30)),
    game(4, 600, minutesAgo(50)),
    game(7, 300, minutesAgo(40)),
  ];

  it("reports the median age of the details among the tail games requested, skipping never-detailed games", () => {
    expect(medianTailDetailsMinutes(tailRequested, new Set(), now)).toBe(50);
    expect(medianTailDetailsMinutes(tailRequested.slice(2), new Set(), now)).toBe(45);
    expect(medianTailDetailsMinutes(tailRequested.slice(0, 1), new Set(), now)).toBeNull();
    expect(medianTailDetailsMinutes([], new Set(), now)).toBeNull();
  });

  it("is not pinned by a game that re-enters the active set with old details", () => {
    const rotation = [20, 22, 24, 26, 28].map((minutes, index) => game(10 + index, 100, minutesAgo(minutes)));
    expect(medianTailDetailsMinutes([...rotation, game(9, 100, minutesAgo(41_260))], new Set(), now)).toBe(25);
  });

  it("leaves out the games Roblox did not answer, whose details stay old forever", () => {
    expect(medianTailDetailsMinutes(tailRequested, new Set([8]), now)).toBe(45);
    expect(medianTailDetailsMinutes(tailRequested, new Set([8, 4]), now)).toBe(40);
    expect(medianTailDetailsMinutes(tailRequested, new Set([8, 4, 7]), now)).toBeNull();
  });

  it("never reports a negative age", () => {
    expect(medianTailDetailsMinutes([game(9, 100, new Date(now.getTime() + 60_000))], new Set(), now)).toBe(0);
  });
});
