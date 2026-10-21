import { savePlaceResolution, placesToSkip, unpromotedUniverses } from "@/db/places";
import { latestSuccessfulRun } from "@/db/job-runs";
import { writeCensusObservations } from "@/db/observations";
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
  clock?: () => number;
}

export function evaluateCensusQuality(listed: number, previousListed: number | null, maximumChange: number): "success" | "degraded" {
  if (listed === 0) return "degraded";
  if (!previousListed) return "success";
  return Math.abs(listed - previousListed) / previousListed > maximumChange ? "degraded" : "success";
}

export function selectPlacesToResolve(games: RolimonsGame[], skip: Set<number>, minimumCcu: number): RolimonsGame[] {
  return games
    .filter((game) => game.ccu >= minimumCcu && !skip.has(Number(game.placeId)))
    .sort((a, b) => b.ccu - a.ccu);
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
      // started_at is wall-clock time, so the window uses the clock, not the injectable `now`.
      const baselineSince = new Date(clock() - config.baselineMaxAgeHours * 60 * 60 * 1000);
      const previous = await latestSuccessfulRun(db, "census", baselineSince);
      const previousListed = typeof previous?.stats.listed === "number" ? previous.stats.listed : null;
      const status = evaluateCensusQuality(listed.length, previousListed, config.maximumListSizeChange);

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
        try {
          const universeId = await dependencies.roblox.resolveUniverseId(candidate.placeId);
          if (universeId === null) {
            await savePlaceResolution(db, { placeId, universeId: null, resolvedAt: now, error: "no universe" });
            unresolvable += 1;
          } else {
            await savePlaceResolution(db, { placeId, universeId: Number(universeId), resolvedAt: now, error: null });
            resolved += 1;
          }
        } catch (error) {
          if (error instanceof HttpError && (error.status === 400 || error.status === 404)) {
            await savePlaceResolution(db, { placeId, universeId: null, resolvedAt: now, error: errorMessage(error) });
            unresolvable += 1;
          } else {
            resolutionFailures += 1;
            logger.warn("Place resolution failed; retrying next run", { placeId, error: errorMessage(error) });
          }
        }
      }

      const universes = await unpromotedUniverses(db, eligibleIds);
      const promotion = await promoteUniverses(
        db,
        dependencies.roblox,
        universes.map((universeId) => ({ universeId, source: "rolimons" as const, detail: "" })),
        now,
      );
      return {
        status,
        stats: {
          listed: listed.length,
          rejected,
          eligible: eligibleIds.length,
          resolved,
          unresolvable,
          resolutionFailures,
          deferred,
          promoted: promotion.promoted,
        },
      };
    },
  };
}
