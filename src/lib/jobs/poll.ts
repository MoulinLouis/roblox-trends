import { type ActiveUniverse, selectActiveUniverses } from "@/db/active-set";
import { type PromotionCandidate, selectPromotionCandidates, settleCandidates } from "@/db/candidates";
import { markGameDetailsAttempted, upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG, RADAR_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, httpMetricsSince, isRateLimited, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

const dayMs = 24 * 60 * 60 * 1000;

export interface PollDependencies {
  roblox: Pick<RobloxApi, "getGameDetails">;
  // Measures the deadline only.
  clock?: () => number;
  // Tests plan smaller runs; production takes JOB_CONFIG.poll.
  hotUniverses?: number;
  tailUniversesPerRun?: number;
  candidatesPerRun?: number;
}

export interface PollLimits {
  hotUniverses: number;
  tailUniversesPerRun: number;
  // A tail game created within this many days is young; the others are established.
  youngMaximumAgeDays: number;
  // How long each lane of the tail should wait between two requests.
  tailRefreshMinutes: Record<TailLane, number>;
}

export type TailLane = "young" | "established";

// A game the run requests: an active game, or a promotion candidate that `games` does not hold yet.
export type PlannedUniverse = Omit<ActiveUniverse, "robloxCreatedAt">;

export interface PollPlan {
  // The first games of the active set, in priority order: requested on every run.
  hot: ActiveUniverse[];
  // Untracked universes from the promotion queue, busiest first, with the CCU their discovery listed as priority.
  candidates: PlannedUniverse[];
  // Every other active game.
  tail: ActiveUniverse[];
  // The tail games requested this run, furthest past their lane's refresh interval first.
  tailRequested: ActiveUniverse[];
  // The hot set, the candidates, then the tail slice: the deadline sheds the end of this order first.
  requested: PlannedUniverse[];
}

// The active set holds more games than one run can request within the game details limit. The hot set is requested
// on every run; the tail rotates, since every game requested moves behind the others: a game polled gets fresh
// details, and a game Roblox does not answer gets a new request time, so it is retried once per interval. Young and
// established tail games wait their own lane's interval: each run requests the games furthest past it, so when the
// tail outgrows the budget both lanes slow down in proportion. Candidates take the place of as many tail games, so
// promoting them adds no request to the run.
export function planPollRun(
  active: readonly ActiveUniverse[],
  limits: PollLimits,
  now: Date,
  promotionCandidates: readonly PromotionCandidate[] = [],
): PollPlan {
  const hot = active.slice(0, limits.hotUniverses);
  const tail = active.slice(limits.hotUniverses);
  const candidates = promotionCandidates.slice(0, limits.tailUniversesPerRun).map((candidate) => ({
    universeId: candidate.universeId,
    priority: candidate.playerCount,
    lastDetailsAt: null,
    lastDetailsRequestAt: null,
  }));
  const tailRequested = tail
    .map((game) => ({ game, overdue: overdueRatio(game, limits, now) }))
    .sort((left, right) =>
      left.overdue === right.overdue ? left.game.universeId - right.game.universeId : left.overdue > right.overdue ? -1 : 1,
    )
    .slice(0, limits.tailUniversesPerRun - candidates.length)
    .map(({ game }) => game);
  return { hot, candidates, tail, tailRequested, requested: [...hot, ...candidates, ...tailRequested] };
}

// Young when created less than youngMaximumAgeDays ago, the comparison of rising_games' age filter: a game exactly that
// old is established.
export function tailLane(game: Pick<ActiveUniverse, "robloxCreatedAt">, now: Date, youngMaximumAgeDays: number): TailLane {
  return game.robloxCreatedAt.getTime() > now.getTime() - youngMaximumAgeDays * dayMs ? "young" : "established";
}

// The wait since the game's latest details request, in intervals of its lane: 1 when it is exactly due. A game never
// requested comes first.
function overdueRatio(game: ActiveUniverse, limits: PollLimits, now: Date): number {
  if (game.lastDetailsRequestAt === null) return Number.POSITIVE_INFINITY;
  const intervalMs = limits.tailRefreshMinutes[tailLane(game, now, limits.youngMaximumAgeDays)] * 60_000;
  return (now.getTime() - game.lastDetailsRequestAt.getTime()) / intervalMs;
}

// medianTailDetailsMinutes for each lane of the tail.
export function medianTailDetailsMinutesByLane(
  tailRequested: readonly ActiveUniverse[],
  unanswered: ReadonlySet<number>,
  now: Date,
  youngMaximumAgeDays: number,
): Record<TailLane, number | null> {
  const lane = (wanted: TailLane) => tailRequested.filter((game) => tailLane(game, now, youngMaximumAgeDays) === wanted);
  return {
    young: medianTailDetailsMinutes(lane("young"), unanswered, now),
    established: medianTailDetailsMinutes(lane("established"), unanswered, now),
  };
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
  const limits: PollLimits = {
    hotUniverses: dependencies.hotUniverses ?? config.hotUniverses,
    tailUniversesPerRun: dependencies.tailUniversesPerRun ?? config.tailUniversesPerRun,
    youngMaximumAgeDays: Math.max(...RADAR_CONFIG.ageOptionsDays),
    tailRefreshMinutes: config.tailRefreshMinutes,
  };
  const candidatesPerRun = dependencies.candidatesPerRun ?? config.candidatesPerRun;
  return {
    name: "poll",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const active = await selectActiveUniverses(db, now);
      const promotionCandidates = await selectPromotionCandidates(db, now, {
        limit: candidatesPerRun,
        maximumAgeHours: config.candidateMaximumAgeHours,
        retryHours: config.candidateRetryHours,
      });
      const plan = planPollRun(active, limits, now, promotionCandidates);
      const { requested } = plan;
      const httpBefore = getHttpRequestMetrics();
      // The universes of the batches whose request failed: Roblox did not answer for them, but it said nothing of them.
      const failedRequests = new Set<number>();
      // The deadline stops new batches, but a batch already in its retries can outlast the timeout. Its observations
      // are therefore written batch by batch, so a run that times out keeps the CCU of every batch it finished.
      const outcome = await runBatchesWithDeadline(
        requested.map((item) => String(item.universeId)),
        {
          batchSize: config.batchSize,
          deadline: clock() + config.deadlineMs,
          clock,
          work: (batch) => dependencies.roblox.getGameDetails(batch),
          onError: (error, batch) => {
            for (const universeId of batch) failedRequests.add(Number(universeId));
            logger.warn("Poll batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) });
          },
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
      // The candidates are judged apart: the tracked games measure the collection, and a candidate Roblox left out of
      // its answer (moderated or deleted since it was listed) waits in the queue instead of degrading the run. One whose
      // request failed (an outage, a rate limit) is requested again on the next run, busiest first as before.
      const candidateIds = new Set(plan.candidates.map((candidate) => candidate.universeId));
      const unansweredCandidates = attempted.filter(
        (universeId) => candidateIds.has(universeId) && !answered.has(universeId) && !failedRequests.has(universeId),
      );
      const settled = await settleCandidates(db, now, unansweredCandidates, { maximumAgeHours: config.candidateMaximumAgeHours });
      const missing = attempted
        .filter((universeId) => !answered.has(universeId) && !candidateIds.has(universeId))
        .sort((left, right) => left - right);
      // Census promotes every busy game, so an empty active set means collection upstream is broken, not a quiet hour.
      // Otherwise the run is judged on the games it planned: the unrequested tail waits for its turn by design.
      const status =
        active.length === 0
          ? "degraded"
          : evaluateCollectionQuality({
              requested: requested.length - plan.candidates.length,
              returned: details.filter((detail) => !candidateIds.has(detail.id)).length,
              minimumReturnedShare: config.minimumReturnedShare,
            });
      return {
        status,
        stats: {
          active: active.length,
          hot: plan.hot.length,
          candidates: plan.candidates.length,
          tail: plan.tail.length,
          youngTail: plan.tail.filter((game) => tailLane(game, now, limits.youngMaximumAgeDays) === "young").length,
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
          medianTailDetailsMinutes: medianTailDetailsMinutesByLane(
            plan.tailRequested,
            new Set(missing),
            now,
            limits.youngMaximumAgeDays,
          ),
          // The requested games Roblox did not answer: every requested game is answered, missing or skipped.
          missing: missing.length,
          missingSample: missing.slice(0, config.missingSampleSize),
          http: httpMetricsSince(httpBefore),
          newGames: upsert.inserted.length,
          metadataChanges: upsert.metadataChanged.length,
          // requested and returned include the candidates, which the quality gate leaves out. Requested candidates
          // Roblox left out of its answer, and games whose discovery sightings moved to discovery_sources.
          candidatesUnanswered: unansweredCandidates.length,
          candidatesSettled: settled,
        },
      };
    },
  };
}
