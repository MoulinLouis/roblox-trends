import { replaceChartSlot, type ChartPlacementRow } from "@/db/observations";
import type { RobloxApi, RobloxSort, RobloxSortGame } from "@/lib/api/roblox";
import { JOB_CONFIG, ROBLOX_DISCOVERY_CHARTS } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { PromotionApiError, promoteUniverses, type PromotionCandidate } from "./promotion";
import type { JobDefinition } from "./runner";

export interface ChartsDependencies {
  roblox: Pick<RobloxApi, "getSortContent" | "getGameDetails">;
  sortIds?: readonly string[];
}

// The rank is the position Roblox listed the game at, so a malformed entry the parser skipped leaves a gap. A game
// listed more than once keeps its organic placement over a sponsored one (an unknown flag counts as organic), and
// otherwise its first placement.
export function toChartPlacements(sortId: string, chartGames: RobloxSortGame[], observedAt: Date): ChartPlacementRow[] {
  const chosen = new Map<number, ChartPlacementRow>();
  for (const game of chartGames) {
    const placement = {
      sortId,
      universeId: game.universeId,
      observedAt,
      rank: game.position,
      playerCount: Math.round(game.playerCount),
      isSponsored: game.isSponsored ?? null,
    };
    const current = chosen.get(game.universeId);
    if (!current || (current.isSponsored === true && placement.isSponsored !== true)) chosen.set(game.universeId, placement);
  }
  return [...chosen.values()].sort((left, right) => left.rank - right.rank);
}

// Every collected sort is a live ranking: an empty one, or one with too many malformed entries, is a failed answer.
// Storing it would also erase what an earlier attempt of this hour stored.
function sortProblem(sort: RobloxSort, maximumMalformedShare: number): string | null {
  const listed = sort.games.length + sort.skipped;
  if (listed === 0) return "The sort returned no games";
  if (sort.skipped / listed > maximumMalformedShare) return `${sort.skipped} of ${listed} entries were malformed`;
  return null;
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
      let skippedItems = 0;
      let placements = 0;
      for (const sortId of sortIds) {
        let sort: RobloxSort;
        try {
          sort = await dependencies.roblox.getSortContent(sortId);
        } catch (error) {
          // A failed sort keeps whatever an earlier attempt in this hour stored for it.
          failedSorts += 1;
          logger.warn("Chart collection failed", { sortId, error: errorMessage(error) });
          continue;
        }
        skippedItems += sort.skipped;
        const problem = sortProblem(sort, config.maximumMalformedShare);
        if (problem) {
          failedSorts += 1;
          logger.warn("Chart collection failed", { sortId, error: problem });
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
          skippedItems,
          placements,
          promotionRequested: new Set(candidates.map((candidate) => candidate.universeId)).size,
          promoted,
          promotionError,
        },
      };
    },
  };
}
