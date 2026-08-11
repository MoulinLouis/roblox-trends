import type { AppSettings, CollectedGame, CollectionError } from "./types";
import { HttpError } from "./api/http";
import {
  RobloxClient,
  type RobloxChartGame,
  type RobloxGameDetail,
  type RobloxGameVote,
  type RobloxSort,
} from "./api/roblox";
import { getRolimonsGames } from "./api/rolimons";
import { errorMessage, logger } from "./logger";
import { COLLECTION_DISCOVERY_CONFIG } from "./config";
import {
  floorToBucket,
  getCollectionSearchKeywords,
  getRecommendationSeedIds,
  getTrackableUniverseIds,
  recordSourceRun,
  saveCollectedGames,
} from "@/db/repository";

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

  await collectSearchDiscoveries(client, discoveries, errors, runKey, startedAt);
  await collectRecommendationDiscoveries(client, discoveries, errors, runKey, startedAt);

  const discoveredUniverseIds = new Set(discoveries.map((item) => String(item.chartGame.universeId)));
  let trackedUniverseIds: string[] = [];
  try {
    trackedUniverseIds = await getTrackableUniverseIds(now);
  } catch (error) {
    errors.push({ source: "roblox-tracked", message: errorMessage(error) });
  }
  const universeIds = [...new Set([...discoveredUniverseIds, ...trackedUniverseIds])];
  let details: RobloxGameDetail[] = [];
  let votes: RobloxGameVote[] = [];
  let thumbnails = new Map<string, string>();
  if (universeIds.length) {
    details = (
      await fetchChunks(universeIds, 50, 1, (chunk) => client.getGameDetails(chunk), "roblox-games", errors)
    ).flat();
    votes = (
      await fetchChunks(universeIds, 50, 1, (chunk) => client.getGameVotes(chunk), "roblox-votes", errors)
    ).flat();
    try {
      thumbnails = await client.getThumbnails([...discoveredUniverseIds]);
    } catch (error) {
      errors.push({ source: "roblox-thumbnails", message: errorMessage(error) });
    }
  }
  const voteMap = new Map(votes.map((vote) => [String(vote.id), vote]));
  const discoveriesByUniverse = new Map<string, Discovery[]>();
  for (const discovery of discoveries) {
    const universeId = String(discovery.chartGame.universeId);
    const entries = discoveriesByUniverse.get(universeId) ?? [];
    entries.push(discovery);
    discoveriesByUniverse.set(universeId, entries);
  }
  const collected = details.flatMap((detail) => {
    const universeId = String(detail.id);
    const matchedDiscoveries = discoveriesByUniverse.get(universeId);
    if (matchedDiscoveries?.length) {
      return matchedDiscoveries.map((discovery) =>
        toCollectedGame(discovery, detail, voteMap.get(universeId), thumbnails),
      );
    }
    return [toCollectedGame({
      chart: "Direct tracking",
      source: "roblox-tracked",
      rank: null,
      chartGame: {
        universeId: detail.id,
        rootPlaceId: detail.rootPlaceId,
        name: detail.name,
        playerCount: detail.playing,
      },
    }, detail, voteMap.get(universeId), thumbnails)];
  });
  const saved = await saveCollectedGames(collected, now, settings);
  await recordSourceRun({
    runKey,
    job: "collect",
    source: "roblox-charts",
    status: errors.some((error) =>
      error.source === "roblox-charts" ||
      error.source === "roblox-games" ||
      error.source === "roblox-thumbnails" ||
      error.source.startsWith("roblox:"),
    ) ? "partial" : "success",
    items: saved.snapshots,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) =>
      error.source === "roblox-charts" ||
      error.source === "roblox-games" ||
      error.source === "roblox-thumbnails" ||
      error.source.startsWith("roblox:"),
    )?.message,
  });
  await recordSourceRun({
    runKey,
    job: "collect",
    source: "roblox-tracked",
    status: errors.some((error) => error.source === "roblox-tracked") ? "partial" : "success",
    items: collected.filter((item) => item.source === "roblox-tracked").length,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) => error.source === "roblox-tracked")?.message,
  });
  await recordSourceRun({
    runKey,
    job: "collect",
    source: "roblox-votes",
    status: errors.some((error) => error.source === "roblox-votes") ? "partial" : "success",
    items: votes.length,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) => error.source === "roblox-votes")?.message,
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
  detail: RobloxGameDetail,
  vote: RobloxGameVote | undefined,
  thumbnails: Map<string, string>,
): CollectedGame {
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
    upVotes: vote?.upVotes ?? discovery.chartGame.totalUpVotes ?? null,
    downVotes: vote?.downVotes ?? discovery.chartGame.totalDownVotes ?? null,
    isSponsored: discovery.chartGame.isSponsored ?? null,
    thumbnailUrl: thumbnails.get(universeId) ?? null,
    genre: detail.genre_l1 || detail.genre || null,
    chart: discovery.chart,
    rank: discovery.rank,
    source: discovery.source,
  };
}

async function collectSearchDiscoveries(
  client: RobloxClient,
  discoveries: Discovery[],
  errors: CollectionError[],
  runKey: string,
  startedAt: Date,
): Promise<void> {
  const source = "roblox-search";
  const keywords = await getCollectionSearchKeywords(COLLECTION_DISCOVERY_CONFIG.maximumSearchKeywords);
  if (!keywords.length) return;
  await recordSourceRun({ runKey, job: "collect", source, status: "running", startedAt });
  let items = 0;
  for (const keyword of keywords) {
    try {
      const games = (await client.searchGames(keyword)).slice(0, COLLECTION_DISCOVERY_CONFIG.searchResultsPerKeyword);
      addGameDiscoveries(discoveries, games, `Search: ${keyword}`, source);
      items += games.length;
    } catch (error) {
      errors.push({ source, message: `${keyword}: ${errorMessage(error)}` });
    }
  }
  await recordSourceRun({
    runKey,
    job: "collect",
    source,
    status: errors.some((error) => error.source === source) ? "partial" : "success",
    items,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) => error.source === source)?.message,
  });
}

async function collectRecommendationDiscoveries(
  client: RobloxClient,
  discoveries: Discovery[],
  errors: CollectionError[],
  runKey: string,
  startedAt: Date,
): Promise<void> {
  const source = "roblox-recommendations";
  const seeds = await getRecommendationSeedIds(COLLECTION_DISCOVERY_CONFIG.maximumRecommendationSeeds);
  if (!seeds.length) return;
  await recordSourceRun({ runKey, job: "collect", source, status: "running", startedAt });
  let items = 0;
  for (const seed of seeds) {
    try {
      const games = await client.getRecommendations(seed, COLLECTION_DISCOVERY_CONFIG.recommendationsPerSeed);
      addGameDiscoveries(discoveries, games, `Recommendations from ${seed}`, source);
      items += games.length;
    } catch (error) {
      errors.push({ source, message: `${seed}: ${errorMessage(error)}` });
    }
  }
  await recordSourceRun({
    runKey,
    job: "collect",
    source,
    status: errors.some((error) => error.source === source) ? "partial" : "success",
    items,
    startedAt,
    finishedAt: new Date(),
    error: errors.find((error) => error.source === source)?.message,
  });
}

function addGameDiscoveries(
  target: Discovery[],
  games: RobloxChartGame[],
  chart: string,
  source: string,
): void {
  games.forEach((chartGame, index) => target.push({ chart, source, rank: index + 1, chartGame }));
}

async function fetchChunks<T>(
  items: string[],
  chunkSize: number,
  concurrency: number,
  fetcher: (chunk: string[]) => Promise<T[]>,
  source: string,
  errors: CollectionError[],
): Promise<T[][]> {
  const chunks = Array.from({ length: Math.ceil(items.length / chunkSize) }, (_, index) =>
    items.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const fetchResilientChunk = async (chunk: string[], splitDepth = 0): Promise<T[]> => {
    try {
      return await fetcher(chunk);
    } catch (error) {
      if (error instanceof HttpError && error.status === 400 && chunk.length > 1 && splitDepth < 2) {
        const midpoint = Math.ceil(chunk.length / 2);
        const left = await fetchResilientChunk(chunk.slice(0, midpoint), splitDepth + 1);
        const right = await fetchResilientChunk(chunk.slice(midpoint), splitDepth + 1);
        return [...left, ...right];
      }
      errors.push({ source, message: `${chunk[0]}…${chunk.at(-1)}: ${errorMessage(error)}` });
      return [];
    }
  };
  return mapWithConcurrency(chunks, concurrency, (chunk) => fetchResilientChunk(chunk));
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
