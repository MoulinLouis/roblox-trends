import { selectActiveUniverses } from "@/db/active-set";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { HttpError } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface PollDependencies {
  roblox: Pick<RobloxApi, "getGameDetails">;
  // Measures the deadline only.
  clock?: () => number;
}

export function createPollJob(dependencies: PollDependencies): JobDefinition {
  const config = JOB_CONFIG.poll;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "poll",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      // The deadline stops new batches, but a batch already in its retries can outlast the timeout. Its observations
      // are therefore written batch by batch, so a run that times out keeps the CCU of every batch it finished.
      const outcome = await runBatchesWithDeadline(
        active.map((item) => String(item.universeId)),
        {
          batchSize: config.batchSize,
          deadline: clock() + config.deadlineMs,
          clock,
          work: (batch) => dependencies.roblox.getGameDetails(batch),
          onError: (error, batch) =>
            logger.warn("Poll batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) }),
          // The client already retried with backoff: the next batches would hit the same limit, so the remaining
          // (lowest-priority) games wait for the next run.
          stopOn: isRateLimited,
          maximumConsecutiveFailedBatches: config.maximumConsecutiveFailedBatches,
          store: async (details) => {
            await writeGameObservations(
              db,
              details.map((detail) => ({
                universeId: detail.id,
                observedAt: slot,
                ccu: Math.round(detail.playing),
                visits: Math.round(detail.visits),
                favorites: Math.round(detail.favoritedCount),
              })),
            );
          },
        },
      );
      const details = outcome.results;
      // Observations first: the hypertable has no foreign key, and a lock timeout or deadlock in the
      // games upsert must not lose this 5-minute CCU slot.
      const upsert = await upsertGameDetails(db, details, now);
      // Census promotes every busy game, so an empty active set means collection upstream is broken, not a quiet hour.
      const status =
        active.length === 0
          ? "degraded"
          : evaluateCollectionQuality({
              requested: active.length,
              returned: details.length,
              minimumReturnedShare: config.minimumReturnedShare,
            });
      return {
        status,
        stats: {
          active: active.length,
          attempted: outcome.attempted,
          returned: details.length,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          stoppedBy: outcome.stoppedBy,
          // A rate limit is the only error that stops a poll.
          rateLimited: outcome.stoppedBy === "error",
          newGames: upsert.inserted.length,
          metadataChanges: upsert.metadataChanged.length,
        },
      };
    },
  };
}

function isRateLimited(error: unknown): boolean {
  return error instanceof HttpError && error.status === 429;
}
