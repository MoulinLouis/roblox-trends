import { createHash } from "node:crypto";
import { latestRunWithStat } from "@/db/job-runs";
import { writeCensusObservations } from "@/db/observations";
import { placesToSkip, savePlaceResolution, unpromotedUniverses } from "@/db/places";
import { getHttpRequestMetrics, HttpError } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import type { RolimonsGame, RolimonsGameList } from "@/lib/api/rolimons";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { httpMetricsSince } from "./batching";
import { PromotionApiError, promoteUniverses } from "./promotion";
import type { JobDefinition } from "./runner";

export interface CensusDependencies {
  fetchGames(): Promise<RolimonsGameList>;
  roblox: Pick<RobloxApi, "resolveUniverseId" | "getGameDetails">;
  // Measures the resolution budget only.
  clock?: () => number;
}

export function evaluateCensusQuality(
  list: { listed: number; rejected: number },
  previousListed: number | null,
  limits: { maximumListSizeChange: number; minimumListed: number; maximumRejectedShare: number },
): "success" | "degraded" {
  const { listed, rejected } = list;
  // A list this short is truncated, with or without a baseline to compare it with.
  if (listed === 0 || listed < limits.minimumListed) return "degraded";
  // Many malformed entries mean the format changed, even when the accepted ones still look plausible.
  if (rejected / (listed + rejected) > limits.maximumRejectedShare) return "degraded";
  if (!previousListed) return "success";
  return Math.abs(listed - previousListed) / previousListed > limits.maximumListSizeChange ? "degraded" : "success";
}

// The content of a Rolimon's list: its places and their CCU, in place order. Rolimon's sometimes serves the list of
// the previous slot again (2 of the first 44 runs on 2026-10-21, while about 78% of the places change between two
// slots); storing it would record those CCU as a new sample.
export function censusListFingerprint(games: readonly RolimonsGame[]): string {
  const hash = createHash("sha1");
  for (const game of [...games].sort((left, right) => Number(left.placeId) - Number(right.placeId))) {
    hash.update(`${game.placeId}:${game.ccu}\n`);
  }
  return hash.digest("hex");
}

export function selectPlacesToResolve(games: RolimonsGame[], skip: Set<number>, minimumCcu: number): RolimonsGame[] {
  return games
    .filter((game) => game.ccu >= minimumCcu && !skip.has(Number(game.placeId)))
    .sort((a, b) => b.ccu - a.ccu);
}

type PlaceResolution = { universeId: number | null; error: string | null } | { failure: unknown };

// Only the API call is guarded: a database error must fail the run instead of passing for a resolution failure.
async function resolvePlace(roblox: CensusDependencies["roblox"], placeId: string): Promise<PlaceResolution> {
  try {
    const universeId = await roblox.resolveUniverseId(placeId);
    return universeId === null ? { universeId: null, error: "no universe" } : { universeId: Number(universeId), error: null };
  } catch (error) {
    // 400 and 404 concern this place only. Other errors, such as outages and rate limits, are retried next run.
    if (error instanceof HttpError && (error.status === 400 || error.status === 404)) {
      return { universeId: null, error: errorMessage(error) };
    }
    return { failure: error };
  }
}

export function createCensusJob(dependencies: CensusDependencies): JobDefinition {
  const config = JOB_CONFIG.census;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "census",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      // Rolimon's, the place resolutions on apis.roblox.com and the Games API calls of promotion.
      const httpBefore = getHttpRequestMetrics();
      let list: RolimonsGameList;
      try {
        list = await dependencies.fetchGames();
      } catch (error) {
        // Only the request is guarded: a Rolimon's outage (an error status, a network failure or a broken envelope)
        // degrades the run while poll keeps sampling the tracked games. A database error below still fails the run.
        const listError = errorMessage(error);
        logger.error("Rolimon's list request failed; retrying next run", { error: listError });
        return {
          status: "degraded",
          stats: {
            // Every stat of a normal run is present, so `npm run status` prints the run like any other.
            listed: null,
            rejected: null,
            listFingerprint: null,
            // Neither the analysis nor the baseline of later runs takes this run: both select listQuality "success".
            listQuality: "failed",
            eligible: 0,
            resolved: 0,
            unresolvable: 0,
            resolutionFailures: 0,
            deferred: 0,
            rateLimited: false,
            promotionRequested: 0,
            promoted: 0,
            http: httpMetricsSince(httpBefore),
            listError,
          },
        };
      }
      // The parser only accepts canonical place ids, so Number(placeId) is exact.
      const { games: listed, rejected } = list;
      // job_runs.started_at holds wall-clock time, so the windows start from Date.now(), not from the injectable `now`.
      const baselineSince = new Date(Date.now() - config.baselineMaxAgeHours * 60 * 60 * 1000);
      // The same list as the latest one read in an earlier slot is Rolimon's serving it again: its CCU are not a new
      // sample, so they are not stored and the run is degraded (a list frozen for an hour alerts through the quality
      // check). A rerun within a slot is compared with the earlier slots, as the slot's first run was. A run that
      // failed after writing keeps no stats, so a repeat right after it is compared with the run before. Promotion
      // still uses the list: its places and their CCU are real.
      const listFingerprint = censusListFingerprint(listed);
      const latestList = await latestRunWithStat(db, "census", baselineSince, "listFingerprint", { slotBefore: slot });
      const repeated = latestList?.stats.listFingerprint === listFingerprint;
      if (!repeated) {
        await writeCensusObservations(
          db,
          listed.map((game) => ({ placeId: Number(game.placeId), observedAt: slot, ccu: Math.round(game.ccu) })),
        );
      }
      // Baseline: the latest list of the last hours that passed this check, even in a run degraded for another reason,
      // so one truncated list never becomes the reference.
      const previous = await latestRunWithStat(db, "census", baselineSince, "listQuality", { value: "success" });
      const previousListed = typeof previous?.stats.listed === "number" ? previous.stats.listed : null;
      const listQuality = repeated
        ? "repeated"
        : evaluateCensusQuality({ listed: listed.length, rejected }, previousListed, config);

      const eligibleIds = listed.filter((game) => game.ccu >= config.promotionMinimumCcu).map((game) => Number(game.placeId));
      const skip = await placesToSkip(db, eligibleIds, now, config.resolutionRetryDays);
      const candidates = selectPlacesToResolve(listed, skip, config.promotionMinimumCcu);
      const deadline = clock() + config.resolutionBudgetMs;
      let resolved = 0;
      let unresolvable = 0;
      let resolutionFailures = 0;
      let deferred = 0;
      let rateLimited = false;
      for (const [index, candidate] of candidates.entries()) {
        if (clock() > deadline) {
          deferred = candidates.length - index;
          break;
        }
        const placeId = Number(candidate.placeId);
        const resolution = await resolvePlace(dependencies.roblox, candidate.placeId);
        if ("failure" in resolution) {
          resolutionFailures += 1;
          const error = errorMessage(resolution.failure);
          // The request was already retried: the remaining places wait for the next run instead of hitting the limit.
          if (resolution.failure instanceof HttpError && resolution.failure.status === 429) {
            rateLimited = true;
            deferred = candidates.length - index - 1;
            logger.warn("Place resolution rate limited; deferring the remaining places", { placeId, deferred, error });
            break;
          }
          logger.warn("Place resolution failed; retrying next run", { placeId, error });
          // Repeated failures without a single answer point to an outage: the remaining places wait for the next run.
          if (resolved + unresolvable === 0 && resolutionFailures >= config.stalledResolutionFailures) {
            deferred = candidates.length - index - 1;
            logger.warn("Place resolution keeps failing; deferring the remaining places", { deferred });
            break;
          }
          continue;
        }
        await savePlaceResolution(db, { placeId, ...resolution, resolvedAt: now });
        if (resolution.universeId === null) unresolvable += 1;
        else resolved += 1;
      }

      const universes = await unpromotedUniverses(db, eligibleIds);
      let promoted = 0;
      let promotionError: string | undefined;
      try {
        const promotion = await promoteUniverses(
          db,
          dependencies.roblox,
          universes.map((universeId) => ({ universeId, source: "rolimons" as const, detail: "" })),
          now,
        );
        promoted = promotion.promoted;
      } catch (error) {
        // Only a Games API failure is tolerated: the list and the resolutions are already stored, and the next run
        // requests these universes again. A database error fails the run. The message already includes the cause.
        if (!(error instanceof PromotionApiError)) throw error;
        promotionError = error.message;
        logger.error("Promotion failed; retrying next run", { universes: universes.length, error: promotionError });
      }
      // No answer, and the run either stopped early (rate limit, budget) or failed repeatedly: the resolution API is
      // failing, which a successful status would hide. A single failing place is not enough evidence.
      const answered = resolved + unresolvable;
      const resolutionStalled =
        answered === 0 &&
        resolutionFailures > 0 &&
        (rateLimited || deferred > 0 || resolutionFailures >= config.stalledResolutionFailures);
      return {
        status: listQuality !== "success" || resolutionStalled || promotionError !== undefined ? "degraded" : "success",
        stats: {
          listed: listed.length,
          rejected,
          listFingerprint,
          // The list check alone ("success", "degraded" or "repeated"): analysis keeps the census slots whose list
          // passed it, and later runs compare with them.
          listQuality,
          eligible: eligibleIds.length,
          resolved,
          unresolvable,
          resolutionFailures,
          deferred,
          rateLimited,
          promotionRequested: universes.length,
          promoted,
          http: httpMetricsSince(httpBefore),
          ...(promotionError === undefined ? {} : { promotionError }),
        },
      };
    },
  };
}
