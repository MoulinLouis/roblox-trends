import { describe, expect, it } from "vitest";
import { JOB_CONFIG } from "@/lib/config";
import { selectGamesToClassify, type ClassificationCandidate, type SelectionOptions } from "./selection";

const now = new Date("2026-10-29T12:00:00.000Z");
const options: SelectionOptions = {
  now,
  limit: 100,
  minimumPromptVersion: JOB_CONFIG.classify.minimumPromptVersion,
  retryFailedAfterHours: JOB_CONFIG.classify.retryFailedAfterHours,
  maximumFailedAttempts: JOB_CONFIG.classify.maximumFailedAttempts,
  thumbnailWaitHours: JOB_CONFIG.classify.thumbnailWaitHours,
};

function candidate(values: Partial<ClassificationCandidate> & { universeId: number }): ClassificationCandidate {
  return {
    name: `Game ${values.universeId}`,
    description: "",
    genre: null,
    thumbnailUrl: null,
    lastCcu: 0,
    pending: false,
    // Seen long ago and checked, unless a test says otherwise.
    firstObservedAt: hoursAgo(1_000),
    thumbnailsCheckedAt: hoursAgo(900),
    classified: null,
    failures: [],
    ...values,
  };
}

function hoursAgo(hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

function ids(candidates: ClassificationCandidate[]): number[] {
  return selectGamesToClassify(candidates, options).games.map((game) => game.universeId);
}

describe("selectGamesToClassify", () => {
  it("orders new games, then retitled ones, then outdated ones, busiest first", () => {
    const current = options.minimumPromptVersion;
    const result = ids([
      candidate({ universeId: 1, lastCcu: 900, classified: { name: "Game 1", promptVersion: current - 1 } }),
      candidate({ universeId: 2, lastCcu: 10, classified: { name: "Old name", promptVersion: current } }),
      candidate({ universeId: 3, lastCcu: 5 }),
      candidate({ universeId: 4, lastCcu: 50 }),
      candidate({ universeId: 5, lastCcu: 500, classified: { name: "Other name", promptVersion: current } }),
      candidate({ universeId: 6, lastCcu: 50 }),
    ]);
    expect(result).toEqual([4, 6, 3, 5, 2, 1]);
  });

  it("does not choose a game classified with the same title, brackets and update markers aside", () => {
    const current = options.minimumPromptVersion;
    const result = ids([
      candidate({ universeId: 1, name: "Cool Game [UPD 3]", classified: { name: "Cool Game [🎃]", promptVersion: current } }),
      candidate({ universeId: 2, name: "COOL game", classified: { name: "Cool Game [UPD 2]", promptVersion: current } }),
    ]);
    expect(result).toEqual([]);
  });

  it("never chooses a pending game", () => {
    expect(ids([candidate({ universeId: 1, pending: true }), candidate({ universeId: 2 })])).toEqual([2]);
  });

  it("stops at the limit and counts every due game before the cap", () => {
    const current = options.minimumPromptVersion;
    const selection = selectGamesToClassify(
      [
        candidate({ universeId: 1, lastCcu: 1 }),
        candidate({ universeId: 2, lastCcu: 2 }),
        candidate({ universeId: 3, classified: { name: "Before", promptVersion: current } }),
        candidate({ universeId: 4, classified: { name: "Game 4", promptVersion: current - 1 } }),
      ],
      { ...options, limit: 2 },
    );
    expect(selection.games.map((game) => game.universeId)).toEqual([2, 1]);
    expect(selection.counts).toEqual({ new: 2, retitled: 1, outdated: 1, waitingThumbnail: 0, waitingRetry: 0, givenUp: 0 });
  });

  it("holds back a new game whose thumbnail was never checked until the wait is over", () => {
    const wait = options.thumbnailWaitHours;
    const fresh = candidate({ universeId: 1, firstObservedAt: hoursAgo(wait - 1), thumbnailsCheckedAt: null });
    const selection = selectGamesToClassify([fresh], options);
    expect(selection.games).toEqual([]);
    expect(selection.counts).toMatchObject({ new: 0, waitingThumbnail: 1 });
    const waited = candidate({ universeId: 2, firstObservedAt: hoursAgo(wait + 1), thumbnailsCheckedAt: null });
    expect(ids([waited])).toEqual([2]);
  });

  it("does not hold back a new game whose thumbnail was checked, even just now", () => {
    expect(ids([candidate({ universeId: 1, firstObservedAt: hoursAgo(1), thumbnailsCheckedAt: hoursAgo(0.5) })])).toEqual([1]);
  });

  it("does not make a retitled or outdated game wait for a thumbnail", () => {
    const current = options.minimumPromptVersion;
    const unchecked = { firstObservedAt: hoursAgo(1), thumbnailsCheckedAt: null };
    const selection = selectGamesToClassify(
      [
        candidate({ universeId: 1, ...unchecked, classified: { name: "Old name", promptVersion: current } }),
        candidate({ universeId: 2, ...unchecked, classified: { name: "Game 2", promptVersion: current - 1 } }),
      ],
      options,
    );
    expect(selection.games.map((game) => game.universeId)).toEqual([1, 2]);
    expect(selection.counts).toMatchObject({ retitled: 1, outdated: 1, waitingThumbnail: 0 });
  });

  it("makes a game wait when its last failure under the current title is younger than the retry delay", () => {
    const failures = [{ name: "Game 1", finishedAt: hoursAgo(options.retryFailedAfterHours - 1) }];
    const selection = selectGamesToClassify([candidate({ universeId: 1, failures })], options);
    expect(selection.games).toEqual([]);
    expect(selection.counts.waitingRetry).toBe(1);
    const older = [{ name: "Game 1", finishedAt: hoursAgo(options.retryFailedAfterHours + 1) }];
    expect(ids([candidate({ universeId: 1, failures: older })])).toEqual([1]);
  });

  it("gives up a game with the maximum of failures under its current title", () => {
    const failures = Array.from({ length: options.maximumFailedAttempts }, (_, index) => ({
      name: "Game 1 [UPD 1]",
      finishedAt: hoursAgo(100 - index),
    }));
    const selection = selectGamesToClassify([candidate({ universeId: 1, failures })], options);
    expect(selection.games).toEqual([]);
    expect(selection.counts.givenUp).toBe(1);
    expect(selection.counts.waitingRetry).toBe(0);
  });

  it("does not count failures under an earlier title", () => {
    const failures = Array.from({ length: options.maximumFailedAttempts }, () => ({
      name: "Earlier title",
      finishedAt: hoursAgo(1),
    }));
    const selection = selectGamesToClassify([candidate({ universeId: 1, failures })], options);
    expect(selection.games.map((game) => game.universeId)).toEqual([1]);
    expect(selection.counts).toMatchObject({ new: 1, waitingRetry: 0, givenUp: 0 });
  });

  it("counts a classification below the minimum prompt version as outdated", () => {
    const below = candidate({ universeId: 1, classified: { name: "Game 1", promptVersion: options.minimumPromptVersion - 1 } });
    const current = candidate({ universeId: 2, classified: { name: "Game 2", promptVersion: options.minimumPromptVersion } });
    const selection = selectGamesToClassify([below, current], options);
    expect(selection.games.map((game) => game.universeId)).toEqual([1]);
    expect(selection.counts.outdated).toBe(1);
  });

  it("returns only what the model is shown of a game", () => {
    const [game] = selectGamesToClassify(
      [candidate({ universeId: 7, lastCcu: 3, description: "d", genre: "g", thumbnailUrl: "u" })],
      options,
    ).games;
    expect(game).toEqual({ universeId: 7, name: "Game 7", description: "d", genre: "g", thumbnailUrl: "u" });
  });
});
