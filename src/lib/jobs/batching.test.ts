import { describe, expect, it } from "vitest";
import { evaluateCollectionQuality, runBatchesWithDeadline } from "./batching";

describe("runBatchesWithDeadline", () => {
  it("processes every batch when time allows", async () => {
    const outcome = await runBatchesWithDeadline([1, 2, 3], 2, 100, () => 0, async (batch) => batch.map((item) => item * 10));
    expect(outcome).toEqual({ results: [10, 20, 30], attempted: 3, failedBatches: 0, skippedItems: 0 });
  });

  it("skips the remaining items once the deadline passes", async () => {
    let now = 0;
    const outcome = await runBatchesWithDeadline([1, 2, 3, 4, 5], 2, 10, () => now, async (batch) => {
      now += 20;
      return batch;
    });
    expect(outcome).toEqual({ results: [1, 2], attempted: 2, failedBatches: 0, skippedItems: 3 });
  });

  it("counts failed batches and keeps going", async () => {
    const outcome = await runBatchesWithDeadline([1, 2, 3], 1, 100, () => 0, async (batch) => {
      if (batch[0] === 2) throw new Error("boom");
      return batch;
    });
    expect(outcome).toEqual({ results: [1, 3], attempted: 3, failedBatches: 1, skippedItems: 0 });
  });

  it("stores each batch before working on the next", async () => {
    const events: string[] = [];
    const outcome = await runBatchesWithDeadline(
      [1, 2, 3],
      2,
      100,
      () => 0,
      async (batch) => {
        events.push(`work ${batch.join(",")}`);
        return batch;
      },
      undefined,
      async (results) => {
        events.push(`store ${results.join(",")}`);
      },
    );
    expect(events).toEqual(["work 1,2", "store 1,2", "work 3", "store 3"]);
    expect(outcome.results).toEqual([1, 2, 3]);
  });

  it("reports a failed batch and does not store it", async () => {
    const errors: [string, number[]][] = [];
    const stored: number[][] = [];
    await runBatchesWithDeadline(
      [1, 2, 3],
      1,
      100,
      () => 0,
      async (batch) => {
        if (batch[0] === 2) throw new Error("boom");
        return batch;
      },
      (error, batch) => errors.push([error instanceof Error ? error.message : String(error), batch]),
      async (results) => {
        stored.push(results);
      },
    );
    expect(errors).toEqual([["boom", [2]]]);
    expect(stored).toEqual([[1], [3]]);
  });

  it("stops on a storage failure instead of counting it as a failed batch", async () => {
    const worked: number[][] = [];
    const run = runBatchesWithDeadline(
      [1, 2],
      1,
      100,
      () => 0,
      async (batch) => {
        worked.push(batch);
        return batch;
      },
      undefined,
      async () => {
        throw new Error("database unavailable");
      },
    );
    await expect(run).rejects.toThrow("database unavailable");
    expect(worked).toEqual([[1]]);
  });
});

describe("evaluateCollectionQuality", () => {
  const thresholds = { minimumReturnedShare: 0.95, maximumSkippedShare: 0.1 };

  it("accepts a complete run", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 100, returned: 98, ...thresholds })).toBe("success");
  });

  it("flags missing responses", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 100, returned: 90, ...thresholds })).toBe("degraded");
  });

  it("flags heavy shedding", () => {
    expect(evaluateCollectionQuality({ requested: 100, attempted: 80, returned: 80, ...thresholds })).toBe("degraded");
  });

  it("accepts an empty run", () => {
    expect(evaluateCollectionQuality({ requested: 0, attempted: 0, returned: 0, ...thresholds })).toBe("success");
  });
});
