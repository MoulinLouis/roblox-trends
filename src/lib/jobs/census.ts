import { latestSuccessfulRun } from "@/db/job-runs";
import { writeCensusObservations } from "@/db/observations";
import { placesToSkip, savePlaceResolution, unpromotedUniverses } from "@/db/places";
import { HttpError } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import type { RolimonsGame, RolimonsGameList } from "@/lib/api/rolimons";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { promoteUniverses } from "./promotion";
import type { JobDefinition } from "./runner";

export interface CensusDependencies {
  fetchGames(): Promise<RolimonsGameList>;
  roblox: Pick<RobloxApi, "resolveUniverseId" | "getGameDetails">;
  // Measures the resolution budget only.
  clock?: () => number;
}

export function evaluateCensusQuality(
  listed: number,
  previousListed: number | null,
  limits: { maximumChange: number; minimumListed: number },
): "success" | "degraded" {
  // A list this short is truncated, with or without a baseline to compare it with.
  if (listed === 0 || listed < limits.minimumListed) return "degraded";
  if (!previousListed) return "success";
  return Math.abs(listed - previousListed) / previousListed > limits.maximumChange ? "degraded" : "success";
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
      // The parser only accepts canonical place ids, so Number(placeId) is exact.
      const { games: listed, rejected } = await dependencies.fetchGames();
      await writeCensusObservations(
        db,
        listed.map((game) => ({ placeId: Number(game.placeId), observedAt: slot, ccu: Math.round(game.ccu) })),
      );
      // Baseline: the latest fully successful run of the last hours, so one truncated list never becomes the reference.
      // job_runs.started_at holds wall-clock time, so the window starts from Date.now(), not from the injectable `now`.
      const baselineSince = new Date(Date.now() - config.baselineMaxAgeHours * 60 * 60 * 1000);
      const previous = await latestSuccessfulRun(db, "census", baselineSince);
      const previousListed = typeof previous?.stats.listed === "number" ? previous.stats.listed : null;
      const listQuality = evaluateCensusQuality(listed.length, previousListed, {
        maximumChange: config.maximumListSizeChange,
        minimumListed: config.minimumListed,
      });

      const eligibleIds = listed.filter((game) => game.ccu >= config.promotionMinimumCcu).map((game) => Number(game.placeId));
      const skip = await placesToSkip(db, eligibleIds, now, config.resolutionRetryDays);
      const candidates = selectPlacesToResolve(listed, skip, config.promotionMinimumCcu);
      const deadline = clock() + config.resolutionBudgetMs;
      let resolved = 0;
      let unresolvable = 0;
      let resolutionFailures = 0;
      let deferred = 0;
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
            deferred = candidates.length - index - 1;
            logger.warn("Place resolution rate limited; deferring the remaining places", { placeId, deferred, error });
            break;
          }
          logger.warn("Place resolution failed; retrying next run", { placeId, error });
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
        // The list and the resolutions are already stored, and the next run requests these universes again.
        promotionError = errorMessage(error);
        logger.error("Promotion failed; retrying next run", { universes: universes.length, error: promotionError });
      }
      // No attempted place got an answer: the resolution API is failing, which a successful status would hide.
      const resolutionStalled = resolutionFailures > 0 && resolved + unresolvable === 0;
      return {
        status: listQuality === "degraded" || resolutionStalled || promotionError !== undefined ? "degraded" : "success",
        stats: {
          listed: listed.length,
          rejected,
          // The list check alone: analysis keeps the census slots whose list passed it.
          listQuality,
          eligible: eligibleIds.length,
          resolved,
          unresolvable,
          resolutionFailures,
          deferred,
          promotionRequested: universes.length,
          promoted,
          ...(promotionError === undefined ? {} : { promotionError }),
        },
      };
    },
  };
}
