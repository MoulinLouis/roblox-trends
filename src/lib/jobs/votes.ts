import { selectActiveUniverses } from "@/db/active-set";
import { writeVoteObservations } from "@/db/observations";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, httpMetricsSince, isRateLimited, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface VotesDependencies {
  roblox: Pick<RobloxApi, "getGameVotes">;
  // Measures the deadline only.
  clock?: () => number;
}

// Follows the poll job: votes are written batch by batch, so a run that times out keeps the batches it finished.
export function createVotesJob(dependencies: VotesDependencies): JobDefinition {
  const config = JOB_CONFIG.votes;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "votes",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      const httpBefore = getHttpRequestMetrics();
      const outcome = await runBatchesWithDeadline(
        active.map((item) => String(item.universeId)),
        {
          batchSize: config.batchSize,
          deadline: clock() + config.deadlineMs,
          clock,
          work: (batch) => dependencies.roblox.getGameVotes(batch),
          onError: (error, batch) =>
            logger.warn("Votes batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) }),
          stopOn: isRateLimited,
          maximumConsecutiveFailedBatches: config.maximumConsecutiveFailedBatches,
          store: async (votes) => {
            await writeVoteObservations(
              db,
              votes.map((vote) => ({ universeId: vote.id, observedAt: slot, upVotes: vote.upVotes, downVotes: vote.downVotes })),
            );
          },
        },
      );
      // As in the poll job, an empty active set means collection upstream is broken, not a quiet hour.
      const status =
        active.length === 0
          ? "degraded"
          : evaluateCollectionQuality({
              requested: active.length,
              returned: outcome.results.length,
              minimumReturnedShare: config.minimumReturnedShare,
            });
      return {
        status,
        stats: {
          active: active.length,
          attempted: outcome.attempted,
          returned: outcome.results.length,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          stoppedBy: outcome.stoppedBy,
          rateLimited: outcome.stoppedBy === "error",
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
