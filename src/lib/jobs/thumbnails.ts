import { saveThumbnails, selectGamesNeedingThumbnails } from "@/db/thumbnails";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { GameThumbnailAnswer, RobloxApi } from "@/lib/api/roblox";
import { JOB_CONFIG } from "@/lib/config";
import { evaluateCollectionQuality, httpMetricsSince } from "./batching";
import type { JobDefinition } from "./runner";

export interface ThumbnailsDependencies {
  roblox: Pick<RobloxApi, "getGameThumbnails" | "getThumbnails">;
}

export function createThumbnailsJob(dependencies: ThumbnailsDependencies): JobDefinition {
  const config = JOB_CONFIG.thumbnails;
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
      const ids = universeIds.map(String);
      const httpBefore = getHttpRequestMetrics();
      // Both calls are best-effort per batch: a failed batch leaves its games without an answer, and they stay due.
      const thumbnails = ids.length ? await dependencies.roblox.getGameThumbnails(ids) : new Map<string, GameThumbnailAnswer>();
      const answers = ids.map((id) => thumbnails.get(id)).filter((answer) => answer !== undefined);
      if (ids.length && answers.length === 0) {
        throw new Error(`The thumbnail endpoint answered for none of ${ids.length} games`);
      }
      const icons = ids.length ? await dependencies.roblox.getThumbnails(ids) : new Map<string, string>();
      const { changed } = await saveThumbnails(db, universeIds, thumbnails, icons, now);
      const pending = answers.filter((answer) => answer === "pending").length;
      const withoutThumbnail = answers.filter((answer) => answer === null).length;
      return {
        // Coverage counts every answer, including "no custom thumbnail" and "pending": only source failures degrade.
        status: evaluateCollectionQuality({
          requested: ids.length,
          returned: answers.length,
          minimumReturnedShare: config.minimumAnsweredShare,
        }),
        stats: {
          requested: ids.length,
          answered: answers.length,
          withThumbnail: answers.length - pending - withoutThumbnail,
          withoutThumbnail,
          pending,
          icons: icons.size,
          changed,
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
