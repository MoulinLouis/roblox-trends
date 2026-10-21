import { chunk } from "@/lib/arrays";

export interface BatchOutcome<R> {
  results: R[];
  attempted: number;
  failedBatches: number;
  skippedItems: number;
}

export interface BatchOptions<I, R> {
  batchSize: number;
  // No batch starts once clock() is past the deadline.
  deadline: number;
  clock: () => number;
  // The API call. A failure counts as a failed batch and the run moves on.
  work: (batch: I[]) => Promise<R[]>;
  onError?: (error: unknown, batch: I[]) => void;
  // Runs after each successful batch, outside the guard: a run that overruns its timeout keeps the batches it
  // finished, and a failure here is a database error, which must fail the run instead of passing for an API failure.
  store?: (results: R[]) => Promise<void>;
}

// Items arrive in priority order, so a missed deadline sheds the least important ones.
export async function runBatchesWithDeadline<I, R>(items: I[], options: BatchOptions<I, R>): Promise<BatchOutcome<R>> {
  const { batchSize, deadline, clock, work, onError, store } = options;
  const results: R[] = [];
  const batches = chunk(items, batchSize);
  let attempted = 0;
  let failedBatches = 0;
  let skippedItems = 0;
  for (const [index, batch] of batches.entries()) {
    if (clock() > deadline) {
      skippedItems = batches.slice(index).reduce((total, rest) => total + rest.length, 0);
      break;
    }
    attempted += batch.length;
    let batchResults: R[];
    try {
      batchResults = await work(batch);
    } catch (error) {
      failedBatches += 1;
      onError?.(error, batch);
      continue;
    }
    await store?.(batchResults);
    results.push(...batchResults);
  }
  return { results, attempted, failedBatches, skippedItems };
}

// Shed and failed games count as missing, as the design's quality gate requires: a run is degraded when fewer than
// the minimum share of the requested games come back.
export function evaluateCollectionQuality(input: {
  requested: number;
  returned: number;
  minimumReturnedShare: number;
}): "success" | "degraded" {
  return input.requested === 0 || input.returned / input.requested >= input.minimumReturnedShare ? "success" : "degraded";
}
