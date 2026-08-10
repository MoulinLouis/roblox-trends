import type { AppSettings, CollectedGame, CollectionError } from "./types";
import { RobloxClient, type RobloxChartGame, type RobloxGameDetail, type RobloxSort } from "./api/roblox";
import { getRolimonsGames } from "./api/rolimons";
import { errorMessage, logger } from "./logger";
import { floorToBucket, recordSourceRun, saveCollectedGames } from "@/db/repository";

export interface CollectionResult {
  collectedAt: Date;
  games: number;
  snapshots: number;
  errors: CollectionError[];
}

interface Discovery {
  chart: string;
  source: string;
  rank: number | null;
  chartGame: RobloxChartGame;
}

export async function collectRobloxData(settings: AppSettings, now = new Date()): Promise<CollectionResult> {
  const client = new RobloxClient(settings.collection.country, settings.collection.device);
  const errors: CollectionError[] = [];
  const discoveries: Discovery[] = [];
  const bucket = floorToBucket(now, settings.collection.intervalMinutes);
  const runKey = `collect:${bucket.toISOString()}`;
  const startedAt = new Date();

  await recordSourceRun({ runKey, job: "collect", source: "roblox-charts", status: "running", startedAt });
  let availableSorts: RobloxSort[] = [];
  try {
    availableSorts = await client.getSorts();
    for (const sortId of settings.collection.charts) {
      const fallback = availableSorts.find((sort) => sort.sortId === sortId);
      try {
        const sort = await client.getSortContent(sortId);
        addSortDiscoveries(discoveries, sort);
      } catch (error) {
        if (fallback) addSortDiscoveries(discoveries, fallback);
        errors.push({ source: `roblox:${sortId}`, message: errorMessage(error) });
      }
    }
  } catch (error) {
    errors.push({ source: "roblox-charts", message: errorMessage(error) });
  }

  const knownPlaceIds = new Set(discoveries.map((item) => String(item.chartGame.rootPlaceId)));
  if (settings.collection.rolimonsEnabled) {
    await recordSourceRun({ runKey, job: "collect", source: "rolimons", status: "running", startedAt });
    try {
      const candidates = (await getRolimonsGames())
        .filter((game) => !knownPlaceIds.has(game.placeId))
        .sort((a, b) => b.ccu - a.ccu)
        .slice(0, settings.collection.rolimonsCandidates);
      const resolved = await mapWithConcurrency(candidates, 4, async (candidate) => {
        try {
          const universeId = await client.resolveUniverseId(candidate.placeId);
          return {
            chart: "Rolimon's discovery",
            source: "rolimons",
            rank: null,
            chartGame: {
              universeId: Number(universeId),
              rootPlaceId: Number(candidate.placeId),
              name: candidate.name,
              playerCount: candidate.ccu,
            },
          } satisfies Discovery;
        } catch (error) {
          errors.push({ source: "rolimons-place-resolution", message: `${candidate.placeId}: ${errorMessage(error)}` });
          return null;
        }
      });
      discoveries.push(...resolved.filter((item) => item !== null));
      await recordSourceRun({
        runKey,
        job: "collect",
        source: "rolimons",
        status: errors.some((error) => error.source.startsWith("rolimons")) ? "partial" : "success",
        items: resolved.filter(Boolean).length,
        startedAt,
        finishedAt: new Date(),
        error: errors.find((error) => error.source.startsWith("rolimons"))?.message,
      });
    } catch (error) {
      errors.push({ source: "rolimons", message: errorMessage(error) });
      await recordSourceRun({
        runKey,
        job: "collect",
        source: "rolimons",
        status: "error",
        startedAt,
        finishedAt: new Date(),
        error: errorMessage(error),
      });
    }
  }

  const universeIds = [...new Set(discoveries.map((item) => String(item.chartGame.universeId)))];
  let details: RobloxGameDetail[] = [];
  let thumbnails = new Map<string, string>();
  if (universeIds.length) {
    try {
      details = await client.getGameDetails(universeIds);
    } catch (error) {
      errors.push({ source: "roblox-games", message: errorMessage(error) });
    }
    try {
      thumbnails = await client.getThumbnails(universeIds);
    } catch (error) {
      errors.push({ source: "roblox-thumbnails", message: errorMessage(error) });
    }
  }
  const detailMap = new Map(details.map((detail) => [String(detail.id), detail]));
  const collected = discoveries
    .map((discovery) => toCollectedGame(discovery, detailMap.get(String(discovery.chartGame.universeId)), thumbnails))
    .filter((game): game is CollectedGame => game !== null);
  const saved = await saveCollectedGames(collected, now, settings);
  await recordSourceRun({
    runKey,
    job: "collect",
    source: "roblox-charts",
    status: errors.some((error) => error.source.startsWith("roblox")) ? "partial" : "success",
    items: saved.snapshots,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) => error.source.startsWith("roblox"))?.message,
  });

  logger.info("Collection completed", { games: saved.games, snapshots: saved.snapshots, errors: errors.length });
  return { collectedAt: now, ...saved, errors };
}

function addSortDiscoveries(target: Discovery[], sort: RobloxSort): void {
  sort.games.forEach((chartGame, index) => {
    target.push({ chart: sort.sortDisplayName, source: "roblox-charts", rank: index + 1, chartGame });
  });
}

function toCollectedGame(
  discovery: Discovery,
  detail: RobloxGameDetail | undefined,
  thumbnails: Map<string, string>,
): CollectedGame | null {
  if (!detail) return null;
  const universeId = String(detail.id);
  return {
    universeId,
    rootPlaceId: String(detail.rootPlaceId),
    name: detail.name,
    description: detail.description,
    creatorId: String(detail.creator.id),
    creatorName: detail.creator.name,
    creatorType: detail.creator.type,
    createdAt: detail.created,
    updatedAt: detail.updated,
    ccu: detail.playing,
    visits: detail.visits,
    favorites: detail.favoritedCount,
    thumbnailUrl: thumbnails.get(universeId) ?? null,
    genre: detail.genre_l1 || detail.genre || null,
    chart: discovery.chart,
    rank: discovery.rank,
    source: discovery.source,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
