import { replaceChartSlot, type ChartPlacementRow } from "@/db/observations";
import type { RobloxApi, RobloxChartGame, RobloxSort } from "@/lib/api/roblox";
import { uniqueBy } from "@/lib/arrays";
import { JOB_CONFIG, ROBLOX_DISCOVERY_CHARTS } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { PromotionApiError, promoteUniverses, type PromotionCandidate } from "./promotion";
import type { JobDefinition } from "./runner";

export interface ChartsDependencies {
  roblox: Pick<RobloxApi, "getSortContent" | "getGameDetails">;
  sortIds?: readonly string[];
}

// Ranks follow the order Roblox lists the games, from 1. A game listed twice keeps its first, best rank.
export function toChartPlacements(sortId: string, chartGames: RobloxChartGame[], observedAt: Date): ChartPlacementRow[] {
  return uniqueBy(
    chartGames.map((game, index) => ({
      sortId,
      universeId: game.universeId,
      observedAt,
      rank: index + 1,
      playerCount: Math.round(game.playerCount),
      isSponsored: game.isSponsored ?? null,
    })),
    (row) => row.universeId,
  );
}

export function createChartsJob(dependencies: ChartsDependencies): JobDefinition {
  const config = JOB_CONFIG.charts;
  const sortIds = dependencies.sortIds ?? ROBLOX_DISCOVERY_CHARTS;
  return {
    name: "charts",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now, slot }) {
      const candidates: PromotionCandidate[] = [];
      let failedSorts = 0;
      let placements = 0;
      for (const sortId of sortIds) {
        let sort: RobloxSort;
        try {
          sort = await dependencies.roblox.getSortContent(sortId);
          // Every collected sort is a live ranking, so an empty one is a failed answer. Storing it would also erase
          // what an earlier attempt of this hour stored.
          if (!sort.games.length) throw new Error("The sort returned no games");
        } catch (error) {
          // A failed sort keeps whatever an earlier attempt in this hour stored for it.
          failedSorts += 1;
          logger.warn("Chart collection failed", { sortId, error: errorMessage(error) });
          continue;
        }
        // Stored as soon as it is read, so a run that times out keeps the sorts it finished. A database error is not
        // caught here: it fails the run.
        const rows = toChartPlacements(sortId, sort.games, slot);
        placements += await replaceChartSlot(db, sortId, slot, rows);
        candidates.push(...rows.map((row) => ({ universeId: row.universeId, source: "chart" as const, detail: sortId })));
      }
      // A promotion failure must not discard the placements already stored; the next run retries it.
      let promoted = 0;
      let promotionError: string | undefined;
      try {
        promoted = (await promoteUniverses(db, dependencies.roblox, candidates, now)).promoted;
      } catch (error) {
        // Only a Games API failure is tolerated; a database error fails the run. The message already includes the cause.
        if (!(error instanceof PromotionApiError)) throw error;
        promotionError = error.message;
        logger.error("Chart promotion failed; retrying next run", { error: promotionError });
      }
      const succeededSorts = sortIds.length - failedSorts;
      const sortsOk = sortIds.length > 0 && succeededSorts / sortIds.length >= config.minimumSortShare;
      return {
        status: sortsOk && promotionError === undefined ? "success" : "degraded",
        stats: {
          sorts: sortIds.length,
          failedSorts,
          placements,
          promotionRequested: new Set(candidates.map((candidate) => candidate.universeId)).size,
          promoted,
          promotionError,
        },
      };
    },
  };
}
