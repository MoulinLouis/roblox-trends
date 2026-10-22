import { type ActiveUniverse, selectActiveUniverses } from "@/db/active-set";
import { markGameDetailsAttempted, upsertGameDetails } from "@/db/games";
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
  // The tail games requested this run, longest since their latest details request first.
  tailRequested: ActiveUniverse[];
  // The hot set, then the tail slice: the deadline sheds the end of this order first.
  requested: ActiveUniverse[];
}

// The active set holds more games than one run can request within the game details limit. The hot set is requested
// on every run; the tail rotates, since every game requested moves behind the others: a game polled gets fresh
// details, and a game Roblox does not answer gets a new request time, so it is retried once per tail cycle.
export function planPollRun(
  active: readonly ActiveUniverse[],
  limits: { hotUniverses: number; tailUniversesPerRun: number },
): PollPlan {
  const hot = active.slice(0, limits.hotUniverses);
  const tail = active.slice(limits.hotUniverses);
  const tailRequested = [...tail].sort(byOldestRequest).slice(0, limits.tailUniversesPerRun);
  return { hot, tail, tailRequested, requested: [...hot, ...tailRequested] };
}

// Never-requested games first, then the oldest request, then the lowest universe id.
function byOldestRequest(left: ActiveUniverse, right: ActiveUniverse): number {
  const leftAt = left.lastDetailsRequestAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightAt = right.lastDetailsRequestAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return left.universeId - right.universeId;
}

// How long the tail waits between two refreshes: the median age of the details of the tail games requested. Games
// whose details were never stored have no age, and the games Roblox did not answer are left out: their details stay old
// however often they are requested. A median, not a maximum: a game that re-enters the active set brings the details
// of its last active day (41,260 minutes on 2026-10-21), which would pin a maximum. Null when no other requested tail
// game has details.
export function medianTailDetailsMinutes(
  tailRequested: readonly ActiveUniverse[],
  unanswered: ReadonlySet<number>,
  now: Date,
): number | null {
  const ages = tailRequested
    .flatMap((game) => (game.lastDetailsAt === null || unanswered.has(game.universeId) ? [] : [game.lastDetailsAt]))
    .map((at) => Math.max(0, (now.getTime() - at.getTime()) / 60_000))
    .sort((left, right) => left - right);
  if (ages.length === 0) return null;
  const middle = Math.floor(ages.length / 2);
  return Math.round(ages.length % 2 ? ages[middle] : (ages[middle - 1] + ages[middle]) / 2);
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
      const plan = planPollRun(active, limits);
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
      // Batches run in order, so the games requested from Roblox are the first `attempted` ones; a game shed by the
      // deadline or a stop was not requested and keeps its place at the head of the tail. Every requested game gets a
      // request time, so one that Roblox did not answer (its batch failed, or the response left it out) moves behind
      // the others like a polled one instead of heading the tail of every run.
      const attempted = requested.slice(0, outcome.attempted).map((game) => game.universeId);
      await markGameDetailsAttempted(db, attempted, now);
      const answered = new Set(details.map((detail) => detail.id));
      const missing = attempted.filter((universeId) => !answered.has(universeId)).sort((left, right) => left - right);
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
          // set by priority, then the tail by request age) was attempted.
          shedBelowCcu: outcome.skippedItems > 0 ? requested[outcome.attempted].priority : null,
          medianTailDetailsMinutes: medianTailDetailsMinutes(plan.tailRequested, new Set(missing), now),
          // The requested games Roblox did not answer: every requested game is answered, missing or skipped.
          missing: missing.length,
          missingSample: missing.slice(0, config.missingSampleSize),
          http: httpMetricsSince(httpBefore),
          newGames: upsert.inserted.length,
          metadataChanges: upsert.metadataChanged.length,
        },
      };
    },
  };
}
