import { chunk } from "@/lib/arrays";

export interface BatchOutcome<R> {
  results: R[];
  attempted: number;
  failedBatches: number;
  skippedItems: number;
  // Why the remaining items were skipped; null when every batch was attempted.
  stoppedBy: "deadline" | "error" | "repeatedFailures" | null;
}

export interface BatchOptions<I, R> {
  batchSize: number;
  // No batch starts once clock() is past the deadline.
  deadline: number;
  clock: () => number;
  // The API call. A failure counts as a failed batch and the run moves on, unless a stop rule below applies.
  work: (batch: I[]) => Promise<R[]>;
  onError?: (error: unknown, batch: I[]) => void;
  // True for an error that the next batches would only repeat, such as a rate limit that outlasted the retries.
  stopOn?: (error: unknown) => boolean;
  // Failed batches in a row that point to an outage rather than to bad items. Unlimited when absent.
  maximumConsecutiveFailedBatches?: number;
  // Runs after each successful batch, outside the guard: a run that overruns its timeout keeps the batches it
  // finished, and a failure here is a database error, which must fail the run instead of passing for an API failure.
  store?: (results: R[]) => Promise<void>;
}

// Items arrive in priority order, so a missed deadline or an early stop sheds the least important ones.
export async function runBatchesWithDeadline<I, R>(items: I[], options: BatchOptions<I, R>): Promise<BatchOutcome<R>> {
  const { batchSize, deadline, clock, work, onError, stopOn, store } = options;
  const maximumConsecutiveFailedBatches = options.maximumConsecutiveFailedBatches ?? Number.POSITIVE_INFINITY;
  const results: R[] = [];
  const batches = chunk(items, batchSize);
  let attempted = 0;
  let failedBatches = 0;
  let consecutiveFailedBatches = 0;
  let stoppedBy: BatchOutcome<R>["stoppedBy"] = null;
  for (const batch of batches) {
    if (clock() > deadline) {
      stoppedBy = "deadline";
      break;
    }
    attempted += batch.length;
    let batchResults: R[];
    try {
      batchResults = await work(batch);
    } catch (error) {
      failedBatches += 1;
      consecutiveFailedBatches += 1;
      onError?.(error, batch);
      if (stopOn?.(error)) {
        stoppedBy = "error";
        break;
      }
      if (consecutiveFailedBatches >= maximumConsecutiveFailedBatches) {
        stoppedBy = "repeatedFailures";
        break;
      }
      continue;
    }
    consecutiveFailedBatches = 0;
    await store?.(batchResults);
    results.push(...batchResults);
  }
  return { results, attempted, failedBatches, skippedItems: items.length - attempted, stoppedBy };
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
