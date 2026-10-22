import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { GAME_VIEW_CONFIG } from "@/lib/config";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoverySources, gameObservations, games, gameVersions, voteObservations } from "./schema";

const dayMs = 24 * 60 * 60 * 1000;

// Every window is a whole number of 24-hour days, and the SQL ones are in hours, never days: a session time zone with
// daylight saving cannot stretch them.

export interface GameRecord {
  universeId: number;
  rootPlaceId: number;
  name: string;
  description: string;
  creatorName: string;
  creatorType: string;
  genre: string | null;
  robloxCreatedAt: Date;
  firstObservedAt: Date;
  lastCcu: number;
  lastCcuAt: Date | null;
  thumbnailUrl: string | null;
  iconUrl: string | null;
}

export interface Discovery {
  source: DiscoverySource;
  detail: string;
  firstSeenAt: Date;
}

export interface CcuPoint {
  at: Date;
  ccu: number;
}

export interface DailyPoint {
  day: Date;
  peak: number;
  average: number;
  origin: "observed" | "legacy";
}

export interface VersionRecord {
  kind: "metadata" | "thumbnail";
  name: string | null;
  observedAt: Date;
}

export interface ChartPresence {
  sortId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  bestRank: number;
  // The best rank over GAME_VIEW_CONFIG.chartBestRankHours; null when the game was not ranked then.
  bestRankRecent: number | null;
  // Hours ranked over GAME_VIEW_CONFIG.chartRecentDays.
  hoursRecent: number;
}

export interface VoteReading {
  upVotes: number;
  downVotes: number;
  observedAt: Date;
}

// The first and last observations of the engagement window, and the average hourly CCU between them.
export interface EngagementWindow {
  firstAt: Date;
  lastAt: Date;
  firstVisits: number;
  lastVisits: number;
  firstFavorites: number;
  lastFavorites: number;
  ccuAverage: number | null;
}

export interface GameView {
  game: GameRecord;
  // How the radar first found the game; null for games found before v2 recorded discoveries.
  discovery: Discovery | null;
  recent: CcuPoint[];
  daily: DailyPoint[];
  // Oldest first.
  versions: VersionRecord[];
  charts: ChartPresence[];
  votes: VoteReading | null;
  engagement: EngagementWindow | null;
}

export async function readGameView(
  db: Database,
  universeId: number,
  now: Date,
  config = GAME_VIEW_CONFIG,
): Promise<GameView | null> {
  const game = await readGame(db, universeId);
  if (!game) return null;
  const [discovery, recent, daily, versions, charts, votes, engagement] = await Promise.all([
    readDiscovery(db, universeId),
    readRecentCcu(db, universeId, now, config.recentDays),
    readDailyHistory(db, universeId, now),
    readVersions(db, universeId),
    readChartPresence(db, universeId, now, config),
    readLatestVotes(db, universeId, now),
    readEngagementWindow(db, universeId, now, config.engagementDays),
  ]);
  return { game, discovery, recent, daily, versions, charts, votes, engagement };
}

async function readGame(db: Database, universeId: number): Promise<GameRecord | null> {
  const [row] = await db.select().from(games).where(eq(games.universeId, universeId));
  if (!row) return null;
  return {
    universeId: row.universeId,
    rootPlaceId: row.rootPlaceId,
    name: row.name,
    description: row.description,
    creatorName: row.creatorName,
    creatorType: row.creatorType,
    genre: row.genre,
    robloxCreatedAt: row.robloxCreatedAt,
    firstObservedAt: row.firstObservedAt,
    lastCcu: row.lastCcu,
    lastCcuAt: row.lastCcuAt,
    thumbnailUrl: row.thumbnailUrl,
    iconUrl: row.iconUrl,
  };
}

async function readDiscovery(db: Database, universeId: number): Promise<Discovery | null> {
  const [row] = await db
    .select({ source: discoverySources.source, detail: discoverySources.detail, firstSeenAt: discoverySources.firstSeenAt })
    .from(discoverySources)
    .where(eq(discoverySources.universeId, universeId))
    .orderBy(asc(discoverySources.firstSeenAt), asc(discoverySources.source), asc(discoverySources.detail))
    .limit(1);
  return row ?? null;
}

async function readRecentCcu(db: Database, universeId: number, now: Date, days: number): Promise<CcuPoint[]> {
  return db
    .select({ at: gameObservations.observedAt, ccu: gameObservations.ccu })
    .from(gameObservations)
    .where(
      and(
        eq(gameObservations.universeId, universeId),
        gt(gameObservations.observedAt, new Date(now.getTime() - days * dayMs)),
        lte(gameObservations.observedAt, now),
      ),
    )
    .orderBy(asc(gameObservations.observedAt));
}

// game_daily_all merges the v1 daily rows with the daily aggregate of the observations.
async function readDailyHistory(db: Database, universeId: number, now: Date): Promise<DailyPoint[]> {
  const result = await db.execute<{ day: Date | string; ccu_peak: number; ccu_avg: number; origin: "observed" | "legacy" }>(sql`
    select day, ccu_peak, ccu_avg, origin from game_daily_all
    where universe_id = ${universeId}::bigint and day <= ${now.toISOString()}::timestamptz
    order by day
  `);
  return result.rows.map((row) => ({
    day: new Date(row.day),
    peak: Number(row.ccu_peak),
    average: Number(row.ccu_avg),
    origin: row.origin,
  }));
}

async function readVersions(db: Database, universeId: number): Promise<VersionRecord[]> {
  return db
    .select({ kind: gameVersions.kind, name: gameVersions.name, observedAt: gameVersions.observedAt })
    .from(gameVersions)
    .where(eq(gameVersions.universeId, universeId))
    .orderBy(asc(gameVersions.observedAt), asc(gameVersions.id));
}

async function readChartPresence(
  db: Database,
  universeId: number,
  now: Date,
  config: typeof GAME_VIEW_CONFIG,
): Promise<ChartPresence[]> {
  const at = now.toISOString();
  const result = await db.execute<{
    sort_id: string;
    first_seen_at: Date | string;
    last_seen_at: Date | string;
    best_rank: number;
    best_rank_recent: number | null;
    hours_recent: number;
  }>(sql`
    select sort_id, min(observed_at) as first_seen_at, max(observed_at) as last_seen_at, min(rank)::int as best_rank,
      (min(rank) filter (
        where observed_at > ${at}::timestamptz - make_interval(hours => ${config.chartBestRankHours}::int)
      ))::int as best_rank_recent,
      (count(*) filter (
        where observed_at > ${at}::timestamptz - make_interval(hours => ${24 * config.chartRecentDays}::int)
      ))::int as hours_recent
    from chart_placements
    where universe_id = ${universeId}::bigint and observed_at <= ${at}::timestamptz
    group by sort_id
    order by first_seen_at, sort_id
  `);
  return result.rows.map((row) => ({
    sortId: row.sort_id,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    bestRank: row.best_rank,
    bestRankRecent: row.best_rank_recent,
    hoursRecent: row.hours_recent,
  }));
}

async function readLatestVotes(db: Database, universeId: number, now: Date): Promise<VoteReading | null> {
  const [row] = await db
    .select({ upVotes: voteObservations.upVotes, downVotes: voteObservations.downVotes, observedAt: voteObservations.observedAt })
    .from(voteObservations)
    .where(and(eq(voteObservations.universeId, universeId), lte(voteObservations.observedAt, now)))
    .orderBy(desc(voteObservations.observedAt))
    .limit(1);
  return row ?? null;
}

async function readEngagementWindow(db: Database, universeId: number, now: Date, days: number): Promise<EngagementWindow | null> {
  const at = now.toISOString();
  // Visits and favorites are bigint columns: node-postgres returns them as strings.
  const result = await db.execute<{
    first_at: Date | string | null;
    last_at: Date | string | null;
    first_visits: string | null;
    last_visits: string | null;
    first_favorites: string | null;
    last_favorites: string | null;
    ccu_average: number | null;
  }>(sql`
    with window_observations as (
      select observed_at, visits, favorites from game_observations
      where universe_id = ${universeId}::bigint
        and observed_at > ${at}::timestamptz - make_interval(hours => ${24 * days}::int)
        and observed_at <= ${at}::timestamptz
    ),
    bounds as (
      select min(observed_at) as first_at, max(observed_at) as last_at,
        (array_agg(visits order by observed_at))[1] as first_visits,
        (array_agg(visits order by observed_at desc))[1] as last_visits,
        (array_agg(favorites order by observed_at))[1] as first_favorites,
        (array_agg(favorites order by observed_at desc))[1] as last_favorites
      from window_observations
    )
    select b.*, (
      select avg(h.ccu_avg) from game_hourly h
      where h.universe_id = ${universeId}::bigint
        and h.bucket >= time_bucket(interval '1 hour', b.first_at) and h.bucket <= b.last_at
    ) as ccu_average
    from bounds b
  `);
  const row = result.rows[0];
  if (!row?.first_at || !row.last_at) return null;
  return {
    firstAt: new Date(row.first_at),
    lastAt: new Date(row.last_at),
    firstVisits: Number(row.first_visits),
    lastVisits: Number(row.last_visits),
    firstFavorites: Number(row.first_favorites),
    lastFavorites: Number(row.last_favorites),
    ccuAverage: row.ccu_average === null ? null : Number(row.ccu_average),
  };
}
