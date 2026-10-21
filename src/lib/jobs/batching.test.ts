import { describe, expect, it } from "vitest";
import { evaluateCollectionQuality, runBatchesWithDeadline, type BatchOptions } from "./batching";

// One-item batches, a clock that never moves, and work that echoes the batch.
function options(overrides: Partial<BatchOptions<number, number>> = {}): BatchOptions<number, number> {
  return { batchSize: 1, deadline: 100, clock: () => 0, work: async (batch) => batch, ...overrides };
}

describe("runBatchesWithDeadline", () => {
  it("processes every batch when time allows", async () => {
    const outcome = await runBatchesWithDeadline([1, 2, 3], options({ batchSize: 2, work: async (batch) => batch.map((item) => item * 10) }));
    expect(outcome).toEqual({ results: [10, 20, 30], attempted: 3, failedBatches: 0, skippedItems: 0, stoppedBy: null });
  });

  it("skips the remaining items once the deadline passes", async () => {
    let now = 0;
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3, 4, 5],
      options({
        batchSize: 2,
        deadline: 10,
        clock: () => now,
        work: async (batch) => {
          now += 20;
          return batch;
        },
      }),
    );
    expect(outcome).toEqual({ results: [1, 2], attempted: 2, failedBatches: 0, skippedItems: 3, stoppedBy: "deadline" });
  });

  it("counts failed batches and keeps going", async () => {
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3],
      options({
        work: async (batch) => {
          if (batch[0] === 2) throw new Error("boom");
          return batch;
        },
      }),
    );
    expect(outcome).toEqual({ results: [1, 3], attempted: 3, failedBatches: 1, skippedItems: 0, stoppedBy: null });
  });

  it("stops after an error that calls for it and skips the remaining items", async () => {
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3, 4],
      options({
        work: async (batch) => {
          if (batch[0] === 2) throw new Error("rate limited");
          if (batch[0] === 3) throw new Error("boom");
          return batch;
        },
        stopOn: (error) => error instanceof Error && error.message === "rate limited",
      }),
    );
    expect(outcome).toEqual({ results: [1], attempted: 2, failedBatches: 1, skippedItems: 2, stoppedBy: "error" });
  });

  it("keeps going after an error that does not call for a stop", async () => {
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3],
      options({
        work: async (batch) => {
          if (batch[0] === 2) throw new Error("boom");
          return batch;
        },
        stopOn: () => false,
      }),
    );
    expect(outcome).toEqual({ results: [1, 3], attempted: 3, failedBatches: 1, skippedItems: 0, stoppedBy: null });
  });

  it("stops after too many failed batches in a row", async () => {
    // Batch 3 succeeds and resets the count; batches 4 to 6 fail in a row, so batch 7 is skipped.
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3, 4, 5, 6, 7],
      options({
        work: async (batch) => {
          if (batch[0] !== 1 && batch[0] !== 3) throw new Error("boom");
          return batch;
        },
        maximumConsecutiveFailedBatches: 3,
      }),
    );
    expect(outcome).toEqual({ results: [1, 3], attempted: 6, failedBatches: 4, skippedItems: 1, stoppedBy: "repeatedFailures" });
  });

  it("stores each batch before working on the next", async () => {
    const events: string[] = [];
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3],
      options({
        batchSize: 2,
        work: async (batch) => {
          events.push(`work ${batch.join(",")}`);
          return batch;
        },
        store: async (results) => {
          events.push(`store ${results.join(",")}`);
        },
      }),
    );
    expect(events).toEqual(["work 1,2", "store 1,2", "work 3", "store 3"]);
    expect(outcome.results).toEqual([1, 2, 3]);
  });

  it("reports a failed batch and does not store it", async () => {
    const errors: [string, number[]][] = [];
    const stored: number[][] = [];
    await runBatchesWithDeadline(
      [1, 2, 3],
      options({
        work: async (batch) => {
          if (batch[0] === 2) throw new Error("boom");
          return batch;
        },
        onError: (error, batch) => errors.push([error instanceof Error ? error.message : String(error), batch]),
        store: async (results) => {
          stored.push(results);
        },
      }),
    );
    expect(errors).toEqual([["boom", [2]]]);
    expect(stored).toEqual([[1], [3]]);
  });

  it("stops on a storage failure instead of counting it as a failed batch", async () => {
    const worked: number[][] = [];
    const run = runBatchesWithDeadline(
      [1, 2],
      options({
        work: async (batch) => {
          worked.push(batch);
          return batch;
        },
        store: async () => {
          throw new Error("database unavailable");
        },
      }),
    );
    await expect(run).rejects.toThrow("database unavailable");
    expect(worked).toEqual([[1]]);
  });
});

describe("evaluateCollectionQuality", () => {
  const minimumReturnedShare = 0.95;

  it("accepts a complete run", () => {
    expect(evaluateCollectionQuality({ requested: 100, returned: 98, minimumReturnedShare })).toBe("success");
  });

  it("accepts a run that returns exactly the minimum share of the requested games", () => {
    expect(evaluateCollectionQuality({ requested: 100, returned: 95, minimumReturnedShare })).toBe("success");
  });

  it("flags missing responses", () => {
    expect(evaluateCollectionQuality({ requested: 100, returned: 90, minimumReturnedShare })).toBe("degraded");
  });

  // 90 attempted and 86 returned: 96% of the attempted games, but only 86% of the requested ones.
  it("counts shed games as missing", () => {
    expect(evaluateCollectionQuality({ requested: 100, returned: 86, minimumReturnedShare })).toBe("degraded");
  });

  it("accepts an empty run", () => {
    expect(evaluateCollectionQuality({ requested: 0, returned: 0, minimumReturnedShare })).toBe("success");
  });
});
