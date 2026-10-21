import { type ActiveUniverse, selectActiveUniverses } from "@/db/active-set";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, httpMetricsSince, isRateLimited, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface PollDependencies {
  roblox: Pick<RobloxApi, "getGameDetails">;
  // Measures the deadline only.
  clock?: () => number;
  // Tests plan smaller runs; production takes JOB_CONFIG.poll.
  hotUniverses?: number;
  tailUniversesPerRun?: number;
}

export interface PollPlan {
  // The first games of the active set, in priority order: requested on every run.
  hot: ActiveUniverse[];
  // Every other active game.
  tail: ActiveUniverse[];
  // The tail games requested this run, oldest details first.
  tailRequested: ActiveUniverse[];
  // The hot set, then the tail slice: the deadline sheds the end of this order first.
  requested: ActiveUniverse[];
  // How far behind the rotation runs: the age of the oldest details among the tail games requested. Games whose
  // details were never stored have no age; null when no requested tail game has one.
  oldestTailDetailsMinutes: number | null;
}

// The active set holds more games than one run can request within the game details limit. The hot set is requested
// on every run; the tail rotates, since every game polled gets fresh details and moves behind the others.
export function planPollRun(
  active: readonly ActiveUniverse[],
  limits: { hotUniverses: number; tailUniversesPerRun: number },
  now: Date,
): PollPlan {
  const hot = active.slice(0, limits.hotUniverses);
  const tail = active.slice(limits.hotUniverses);
  const tailRequested = [...tail].sort(byOldestDetails).slice(0, limits.tailUniversesPerRun);
  const oldest = tailRequested.find((game) => game.lastDetailsAt !== null)?.lastDetailsAt;
  return {
    hot,
    tail,
    tailRequested,
    requested: [...hot, ...tailRequested],
    oldestTailDetailsMinutes: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 60_000)) : null,
  };
}

// Never-stored details first, then the oldest, then the lowest universe id.
function byOldestDetails(left: ActiveUniverse, right: ActiveUniverse): number {
  const leftAt = left.lastDetailsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightAt = right.lastDetailsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return left.universeId - right.universeId;
}

export function createPollJob(dependencies: PollDependencies): JobDefinition {
  const config = JOB_CONFIG.poll;
  const clock = dependencies.clock ?? Date.now;
  const limits = {
    hotUniverses: dependencies.hotUniverses ?? config.hotUniverses,
    tailUniversesPerRun: dependencies.tailUniversesPerRun ?? config.tailUniversesPerRun,
  };
  return {
    name: "poll",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      const plan = planPollRun(active, limits, now);
      const { requested } = plan;
      const httpBefore = getHttpRequestMetrics();
      // The deadline stops new batches, but a batch already in its retries can outlast the timeout. Its observations
      // are therefore written batch by batch, so a run that times out keeps the CCU of every batch it finished.
      const outcome = await runBatchesWithDeadline(
        requested.map((item) => String(item.universeId)),
        {
          batchSize: config.batchSize,
          deadline: clock() + config.deadlineMs,
          clock,
          work: (batch) => dependencies.roblox.getGameDetails(batch),
          onError: (error, batch) =>
            logger.warn("Poll batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) }),
          // The client already retried with backoff: the next batches would hit the same limit, so the remaining
          // games, last in the request order, wait for the next run.
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
      // games upsert must not lose this CCU slot. The upsert also stamps games.last_ccu_at, which moves every tail
      // game polled here behind the others.
      const upsert = await upsertGameDetails(db, details, now);
      // Census promotes every busy game, so an empty active set means collection upstream is broken, not a quiet hour.
      // Otherwise the run is judged on the games it planned: the unrequested tail waits for its turn by design.
      const status =
        active.length === 0
          ? "degraded"
          : evaluateCollectionQuality({
              requested: requested.length,
              returned: details.length,
              minimumReturnedShare: config.minimumReturnedShare,
            });
      return {
        status,
        stats: {
          active: active.length,
          hot: plan.hot.length,
          tail: plan.tail.length,
          tailRequested: plan.tailRequested.length,
          requested: requested.length,
          attempted: outcome.attempted,
          returned: details.length,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          stoppedBy: outcome.stoppedBy,
          rateLimited: outcome.stoppedBy === "error",
          // The priority of the first requested game left out: every game before it in the request order (the hot
          // set by priority, then the tail by details age) was attempted.
          shedBelowCcu: outcome.skippedItems > 0 ? requested[outcome.attempted].priority : null,
          oldestTailDetailsMinutes: plan.oldestTailDetailsMinutes,
          http: httpMetricsSince(httpBefore),
          newGames: upsert.inserted.length,
          metadataChanges: upsert.metadataChanged.length,
        },
      };
    },
  };
}
