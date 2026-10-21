import { saveThumbnails, selectGamesNeedingThumbnails, type ThumbnailResult } from "@/db/thumbnails";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { evaluateCollectionQuality, httpMetricsSince, runBatchesWithDeadline } from "./batching";
import type { JobDefinition } from "./runner";

export interface ThumbnailsDependencies {
  roblox: Pick<RobloxApi, "getGameThumbnails" | "getThumbnails">;
  // Measures the deadline only.
  clock?: () => number;
}

// Follows the poll job: each batch is saved as soon as it is read, so a run that stops early or times out keeps the
// batches it finished.
export function createThumbnailsJob(dependencies: ThumbnailsDependencies): JobDefinition {
  const config = JOB_CONFIG.thumbnails;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "thumbnails",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const universeIds = await selectGamesNeedingThumbnails(db, now, {
        refreshHours: config.refreshHours,
        refreshMinimumCcu: config.refreshMinimumCcu,
        limit: config.maximumGamesPerRun,
      });
      const httpBefore = getHttpRequestMetrics();
      let changed = 0;
      const outcome = await runBatchesWithDeadline<number, ThumbnailResult>(universeIds, {
        batchSize: config.batchSize,
        deadline: clock() + config.deadlineMs,
        clock,
        work: async (batch) => {
          const ids = batch.map(String);
          const thumbnails = await dependencies.roblox.getGameThumbnails(ids);
          // The client absorbs a failed request into missing answers, so a batch without any answer is a failed batch.
          if (!ids.some((id) => thumbnails.has(id))) {
            throw new Error(`The thumbnail endpoint answered for none of ${ids.length} games`);
          }
          const icons = await dependencies.roblox.getThumbnails(ids);
          return batch.map((universeId) => ({
            universeId,
            answer: thumbnails.get(String(universeId)),
            iconUrl: icons.get(String(universeId)),
          }));
        },
        onError: (error, batch) =>
          logger.warn("Thumbnails batch failed", { universes: batch.length, firstUniverseId: batch[0], error: errorMessage(error) }),
        maximumConsecutiveFailedBatches: config.maximumConsecutiveFailedBatches,
        store: async (results) => {
          changed += (await saveThumbnails(db, results, now)).changed;
        },
      });
      const answers = outcome.results.map((result) => result.answer).filter((answer) => answer !== undefined);
      if (universeIds.length > 0 && answers.length === 0) {
        throw new Error(
          `The thumbnail endpoint answered for none of ${universeIds.length} games ` +
            `(failed batches: ${outcome.failedBatches}, stopped by: ${outcome.stoppedBy ?? "none"})`,
        );
      }
      const pending = answers.filter((answer) => answer === "pending").length;
      const withoutThumbnail = answers.filter((answer) => answer === null).length;
      return {
        // Coverage counts every answer, including "no custom thumbnail" and "pending": only games Roblox did not answer
        // for (failed, skipped or malformed) are missing.
        status: evaluateCollectionQuality({
          requested: universeIds.length,
          returned: answers.length,
          minimumReturnedShare: config.minimumAnsweredShare,
        }),
        stats: {
          requested: universeIds.length,
          attempted: outcome.attempted,
          answered: answers.length,
          withThumbnail: answers.length - pending - withoutThumbnail,
          withoutThumbnail,
          pending,
          icons: outcome.results.filter((result) => result.iconUrl !== undefined).length,
          changed,
          failedBatches: outcome.failedBatches,
          skipped: outcome.skippedItems,
          stoppedBy: outcome.stoppedBy,
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
