import { chunk } from "@/lib/arrays";

export interface BatchOutcome<R> {
  results: R[];
  attempted: number;
  failedBatches: number;
  skippedItems: number;
}

// Items arrive in priority order, so a missed deadline sheds the least important ones.
// Only `work` (the API call) is guarded: a failure there counts as a failed batch and the run moves on. `store` runs
// after each successful batch, so a run that overruns its timeout keeps the batches it finished; a failure there is a
// database error, which must fail the run instead of passing for an API failure.
export async function runBatchesWithDeadline<I, R>(
  items: I[],
  batchSize: number,
  deadline: number,
  clock: () => number,
  work: (batch: I[]) => Promise<R[]>,
  onError?: (error: unknown, batch: I[]) => void,
  store?: (results: R[]) => Promise<void>,
): Promise<BatchOutcome<R>> {
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

export function evaluateCollectionQuality(input: {
  requested: number;
  attempted: number;
  returned: number;
  minimumReturnedShare: number;
  maximumSkippedShare: number;
}): "success" | "degraded" {
  if (input.requested === 0) return "success";
  const returnedShare = input.attempted ? input.returned / input.attempted : 0;
  const skippedShare = (input.requested - input.attempted) / input.requested;
  return returnedShare >= input.minimumReturnedShare && skippedShare <= input.maximumSkippedShare ? "success" : "degraded";
}
