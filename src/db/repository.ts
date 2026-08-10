import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { classifyGame, normalizeTitle } from "@/lib/classification";
import { DEFAULT_SETTINGS } from "@/lib/config";
import type { AppSettings, CollectedGame, GameSnapshotPoint, GameTag } from "@/lib/types";
import { getDatabase } from "./index";
import {
  alertEvents,
  dailySnapshots,
  gameAnalyses,
  games,
  gameTags,
  ideas,
  settings as settingsTable,
  snapshots,
  sourceRuns,
  trendGames,
  trendHistory,
  trends,
} from "./schema";

export type GameRow = typeof games.$inferSelect;
export type GameAnalysisRow = typeof gameAnalyses.$inferSelect;
export type TrendRow = typeof trends.$inferSelect;
export type IdeaRow = typeof ideas.$inferSelect;
export type SourceRunRow = typeof sourceRuns.$inferSelect;

export interface GameDatasetItem {
  game: GameRow;
  tags: GameTag[];
  snapshots: GameSnapshotPoint[];
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

function mergeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...value,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...value.thresholds },
    momentumWeights: { ...DEFAULT_SETTINGS.momentumWeights, ...value.momentumWeights },
    opportunityWeights: { ...DEFAULT_SETTINGS.opportunityWeights, ...value.opportunityWeights },
    collection: { ...DEFAULT_SETTINGS.collection, ...value.collection },
    taxonomy: { ...DEFAULT_SETTINGS.taxonomy, ...value.taxonomy },
    developerProfile: { ...DEFAULT_SETTINGS.developerProfile, ...value.developerProfile },
  };
}

export async function saveCollectedGames(
  collectedGames: CollectedGame[],
  collectedAt: Date,
  appSettings: AppSettings,
): Promise<{ games: number; snapshots: number }> {
  const database = getDatabase();
  const bucketAt = floorToBucket(collectedAt, appSettings.collection.intervalMinutes);
  const uniqueSnapshots = deduplicateCollection(collectedGames, bucketAt);
  const latestGames = new Map<string, CollectedGame>();
  for (const game of collectedGames) latestGames.set(game.universeId, game);

  await database.transaction(async (transaction) => {
    for (const item of latestGames.values()) {
      await transaction
        .insert(games)
        .values({
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
        })
        .onConflictDoUpdate({
          target: games.universeId,
          set: {
            rootPlaceId: item.rootPlaceId,
            name: item.name,
            normalizedTitle: normalizeTitle(item.name),
            description: item.description,
            creatorId: item.creatorId,
            creatorName: item.creatorName,
            creatorType: item.creatorType,
            updatedAt: item.updatedAt,
            lastSeenAt: collectedAt,
            thumbnailUrl: item.thumbnailUrl,
            genre: item.genre,
          },
        });

      const automaticTags = classifyGame(item.name, item.description, appSettings.taxonomy);
      await transaction
        .delete(gameTags)
        .where(and(eq(gameTags.universeId, item.universeId), eq(gameTags.source, "automatic")));
      if (automaticTags.length) {
        await transaction
          .insert(gameTags)
          .values(
            automaticTags.map((tag) => ({
              universeId: item.universeId,
              dimension: tag.dimension,
              tag: tag.tag,
              source: tag.source,
            })),
          )
          .onConflictDoNothing();
      }
    }

    for (const item of uniqueSnapshots) {
      await transaction
        .insert(snapshots)
        .values({
          universeId: item.universeId,
          collectedAt,
          bucketAt,
          ccu: item.ccu,
          visits: item.visits,
          favorites: item.favorites,
          chart: item.chart,
          rank: item.rank,
          source: item.source,
        })
        .onConflictDoUpdate({
          target: [snapshots.universeId, snapshots.bucketAt, snapshots.source, snapshots.chart],
          set: {
            collectedAt,
            ccu: item.ccu,
            visits: item.visits,
            favorites: item.favorites,
            rank: item.rank,
          },
        });
    }
  });
  return { games: latestGames.size, snapshots: uniqueSnapshots.length };
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

export async function loadGameDataset(): Promise<GameDatasetItem[]> {
  const database = getDatabase();
  const [gameRows, tagRows, analysisRows, hourlyRows, dailyRows] = await Promise.all([
    database.select().from(games).orderBy(desc(games.lastSeenAt)),
    database.select().from(gameTags),
    database.select().from(gameAnalyses),
    database.select().from(snapshots).orderBy(asc(snapshots.bucketAt)),
    database.select().from(dailySnapshots).orderBy(asc(dailySnapshots.dayAt)),
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
  const pointsByGame = new Map<string, Map<number, GameSnapshotPoint>>();
  for (const row of dailyRows) {
    addPoint(pointsByGame, row.universeId, {
      collectedAt: row.dayAt,
      ccu: row.averageCcu,
      visits: row.visits,
      favorites: row.favorites,
      rank: row.bestRank,
    });
  }
  for (const row of hourlyRows) {
    addPoint(pointsByGame, row.universeId, {
      collectedAt: row.bucketAt,
      ccu: row.ccu,
      visits: row.visits,
      favorites: row.favorites,
      rank: row.rank,
      chart: row.chart,
    });
  }
  return gameRows.map((game) => ({
    game,
    tags: tagsByGame.get(game.universeId) ?? [],
    snapshots: [...(pointsByGame.get(game.universeId)?.values() ?? [])].sort(
      (a, b) => a.collectedAt.getTime() - b.collectedAt.getTime(),
    ),
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
  if (!current || point.ccu > current.ccu) points.set(key, point);
  else if (point.rank && (!current.rank || point.rank < current.rank)) current.rank = point.rank;
  target.set(universeId, points);
}

export async function recordSourceRun(input: {
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
      target: [sourceRuns.runKey, sourceRuns.source],
      set: {
        status: input.status,
        items: input.items ?? 0,
        error: input.error ?? null,
        finishedAt: input.finishedAt ?? null,
      },
    });
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
  const [history, links, dataset] = await Promise.all([
    database.select().from(trendHistory).where(eq(trendHistory.trendId, id)).orderBy(asc(trendHistory.dayAt)),
    database.select().from(trendGames).where(eq(trendGames.trendId, id)),
    loadGameDataset(),
  ]);
  const ids = new Set(links.map((link) => link.universeId));
  return { trend, history, games: dataset.filter((item) => ids.has(item.game.universeId)) };
}

export async function getGame(universeId: string): Promise<GameDatasetItem | null> {
  return (await loadGameDataset()).find((item) => item.game.universeId === universeId) ?? null;
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

export async function runMaintenance(retentionDays: number): Promise<{ aggregated: number; removed: number }> {
  const database = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const oldRows = await database.select().from(snapshots).where(lt(snapshots.bucketAt, cutoff));
  if (!oldRows.length) return { aggregated: 0, removed: 0 };
  const groups = new Map<string, typeof oldRows>();
  for (const row of oldRows) {
    const dayAt = new Date(row.bucketAt);
    dayAt.setUTCHours(0, 0, 0, 0);
    const key = `${row.universeId}:${dayAt.toISOString()}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  await database.transaction(async (transaction) => {
    for (const group of groups.values()) {
      const last = [...group].sort((a, b) => a.bucketAt.getTime() - b.bucketAt.getTime()).at(-1)!;
      const dayAt = new Date(last.bucketAt);
      dayAt.setUTCHours(0, 0, 0, 0);
      const ranked = group.map((row) => row.rank).filter((rank): rank is number => rank !== null);
      await transaction
        .insert(dailySnapshots)
        .values({
          universeId: last.universeId,
          dayAt,
          averageCcu: Math.round(group.reduce((sum, row) => sum + row.ccu, 0) / group.length),
          peakCcu: Math.max(...group.map((row) => row.ccu)),
          visits: last.visits,
          favorites: last.favorites,
          bestRank: ranked.length ? Math.min(...ranked) : null,
        })
        .onConflictDoUpdate({
          target: [dailySnapshots.universeId, dailySnapshots.dayAt],
          set: {
            averageCcu: Math.round(group.reduce((sum, row) => sum + row.ccu, 0) / group.length),
            peakCcu: Math.max(...group.map((row) => row.ccu)),
            visits: last.visits,
            favorites: last.favorites,
            bestRank: ranked.length ? Math.min(...ranked) : null,
          },
        });
    }
    const ids = oldRows.map((row) => row.id);
    for (let offset = 0; offset < ids.length; offset += 500) {
      await transaction.delete(snapshots).where(inArray(snapshots.id, ids.slice(offset, offset + 500)));
    }
  });
  return { aggregated: groups.size, removed: oldRows.length };
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
