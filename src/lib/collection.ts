import { randomUUID } from "node:crypto";
import type { AppSettings, CollectedGame, CollectionError } from "./types";
import { clearResponseCache, getHttpRequestMetrics, HttpError } from "./api/http";
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
import { classifyCollectionHealth, selectRotatingWindow, type CollectionHealth } from "./collection-health";
import {
  createCollectionAttempt,
  finishCollectionAttempt,
  floorToBucket,
  getCollectionSearchKeywords,
  getRecommendationSeedIds,
  getTrackableUniverseIds,
  getUniverseIdsByRootPlaceIds,
  recordSourceRun,
  saveCollectedGames,
} from "@/db/repository";

export interface CollectionResult {
  attemptId: string;
  collectedAt: Date;
  bucketAt: Date;
  games: number;
  snapshots: number;
  snapshotsBySource: Record<string, number>;
  details: Record<string, unknown>;
  health: CollectionHealth;
  errors: CollectionError[];
}

interface Discovery {
  chart: string;
  source: string;
  rank: number | null;
  chartGame: RobloxChartGame;
}

interface DiscoveryStats {
  discovered: number;
  attempted: number;
  completed: number;
  cached?: number;
  resolved?: number;
  labels?: string[];
}

interface CollectionContext {
  attemptId: string;
  runKey: string;
  startedAt: Date;
}

export async function collectRobloxData(
  settings: AppSettings,
  now = new Date(),
  trigger = "manual",
): Promise<CollectionResult> {
  clearResponseCache();
  const bucketAt = floorToBucket(now, settings.collection.intervalMinutes);
  const runKey = `collect:${bucketAt.toISOString()}`;
  const attemptId = randomUUID();
  const startedAt = new Date();
  await createCollectionAttempt({
    id: attemptId,
    runKey,
    bucketAt,
    trigger,
    status: "running",
    startedAt,
    details: {},
  });

  try {
    const result = await executeCollection(settings, now, bucketAt, { attemptId, runKey, startedAt });
    await finishCollectionAttempt(attemptId, {
      status: result.health.status,
      games: result.games,
      snapshots: result.snapshots,
      errorCount: result.errors.length,
      error: result.health.reasons[0] ?? null,
      details: result.details,
      finishedAt: new Date(),
    });
    logger.info("Collection completed", {
      attemptId,
      health: result.health.status,
      games: result.games,
      snapshots: result.snapshots,
      errors: result.errors.length,
      http: getHttpRequestMetrics(),
    });
    return result;
  } catch (error) {
    await finishCollectionAttempt(attemptId, {
      status: "critical",
      errorCount: 1,
      error: errorMessage(error),
      details: { http: getHttpRequestMetrics() },
      finishedAt: new Date(),
    });
    throw error;
  }
}

async function executeCollection(
  settings: AppSettings,
  now: Date,
  bucketAt: Date,
  context: CollectionContext,
): Promise<CollectionResult> {
  const client = new RobloxClient(settings.collection.country, settings.collection.device);
  const errors: CollectionError[] = [];
  const discoveries: Discovery[] = [];

  await startSourceRun(context, "roblox-charts");
  let availableSorts: RobloxSort[] = [];
  let completedCharts = 0;
  try {
    availableSorts = await client.getSorts();
  } catch (error) {
    errors.push({ source: "roblox-chart-catalog", message: errorMessage(error) });
  }
  for (const sortId of settings.collection.charts) {
    const fallback = availableSorts.find((sort) => sort.sortId === sortId);
    try {
      const sort = await client.getSortContent(sortId);
      addSortDiscoveries(discoveries, sort);
      completedCharts += 1;
    } catch (error) {
      if (fallback) {
        addSortDiscoveries(discoveries, fallback);
        completedCharts += 1;
      }
      errors.push({ source: `roblox:${sortId}`, message: errorMessage(error) });
    }
  }

  const searchStats = await collectSearchDiscoveries(
    client,
    discoveries,
    errors,
    context,
    bucketAt,
    settings.collection.intervalMinutes,
  );
  const rolimonsStats = settings.collection.rolimonsEnabled
    ? await collectRolimonsDiscoveries(client, discoveries, errors, context, settings.collection.rolimonsCandidates)
    : null;
  const recommendationStats = await collectRecommendationDiscoveries(client, discoveries, errors, context);

  const discoveredUniverseIds = new Set(discoveries.map((item) => String(item.chartGame.universeId)));
  let trackedUniverseIds: string[] = [];
  await startSourceRun(context, "roblox-tracked");
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
    await Promise.all([
      startSourceRun(context, "roblox-games"),
      startSourceRun(context, "roblox-votes"),
    ]);
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
  const persisted = (source: string) => saved.snapshotsBySource[source] ?? 0;
  await Promise.all([
    finishSourceRun(context, "roblox-charts", persisted("roblox-charts"), relevantErrors(errors, (source) =>
      source === "roblox-chart-catalog" || source === "roblox-games" || source === "roblox-thumbnails" || source.startsWith("roblox:"),
    )),
    finishSourceRun(context, "roblox-tracked", persisted("roblox-tracked"), relevantErrors(errors, (source) =>
      source === "roblox-tracked" || source === "roblox-games",
    )),
    ...(universeIds.length ? [finishSourceRun(
      context,
      "roblox-games",
      details.length,
      relevantErrors(errors, (source) => source === "roblox-games"),
    )] : []),
    finishSourceRun(context, "roblox-votes", votes.length, relevantErrors(errors, (source) => source === "roblox-votes")),
    ...(searchStats ? [finishSourceRun(
      context,
      "roblox-search",
      persisted("roblox-search"),
      relevantErrors(errors, (source) => source === "roblox-search" || source === "roblox-games"),
      searchStats.discovered,
    )] : []),
    ...(rolimonsStats ? [finishSourceRun(
      context,
      "rolimons",
      persisted("rolimons"),
      relevantErrors(errors, (source) => source.startsWith("rolimons") || source === "roblox-games"),
      rolimonsStats.discovered,
    )] : []),
    ...(recommendationStats ? [finishSourceRun(
      context,
      "roblox-recommendations",
      persisted("roblox-recommendations"),
      relevantErrors(errors, (source) => source === "roblox-recommendations" || source === "roblox-games"),
      recommendationStats.discovered,
    )] : []),
  ]);

  const health = classifyCollectionHealth({
    errors,
    snapshots: saved.snapshots,
    expectedCharts: settings.collection.charts.length,
    completedCharts,
    expectedGames: universeIds.length,
    completedGames: details.length,
  });
  const detailsBySource = {
    charts: { attempted: settings.collection.charts.length, completed: completedCharts },
    search: searchStats,
    rolimons: rolimonsStats,
    recommendations: recommendationStats,
  };
  return {
    attemptId: context.attemptId,
    collectedAt: now,
    bucketAt,
    ...saved,
    details: {
      discovery: detailsBySource,
      enrichment: { requested: universeIds.length, completed: details.length, votes: votes.length },
      snapshotsBySource: saved.snapshotsBySource,
      healthReasons: health.reasons,
      http: getHttpRequestMetrics(),
    },
    health,
    errors,
  };
}

async function collectRolimonsDiscoveries(
  client: RobloxClient,
  discoveries: Discovery[],
  errors: CollectionError[],
  context: CollectionContext,
  candidateLimit: number,
): Promise<DiscoveryStats> {
  const source = "rolimons";
  await startSourceRun(context, source);
  const knownPlaceIds = new Set(discoveries.map((item) => String(item.chartGame.rootPlaceId)));
  try {
    const candidates = (await getRolimonsGames())
      .filter((game) => !knownPlaceIds.has(game.placeId))
      .sort((a, b) => b.ccu - a.ccu)
      .slice(0, candidateLimit);
    const knownUniverseIds = await getUniverseIdsByRootPlaceIds(candidates.map((candidate) => candidate.placeId));
    let cached = 0;
    let resolved = 0;
    const mapped = await mapWithConcurrency(candidates, 4, async (candidate) => {
      try {
        const cachedUniverseId = knownUniverseIds.get(candidate.placeId);
        const universeId = cachedUniverseId ?? await client.resolveUniverseId(candidate.placeId);
        if (cachedUniverseId) cached += 1;
        else resolved += 1;
        return {
          chart: "Rolimon's discovery",
          source,
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
    const completed = mapped.filter((item) => item !== null);
    discoveries.push(...completed);
    return { attempted: candidates.length, completed: completed.length, discovered: completed.length, cached, resolved };
  } catch (error) {
    errors.push({ source, message: errorMessage(error) });
    return { attempted: 0, completed: 0, discovered: 0, cached: 0, resolved: 0 };
  }
}

async function collectSearchDiscoveries(
  client: RobloxClient,
  discoveries: Discovery[],
  errors: CollectionError[],
  context: CollectionContext,
  bucketAt: Date,
  intervalMinutes: number,
): Promise<DiscoveryStats | null> {
  const source = "roblox-search";
  const availableKeywords = await getCollectionSearchKeywords(COLLECTION_DISCOVERY_CONFIG.maximumSearchKeywords);
  const keywords = selectRotatingWindow(
    availableKeywords,
    COLLECTION_DISCOVERY_CONFIG.searchKeywordsPerRun,
    bucketAt,
    intervalMinutes,
  );
  if (!keywords.length) return null;
  await startSourceRun(context, source);
  let items = 0;
  let completed = 0;
  for (const keyword of keywords) {
    try {
      const games = (await client.searchGames(keyword)).slice(0, COLLECTION_DISCOVERY_CONFIG.searchResultsPerKeyword);
      addGameDiscoveries(discoveries, games, `Search: ${keyword}`, source);
      items += games.length;
      completed += 1;
    } catch (error) {
      errors.push({ source, message: `${keyword}: ${errorMessage(error)}` });
      if (error instanceof HttpError && error.status === 429) break;
    }
  }
  return { attempted: keywords.length, completed, discovered: items, labels: keywords };
}

async function collectRecommendationDiscoveries(
  client: RobloxClient,
  discoveries: Discovery[],
  errors: CollectionError[],
  context: CollectionContext,
): Promise<DiscoveryStats | null> {
  const source = "roblox-recommendations";
  const seeds = await getRecommendationSeedIds(COLLECTION_DISCOVERY_CONFIG.maximumRecommendationSeeds);
  if (!seeds.length) return null;
  await startSourceRun(context, source);
  let items = 0;
  let completed = 0;
  for (const seed of seeds) {
    try {
      const games = await client.getRecommendations(seed, COLLECTION_DISCOVERY_CONFIG.recommendationsPerSeed);
      addGameDiscoveries(discoveries, games, `Recommendations from ${seed}`, source);
      items += games.length;
      completed += 1;
    } catch (error) {
      errors.push({ source, message: `${seed}: ${errorMessage(error)}` });
    }
  }
  return { attempted: seeds.length, completed, discovered: items, labels: seeds };
}

async function startSourceRun(context: CollectionContext, source: string): Promise<void> {
  await recordSourceRun({
    attemptId: context.attemptId,
    runKey: context.runKey,
    job: "collect",
    source,
    status: "running",
    startedAt: context.startedAt,
  });
}

async function finishSourceRun(
  context: CollectionContext,
  source: string,
  items: number,
  errors: CollectionError[],
  discovered = items,
): Promise<void> {
  const missingPersistence = discovered > 0 && items === 0;
  await recordSourceRun({
    attemptId: context.attemptId,
    runKey: context.runKey,
    job: "collect",
    source,
    status: errors.length || missingPersistence ? "partial" : "success",
    items,
    startedAt: context.startedAt,
    finishedAt: new Date(),
    error: errors[0]?.message ?? (missingPersistence ? "Discovery produced no persisted snapshots." : null),
  });
}

function relevantErrors(errors: CollectionError[], predicate: (source: string) => boolean): CollectionError[] {
  return errors.filter((error) => predicate(error.source));
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
