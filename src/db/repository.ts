import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { classifyGame, normalizeTitle } from "@/lib/classification";
import {
  COLLECTION_DISCOVERY_CONFIG,
  DEFAULT_SETTINGS,
  LEGACY_ROBLOX_CHARTS,
  RISING_GAMES_CONFIG,
} from "@/lib/config";
import type { AppSettings, CollectedGame, GameSnapshotPoint, GameTag } from "@/lib/types";
import type { ScheduledJobName } from "@/lib/scheduler-types";
import type {
  DiscoveryFrontierState,
  RisingGameEventType,
  RisingGameSignalCandidate,
  RisingGameTier,
} from "@/lib/rising-game-types";
import { getDatabase } from "./index";
import {
  alertEvents,
  collectionAttempts,
  dailySnapshots,
  discoveryFrontier,
  gameAnalyses,
  gameMetadataHistory,
  games,
  gameTags,
  generatedArtifacts,
  ideas,
  risingGameEvents,
  risingGameSignals,
  scheduledJobRuns,
  schedulerLocks,
  settings as settingsTable,
  snapshots,
  sourceRuns,
  trendGames,
  trendHistory,
  trends,
} from "./schema";

export type GameRow = typeof games.$inferSelect;
export type GameAnalysisRow = typeof gameAnalyses.$inferSelect;
export type GameMetadataHistoryRow = typeof gameMetadataHistory.$inferSelect;
export type TrendRow = typeof trends.$inferSelect;
export type IdeaRow = typeof ideas.$inferSelect;
export type SourceRunRow = typeof sourceRuns.$inferSelect;
export type CollectionAttemptRow = typeof collectionAttempts.$inferSelect;
export type ScheduledJobRunRow = typeof scheduledJobRuns.$inferSelect;
export type RisingGameSignalRow = typeof risingGameSignals.$inferSelect;
export type RisingGameEventRow = typeof risingGameEvents.$inferSelect;
export type DiscoveryFrontierRow = typeof discoveryFrontier.$inferSelect;

export interface GameDatasetItem {
  game: GameRow;
  tags: GameTag[];
  snapshots: GameSnapshotPoint[];
  metadataHistory: GameMetadataHistoryRow[];
  analysis: GameAnalysisRow | null;
}

export function floorToBucket(date: Date, intervalMinutes: number): Date {
  const milliseconds = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / milliseconds) * milliseconds);
}

export function collectionIdentity(game: CollectedGame, bucketAt: Date): string {
  return [game.universeId, bucketAt.toISOString(), game.source, game.chart].join(":");
}

export function deduplicateCollection(gamesToSave: CollectedGame[], bucketAt: Date): CollectedGame[] {
  const unique = new Map<string, CollectedGame>();
  for (const game of gamesToSave) unique.set(collectionIdentity(game, bucketAt), game);
  return [...unique.values()];
}

export async function getSettings(): Promise<AppSettings> {
  const database = getDatabase();
  const [row] = await database.select().from(settingsTable).where(eq(settingsTable.id, "default")).limit(1);
  if (row) return mergeSettings(row.value);
  await database.insert(settingsTable).values({ id: "default", value: DEFAULT_SETTINGS }).onConflictDoNothing();
  return structuredClone(DEFAULT_SETTINGS);
}

export async function saveSettings(value: AppSettings): Promise<void> {
  const database = getDatabase();
  await database
    .insert(settingsTable)
    .values({ id: "default", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.id, set: { value, updatedAt: new Date() } });
}

export function mergeSettings(value: Partial<AppSettings>): AppSettings {
  const configuredCharts = value.collection?.charts;
  const charts = configuredCharts && !sameStringSet(configuredCharts, LEGACY_ROBLOX_CHARTS)
    ? configuredCharts
    : DEFAULT_SETTINGS.collection.charts;
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...value,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...value.thresholds },
    momentumWeights: { ...DEFAULT_SETTINGS.momentumWeights, ...value.momentumWeights },
    opportunityWeights: { ...DEFAULT_SETTINGS.opportunityWeights, ...value.opportunityWeights },
    collection: {
      ...DEFAULT_SETTINGS.collection,
      ...value.collection,
      intervalMinutes: DEFAULT_SETTINGS.collection.intervalMinutes,
      charts: [...charts],
    },
    taxonomy: { ...DEFAULT_SETTINGS.taxonomy, ...value.taxonomy },
    developerProfile: { ...DEFAULT_SETTINGS.developerProfile, ...value.developerProfile },
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export async function saveCollectedGames(
  collectedGames: CollectedGame[],
  collectedAt: Date,
  appSettings: AppSettings,
): Promise<{ games: number; snapshots: number; snapshotsBySource: Record<string, number> }> {
  const database = getDatabase();
  const bucketAt = floorToBucket(collectedAt, appSettings.collection.intervalMinutes);
  const uniqueSnapshots = deduplicateCollection(collectedGames, bucketAt);
  const snapshotsBySource: Record<string, number> = {};
  for (const snapshot of uniqueSnapshots) {
    snapshotsBySource[snapshot.source] = (snapshotsBySource[snapshot.source] ?? 0) + 1;
  }
  const latestGames = new Map<string, CollectedGame>();
  for (const game of collectedGames) latestGames.set(game.universeId, game);
  const latestItems = [...latestGames.values()];
  const gameValues = latestItems.map((item) => ({
    universeId: item.universeId,
    rootPlaceId: item.rootPlaceId,
    name: item.name,
    normalizedTitle: normalizeTitle(item.name),
    description: item.description,
    creatorId: item.creatorId,
    creatorName: item.creatorName,
    creatorType: item.creatorType,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    firstSeenAt: collectedAt,
    lastSeenAt: collectedAt,
    thumbnailUrl: item.thumbnailUrl,
    genre: item.genre,
  }));
  const metadataValues = latestItems.map((item) => ({
    universeId: item.universeId,
    fingerprint: createHash("sha256")
      .update(`${item.name}\u0000${item.description}\u0000${item.updatedAt.toISOString()}`)
      .digest("hex"),
    name: item.name,
    normalizedTitle: normalizeTitle(item.name),
    description: item.description,
    gameUpdatedAt: item.updatedAt,
    observedAt: collectedAt,
  }));
  const automaticTagValues = latestItems.flatMap((item) =>
    classifyGame(item.name, item.description, appSettings.taxonomy).map((tag) => ({
      universeId: item.universeId,
      dimension: tag.dimension,
      tag: tag.tag,
      source: tag.source,
    })),
  );
  const snapshotValues = uniqueSnapshots.map((item) => ({
    universeId: item.universeId,
    collectedAt,
    bucketAt,
    ccu: item.ccu,
    visits: item.visits,
    favorites: item.favorites,
    upVotes: item.upVotes,
    downVotes: item.downVotes,
    isSponsored: item.isSponsored,
    chart: item.chart,
    rank: item.rank,
    source: item.source,
  }));

  await database.transaction(async (transaction) => {
    for (const values of chunked(gameValues, 250)) {
      await transaction
        .insert(games)
        .values(values)
        .onConflictDoUpdate({
          target: games.universeId,
          set: {
            rootPlaceId: sql`excluded.root_place_id`,
            name: sql`excluded.name`,
            normalizedTitle: sql`excluded.normalized_title`,
            description: sql`excluded.description`,
            creatorId: sql`excluded.creator_id`,
            creatorName: sql`excluded.creator_name`,
            creatorType: sql`excluded.creator_type`,
            updatedAt: sql`excluded.updated_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            thumbnailUrl: sql`coalesce(excluded.thumbnail_url, ${games.thumbnailUrl})`,
            genre: sql`excluded.genre`,
          },
        });
    }
    for (const values of chunked(metadataValues, 500)) {
      await transaction
        .insert(gameMetadataHistory)
        .values(values)
        .onConflictDoNothing();
    }
    for (const universeIds of chunked(latestItems.map((item) => item.universeId), 500)) {
      await transaction
        .delete(gameTags)
        .where(and(inArray(gameTags.universeId, universeIds), eq(gameTags.source, "automatic")));
    }
    for (const values of chunked(automaticTagValues, 500)) {
      await transaction.insert(gameTags).values(values).onConflictDoNothing();
    }
    for (const values of chunked(snapshotValues, 250)) {
      await transaction
        .insert(snapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [snapshots.universeId, snapshots.bucketAt, snapshots.source, snapshots.chart],
          set: {
            collectedAt: sql`excluded.collected_at`,
            ccu: sql`excluded.ccu`,
            visits: sql`excluded.visits`,
            favorites: sql`excluded.favorites`,
            upVotes: sql`excluded.up_votes`,
            downVotes: sql`excluded.down_votes`,
            isSponsored: sql`excluded.is_sponsored`,
            rank: sql`excluded.rank`,
          },
        });
    }
  });
  return { games: latestGames.size, snapshots: uniqueSnapshots.length, snapshotsBySource };
}

function chunked<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

export async function replaceManualTags(universeId: string, tags: GameTag[]): Promise<void> {
  const database = getDatabase();
  await database.transaction(async (transaction) => {
    await transaction
      .delete(gameTags)
      .where(and(eq(gameTags.universeId, universeId), eq(gameTags.source, "manual")));
    if (tags.length) {
      await transaction.insert(gameTags).values(
        tags.map((tag) => ({ universeId, dimension: tag.dimension, tag: tag.tag, source: "manual" })),
      );
    }
  });
}

export async function loadGameDataset(universeIds?: string[]): Promise<GameDatasetItem[]> {
  if (universeIds && !universeIds.length) return [];
  const database = getDatabase();
  const gameFilter = universeIds ? inArray(games.universeId, universeIds) : undefined;
  const tagFilter = universeIds ? inArray(gameTags.universeId, universeIds) : undefined;
  const analysisFilter = universeIds ? inArray(gameAnalyses.universeId, universeIds) : undefined;
  const metadataFilter = universeIds ? inArray(gameMetadataHistory.universeId, universeIds) : undefined;
  const snapshotFilter = universeIds ? inArray(snapshots.universeId, universeIds) : undefined;
  const dailyFilter = universeIds ? inArray(dailySnapshots.universeId, universeIds) : undefined;
  const [gameRows, tagRows, analysisRows, metadataRows, hourlyRows, dailyRows] = await Promise.all([
    database.select().from(games).where(gameFilter).orderBy(desc(games.lastSeenAt)),
    database.select().from(gameTags).where(tagFilter),
    database.select().from(gameAnalyses).where(analysisFilter),
    database.select().from(gameMetadataHistory).where(metadataFilter).orderBy(asc(gameMetadataHistory.observedAt)),
    database.select().from(snapshots).where(snapshotFilter).orderBy(asc(snapshots.bucketAt)),
    database.select().from(dailySnapshots).where(dailyFilter).orderBy(asc(dailySnapshots.dayAt)),
  ]);
  const tagsByGame = new Map<string, GameTag[]>();
  for (const row of tagRows) {
    const existing = tagsByGame.get(row.universeId) ?? [];
    existing.push({
      dimension: row.dimension as GameTag["dimension"],
      tag: row.tag,
      source: row.source as GameTag["source"],
    });
    tagsByGame.set(row.universeId, existing);
  }
  const analysisByGame = new Map(analysisRows.map((row) => [row.universeId, row]));
  const metadataByGame = new Map<string, GameMetadataHistoryRow[]>();
  for (const row of metadataRows) {
    const history = metadataByGame.get(row.universeId) ?? [];
    history.push(row);
    metadataByGame.set(row.universeId, history);
  }
  const pointsByGame = new Map<string, Map<number, GameSnapshotPoint>>();
  for (const row of dailyRows) {
    addPoint(pointsByGame, row.universeId, {
      collectedAt: row.dayAt,
      ccu: row.averageCcu,
      visits: row.visits,
      favorites: row.favorites,
      upVotes: row.upVotes,
      downVotes: row.downVotes,
      rank: row.bestRank,
    });
  }
  for (const row of hourlyRows) {
    addPoint(pointsByGame, row.universeId, {
      collectedAt: row.bucketAt,
      ccu: row.ccu,
      visits: row.visits,
      favorites: row.favorites,
      upVotes: row.upVotes,
      downVotes: row.downVotes,
      isSponsored: row.isSponsored,
      rank: row.rank,
      chart: row.chart,
      chartRanks: row.rank === null ? {} : { [row.chart]: row.rank },
    });
  }
  return gameRows.map((game) => ({
    game,
    tags: tagsByGame.get(game.universeId) ?? [],
    snapshots: [...(pointsByGame.get(game.universeId)?.values() ?? [])].sort(
      (a, b) => a.collectedAt.getTime() - b.collectedAt.getTime(),
    ),
    metadataHistory: metadataByGame.get(game.universeId) ?? [],
    analysis: analysisByGame.get(game.universeId) ?? null,
  }));
}

function addPoint(
  target: Map<string, Map<number, GameSnapshotPoint>>,
  universeId: string,
  point: GameSnapshotPoint,
): void {
  const points = target.get(universeId) ?? new Map<number, GameSnapshotPoint>();
  const key = point.collectedAt.getTime();
  const current = points.get(key);
  if (!current) {
    points.set(key, point);
  } else {
    current.ccu = Math.max(current.ccu, point.ccu);
    current.visits = Math.max(current.visits, point.visits);
    current.favorites = Math.max(current.favorites, point.favorites);
    current.upVotes = maximumNullable(current.upVotes, point.upVotes);
    current.downVotes = maximumNullable(current.downVotes, point.downVotes);
    current.isSponsored = Boolean(current.isSponsored || point.isSponsored);
    current.chartRanks = { ...current.chartRanks, ...point.chartRanks };
    const preferredChart = preferredChartEntry(current.chartRanks);
    if (preferredChart) {
      current.chart = preferredChart[0];
      current.rank = preferredChart[1];
    } else if (point.rank && (!current.rank || point.rank < current.rank)) {
      current.rank = point.rank;
      current.chart = point.chart;
    }
  }
  target.set(universeId, points);
}

function maximumNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left;
  return Math.max(left, right);
}

function preferredChartEntry(chartRanks: Record<string, number> | undefined): [string, number] | null {
  if (!chartRanks) return null;
  return Object.entries(chartRanks).sort(
    ([leftChart, leftRank], [rightChart, rightRank]) =>
      chartPriority(rightChart) - chartPriority(leftChart) || leftRank - rightRank,
  )[0] ?? null;
}

function chartPriority(chart: string): number {
  const normalized = chart.toLowerCase();
  if (["top playing now", "top trending", "most popular", "top earning"].includes(normalized)) return 3;
  if (["top revisited", "fun with friends", "top rated"].includes(normalized)) return 2;
  if (normalized === "up-and-coming" || normalized.startsWith("trending in ")) return 1;
  return 0;
}

export async function getTrackableUniverseIds(now = new Date()): Promise<string[]> {
  const recentCutoff = new Date(
    now.getTime() - COLLECTION_DISCOVERY_CONFIG.recentGameTrackingDays * 24 * 60 * 60 * 1000,
  );
  const activeCutoff = new Date(
    now.getTime() - COLLECTION_DISCOVERY_CONFIG.activeGameTrackingDays * 24 * 60 * 60 * 1000,
  );
  const rows = await getDatabase()
    .select({ universeId: games.universeId, lastSeenAt: games.lastSeenAt })
    .from(games)
    .leftJoin(
      snapshots,
      and(
        eq(snapshots.universeId, games.universeId),
        gte(snapshots.bucketAt, activeCutoff),
        gte(snapshots.ccu, COLLECTION_DISCOVERY_CONFIG.activeGameMinimumCcu),
      ),
    )
    .where(or(gte(games.createdAt, recentCutoff), gte(snapshots.ccu, COLLECTION_DISCOVERY_CONFIG.activeGameMinimumCcu)))
    .groupBy(games.universeId, games.lastSeenAt)
    .orderBy(desc(games.lastSeenAt))
    .limit(COLLECTION_DISCOVERY_CONFIG.maximumTrackedGames);
  return rows.map((row) => row.universeId);
}

export async function getUniverseIdsByRootPlaceIds(rootPlaceIds: string[]): Promise<Map<string, string>> {
  if (!rootPlaceIds.length) return new Map();
  const rows = await getDatabase()
    .select({ rootPlaceId: games.rootPlaceId, universeId: games.universeId })
    .from(games)
    .where(inArray(games.rootPlaceId, rootPlaceIds));
  return new Map(rows.map((row) => [row.rootPlaceId, row.universeId]));
}

export async function getCollectionSearchKeywords(limit: number): Promise<string[]> {
  const rows = await getDatabase()
    .select({ label: trends.label, stage: trends.stage })
    .from(trends)
    .where(notInArray(trends.stage, ["declining", "saturated"]))
    .orderBy(desc(trends.trendScore))
    .limit(limit * 3);
  return [...new Set(rows.map((row) => row.label.trim()).filter((label) => label.length >= 3))].slice(0, limit);
}

export async function getRecommendationSeedIds(limit: number): Promise<string[]> {
  const recentCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const rows = await getDatabase()
    .select({ universeId: games.universeId })
    .from(gameAnalyses)
    .innerJoin(games, eq(games.universeId, gameAnalyses.universeId))
    .where(gte(games.createdAt, recentCutoff))
    .orderBy(desc(gameAnalyses.momentumScore))
    .limit(limit);
  return rows.map((row) => row.universeId);
}

export async function recordSourceRun(input: {
  attemptId: string;
  runKey: string;
  job: string;
  source: string;
  status: "running" | "success" | "partial" | "error";
  items?: number;
  error?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
}): Promise<void> {
  const database = getDatabase();
  await database
    .insert(sourceRuns)
    .values({ items: 0, finishedAt: null, error: null, ...input })
    .onConflictDoUpdate({
      target: [sourceRuns.attemptId, sourceRuns.source],
      set: {
        runKey: input.runKey,
        job: input.job,
        status: input.status,
        items: input.items ?? 0,
        error: input.error ?? null,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt ?? null,
      },
    });
}

export async function createCollectionAttempt(input: typeof collectionAttempts.$inferInsert): Promise<void> {
  await getDatabase().insert(collectionAttempts).values(input);
}

export async function finishCollectionAttempt(
  id: string,
  values: Partial<Pick<
    typeof collectionAttempts.$inferInsert,
    "status" | "games" | "snapshots" | "errorCount" | "error" | "details" | "finishedAt"
  >>,
): Promise<void> {
  await getDatabase().update(collectionAttempts).set(values).where(eq(collectionAttempts.id, id));
}

export async function hasUsableCollectionAttempt(bucketAt: Date): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: collectionAttempts.id })
    .from(collectionAttempts)
    .where(and(
      eq(collectionAttempts.bucketAt, bucketAt),
      inArray(collectionAttempts.status, ["healthy", "degraded"]),
    ))
    .limit(1);
  return Boolean(row);
}

export async function getRecentCollectionAttempts(limit = 6): Promise<CollectionAttemptRow[]> {
  return getDatabase().select().from(collectionAttempts).orderBy(desc(collectionAttempts.startedAt)).limit(limit);
}

export async function acquireSchedulerLock(input: {
  name: string;
  owner: string;
  now: Date;
  leaseUntil: Date;
}): Promise<boolean> {
  const result = await getDatabase().execute(sql`
    insert into scheduler_locks (name, owner, lease_until, acquired_at)
    values (${input.name}, ${input.owner}, ${input.leaseUntil}, ${input.now})
    on conflict (name) do update set
      owner = excluded.owner,
      lease_until = excluded.lease_until,
      acquired_at = excluded.acquired_at
    where scheduler_locks.lease_until <= excluded.acquired_at
    returning name
  `);
  return resultRows<{ name: string }>(result).length === 1;
}

export async function renewSchedulerLock(input: {
  name: string;
  owner: string;
  leaseUntil: Date;
}): Promise<boolean> {
  const rows = await getDatabase()
    .update(schedulerLocks)
    .set({ leaseUntil: input.leaseUntil })
    .where(and(eq(schedulerLocks.name, input.name), eq(schedulerLocks.owner, input.owner)))
    .returning({ name: schedulerLocks.name });
  return rows.length === 1;
}

export async function releaseSchedulerLock(name: string, owner: string): Promise<void> {
  await getDatabase()
    .delete(schedulerLocks)
    .where(and(eq(schedulerLocks.name, name), eq(schedulerLocks.owner, owner)));
}

export async function acquireScheduledJob(input: {
  id: string;
  jobName: ScheduledJobName;
  scheduledFor: Date;
  owner: string;
  now: Date;
  leaseUntil: Date;
}): Promise<{ id: string; attempt: number } | null> {
  const result = await getDatabase().execute(sql`
    insert into scheduled_job_runs (
      id, job_name, scheduled_for, owner, status, attempt, lease_until, details, started_at
    ) values (
      ${input.id}, ${input.jobName}, ${input.scheduledFor}, ${input.owner}, 'running', 1,
      ${input.leaseUntil}, '{}'::jsonb, ${input.now}
    )
    on conflict (job_name, scheduled_for) do update set
      id = excluded.id,
      owner = excluded.owner,
      status = 'running',
      attempt = scheduled_job_runs.attempt + 1,
      lease_until = excluded.lease_until,
      details = '{}'::jsonb,
      error = null,
      started_at = excluded.started_at,
      finished_at = null
    where scheduled_job_runs.status <> 'success'
      and scheduled_job_runs.lease_until <= excluded.started_at
    returning id, attempt
  `);
  const [row] = resultRows<{ id: string; attempt: number }>(result);
  return row ? { id: row.id, attempt: Number(row.attempt) } : null;
}

export async function finishScheduledJob(input: {
  id: string;
  owner: string;
  status: "success" | "failed";
  now: Date;
  details?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  await getDatabase()
    .update(scheduledJobRuns)
    .set({
      status: input.status,
      leaseUntil: input.now,
      details: input.details ?? {},
      error: input.error ?? null,
      finishedAt: input.now,
    })
    .where(and(eq(scheduledJobRuns.id, input.id), eq(scheduledJobRuns.owner, input.owner)));
}

export async function saveGeneratedArtifact(input: {
  key: string;
  contentType: string;
  textContent?: string | null;
  jsonContent?: Record<string, unknown> | null;
  generatedAt: Date;
}): Promise<void> {
  await getDatabase()
    .insert(generatedArtifacts)
    .values(input)
    .onConflictDoUpdate({
      target: generatedArtifacts.key,
      set: {
        contentType: input.contentType,
        textContent: input.textContent ?? null,
        jsonContent: input.jsonContent ?? null,
        generatedAt: input.generatedAt,
      },
    });
}

export async function getGeneratedArtifact(key: string): Promise<typeof generatedArtifacts.$inferSelect | null> {
  const [row] = await getDatabase()
    .select()
    .from(generatedArtifacts)
    .where(eq(generatedArtifacts.key, key))
    .limit(1);
  return row ?? null;
}

export async function getDataFreshness(): Promise<{
  latestCollectionAt: Date | null;
  latestAnalysisAt: Date | null;
  latestSchedulerCollectionAt: Date | null;
}> {
  const database = getDatabase();
  const [collectionRows, analysisRows, schedulerRows] = await Promise.all([
    database
      .select({ at: collectionAttempts.startedAt })
      .from(collectionAttempts)
      .where(inArray(collectionAttempts.status, ["healthy", "degraded"]))
      .orderBy(desc(collectionAttempts.startedAt))
      .limit(1),
    database
      .select({ at: gameAnalyses.analyzedAt })
      .from(gameAnalyses)
      .orderBy(desc(gameAnalyses.analyzedAt))
      .limit(1),
    database
      .select({ at: scheduledJobRuns.finishedAt })
      .from(scheduledJobRuns)
      .where(and(eq(scheduledJobRuns.jobName, "collect"), eq(scheduledJobRuns.status, "success")))
      .orderBy(desc(scheduledJobRuns.finishedAt))
      .limit(1),
  ]);
  return {
    latestCollectionAt: collectionRows[0]?.at ?? null,
    latestAnalysisAt: analysisRows[0]?.at ?? null,
    latestSchedulerCollectionAt: schedulerRows[0]?.at ?? null,
  };
}

export async function getRecentSourceRuns(limit = 12): Promise<SourceRunRow[]> {
  return getDatabase().select().from(sourceRuns).orderBy(desc(sourceRuns.startedAt)).limit(limit);
}

export async function getTrends(): Promise<TrendRow[]> {
  return getDatabase().select().from(trends).orderBy(desc(trends.opportunityScore));
}

export async function getTrend(id: string): Promise<{
  trend: TrendRow;
  history: (typeof trendHistory.$inferSelect)[];
  games: GameDatasetItem[];
} | null> {
  const database = getDatabase();
  const [trend] = await database.select().from(trends).where(eq(trends.id, id)).limit(1);
  if (!trend) return null;
  const [history, links] = await Promise.all([
    database.select().from(trendHistory).where(eq(trendHistory.trendId, id)).orderBy(asc(trendHistory.dayAt)),
    database.select().from(trendGames).where(eq(trendGames.trendId, id)),
  ]);
  const dataset = await loadGameDataset(links.map((link) => link.universeId));
  return { trend, history, games: dataset };
}

export async function getGame(universeId: string): Promise<GameDatasetItem | null> {
  return (await loadGameDataset([universeId]))[0] ?? null;
}

export async function getTrendIdsForGame(universeId: string): Promise<string[]> {
  const rows = await getDatabase().select().from(trendGames).where(eq(trendGames.universeId, universeId));
  return rows.map((row) => row.trendId);
}

export async function getTrendLinks(): Promise<Array<typeof trendGames.$inferSelect>> {
  return getDatabase().select().from(trendGames);
}

export async function getIdeas(): Promise<IdeaRow[]> {
  return getDatabase().select().from(ideas).orderBy(desc(ideas.recommendationScore), desc(ideas.createdAt));
}

export async function updateIdea(
  id: string,
  patch: Partial<Pick<IdeaRow, "saved" | "rejected" | "rating" | "comment">>,
): Promise<void> {
  await getDatabase()
    .update(ideas)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ideas.id, id));
}

export async function hasAlertEvent(eventKey: string): Promise<boolean> {
  const [row] = await getDatabase().select().from(alertEvents).where(eq(alertEvents.eventKey, eventKey)).limit(1);
  return Boolean(row);
}

export async function recordAlertEvent(
  eventKey: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await getDatabase().insert(alertEvents).values({ eventKey, eventType, payload, sentAt: new Date() }).onConflictDoNothing();
}

export async function replaceRisingGameSignals(
  candidates: RisingGameSignalCandidate[],
  now = new Date(),
): Promise<RisingGameEventRow[]> {
  const database = getDatabase();
  const existingRows = await database.select().from(risingGameSignals);
  const existingByKey = new Map(
    existingRows.map((row) => [`${row.universeId}:${row.signalType}`, row]),
  );
  const eventValues = candidates.flatMap((candidate) => {
    const existing = existingByKey.get(`${candidate.universeId}:${candidate.signalType}`);
    const events: Array<{ eventType: RisingGameEventType; marker: string }> = [];
    if (!existing?.active) {
      events.push({ eventType: "activated", marker: candidate.detectedAt.toISOString() });
    } else if (tierRank(candidate.tier) > tierRank(existing.tier)) {
      events.push({ eventType: "tier_up", marker: candidate.tier });
    } else if (
      candidate.metrics.crossedMilestone &&
      candidate.metrics.crossedMilestone > (existing.metrics.crossedMilestone ?? 0)
    ) {
      events.push({ eventType: "milestone", marker: String(candidate.metrics.crossedMilestone) });
    }
    return events.map(({ eventType, marker }) => ({
      id: [candidate.universeId, candidate.signalType, eventType, marker].join(":"),
      universeId: candidate.universeId,
      signalType: candidate.signalType,
      eventType,
      tier: candidate.tier,
      score: candidate.score,
      currentCcu: candidate.metrics.currentCcu,
      payload: {
        metrics: candidate.metrics,
        reasons: candidate.reasons,
        risks: candidate.risks,
      },
      detectedAt: candidate.detectedAt,
      notifiedAt: null,
    }));
  });

  return database.transaction(async (transaction) => {
    await transaction
      .update(risingGameSignals)
      .set({ active: false, updatedAt: now })
      .where(eq(risingGameSignals.active, true));

    for (const candidate of candidates) {
      await transaction
        .insert(risingGameSignals)
        .values({
          universeId: candidate.universeId,
          signalType: candidate.signalType,
          score: candidate.score,
          tier: candidate.tier,
          confidence: candidate.confidence,
          active: true,
          currentCcu: candidate.metrics.currentCcu,
          metrics: candidate.metrics,
          reasons: candidate.reasons,
          risks: candidate.risks,
          firstDetectedAt: candidate.detectedAt,
          lastDetectedAt: candidate.detectedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [risingGameSignals.universeId, risingGameSignals.signalType],
          set: {
            score: candidate.score,
            tier: candidate.tier,
            confidence: candidate.confidence,
            active: true,
            currentCcu: candidate.metrics.currentCcu,
            metrics: candidate.metrics,
            reasons: candidate.reasons,
            risks: candidate.risks,
            lastDetectedAt: candidate.detectedAt,
            updatedAt: now,
          },
        });
    }

    const insertedEvents: RisingGameEventRow[] = [];
    for (const values of eventValues) {
      const rows = await transaction
        .insert(risingGameEvents)
        .values(values)
        .onConflictDoNothing()
        .returning();
      insertedEvents.push(...rows);
    }
    return insertedEvents;
  });
}

export async function getActiveRisingGameSignals(limit = 100): Promise<RisingGameSignalRow[]> {
  return getDatabase()
    .select()
    .from(risingGameSignals)
    .where(eq(risingGameSignals.active, true))
    .orderBy(desc(risingGameSignals.score), desc(risingGameSignals.currentCcu))
    .limit(limit);
}

export async function getRisingGameSignal(universeId: string): Promise<RisingGameSignalRow | null> {
  const [row] = await getDatabase()
    .select()
    .from(risingGameSignals)
    .where(and(eq(risingGameSignals.universeId, universeId), eq(risingGameSignals.active, true)))
    .orderBy(desc(risingGameSignals.score))
    .limit(1);
  return row ?? null;
}

export async function getPendingRisingGameEvents(
  since: Date,
  minimumScore: number,
  limit = 20,
): Promise<RisingGameEventRow[]> {
  return getDatabase()
    .select()
    .from(risingGameEvents)
    .where(and(
      sql`${risingGameEvents.notifiedAt} is null`,
      gte(risingGameEvents.detectedAt, since),
      gte(risingGameEvents.score, minimumScore),
    ))
    .orderBy(desc(risingGameEvents.score), asc(risingGameEvents.detectedAt))
    .limit(limit);
}

export async function markRisingGameEventsNotified(ids: string[], notifiedAt: Date): Promise<void> {
  if (!ids.length) return;
  await getDatabase()
    .update(risingGameEvents)
    .set({ notifiedAt })
    .where(inArray(risingGameEvents.id, ids));
}

export async function getDiscoveryFrontierStates(): Promise<DiscoveryFrontierRow[]> {
  return getDatabase().select().from(discoveryFrontier);
}

export async function saveDiscoveryFrontierStates(states: DiscoveryFrontierState[]): Promise<void> {
  if (!states.length) return;
  const database = getDatabase();
  const rows = states.map((state) => ({
    placeId: state.placeId,
    name: state.name,
    thumbnailUrl: state.thumbnailUrl,
    currentCcu: state.currentCcu,
    previousCcu: state.previousCcu,
    peakCcu: state.peakCcu,
    score: state.score,
    qualifies: state.qualifies,
    history: state.history,
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
    observations: state.observations,
  }));
  for (const values of chunked(rows, 250)) {
    await database
      .insert(discoveryFrontier)
      .values(values)
      .onConflictDoUpdate({
        target: discoveryFrontier.placeId,
        set: {
          name: sql`excluded.name`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          currentCcu: sql`excluded.current_ccu`,
          previousCcu: sql`excluded.previous_ccu`,
          peakCcu: sql`excluded.peak_ccu`,
          score: sql`excluded.score`,
          qualifies: sql`excluded.qualifies`,
          history: sql`excluded.history`,
          lastSeenAt: sql`excluded.last_seen_at`,
          observations: sql`excluded.observations`,
        },
      });
  }
}

export async function getDiscoveryFrontierCandidatePlaceIds(
  limit: number,
  now = new Date(),
): Promise<string[]> {
  const freshnessCutoff = new Date(
    now.getTime() - RISING_GAMES_CONFIG.frontier.candidateFreshnessHours * 60 * 60 * 1_000,
  );
  const rows = await getDatabase()
    .select({ placeId: discoveryFrontier.placeId })
    .from(discoveryFrontier)
    .where(and(eq(discoveryFrontier.qualifies, true), gte(discoveryFrontier.lastSeenAt, freshnessCutoff)))
    .orderBy(desc(discoveryFrontier.score), desc(discoveryFrontier.currentCcu))
    .limit(limit);
  return rows.map((row) => row.placeId);
}

function tierRank(tier: RisingGameTier): number {
  return { rising: 1, surging: 2, explosive: 3 }[tier];
}

export async function runMaintenance(retentionDays: number): Promise<{ aggregated: number; removed: number }> {
  const database = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  cutoff.setUTCHours(0, 0, 0, 0);
  const [summary] = await database
    .select({ count: sql<number>`count(*)` })
    .from(snapshots)
    .where(lt(snapshots.bucketAt, cutoff));
  const removed = Number(summary.count);
  if (!removed) return { aggregated: 0, removed: 0 };

  let aggregated = 0;
  await database.transaction(async (transaction) => {
    const result = await transaction.execute(sql`
      with hourly as (
        select
          universe_id,
          bucket_at,
          max(ccu)::integer as ccu,
          max(visits)::real as visits,
          max(favorites)::integer as favorites,
          max(up_votes)::integer as up_votes,
          max(down_votes)::integer as down_votes,
          min(rank)::integer as best_rank
        from snapshots
        where bucket_at < ${cutoff}
        group by universe_id, bucket_at
      ), daily as (
        select
          universe_id,
          date_trunc('day', bucket_at) as day_at,
          round(avg(ccu))::integer as average_ccu,
          max(ccu)::integer as peak_ccu,
          max(visits)::real as visits,
          max(favorites)::integer as favorites,
          max(up_votes)::integer as up_votes,
          max(down_votes)::integer as down_votes,
          min(best_rank)::integer as best_rank
        from hourly
        group by universe_id, date_trunc('day', bucket_at)
      ), upserted as (
        insert into daily_snapshots (
          universe_id, day_at, average_ccu, peak_ccu, visits, favorites, up_votes, down_votes, best_rank
        )
        select universe_id, day_at, average_ccu, peak_ccu, visits, favorites, up_votes, down_votes, best_rank
        from daily
        on conflict (universe_id, day_at) do update set
          average_ccu = excluded.average_ccu,
          peak_ccu = excluded.peak_ccu,
          visits = excluded.visits,
          favorites = excluded.favorites,
          up_votes = excluded.up_votes,
          down_votes = excluded.down_votes,
          best_rank = excluded.best_rank
        returning 1
      )
      select count(*)::integer as count from upserted
    `);
    aggregated = Number(resultRows<{ count: number }>(result)[0]?.count ?? 0);
    await transaction.delete(snapshots).where(lt(snapshots.bucketAt, cutoff));
  });
  return { aggregated, removed };
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: T[] }).rows;
  return [];
}

export async function databaseCounts(): Promise<Record<string, number>> {
  const database = getDatabase();
  const tableEntries = { games, snapshots, trends, ideas };
  const result: Record<string, number> = {};
  for (const [name, table] of Object.entries(tableEntries)) {
    const [row] = await database.select({ count: sql<number>`count(*)` }).from(table);
    result[name] = Number(row.count);
  }
  return result;
}
