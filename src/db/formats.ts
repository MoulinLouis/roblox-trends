import { sql } from "drizzle-orm";
import { FORMAT_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export type FormatDimension = "family" | "template" | "reward_loop" | "family_reward_loop";

// One format in one complete UTC week (format_weeks, drizzle/0016_format_weeks.sql). CCU figures are averages over the
// days the market has readings for; `games` and `marketGames` are the games with a reading that week.
export interface FormatWeek {
  dimension: FormatDimension;
  format: string;
  weekStart: Date;
  // "top": the radar then tracked only the biggest games; "full": the whole active set.
  coverage: "top" | "full";
  marketGames: number;
  marketCcu: number;
  games: number;
  ccuAverage: number;
  // The format's average CCU over the market's; null when the market has no readings that week.
  share: number | null;
  // The format's game with the highest average CCU; null in a week without readings.
  leaderUniverseId: number | null;
  leaderName: string | null;
  leaderCcu: number | null;
  // The leader's average CCU the week before; null without readings.
  leaderPreviousCcu: number | null;
  leaderShare: number | null;
  // Games created in the week, those whose hit window has ended by as_of, and the matured ones that reached the thresholds.
  entrants: number;
  entrantsMatured: number;
  hitsSmall: number;
  hitsLarge: number;
}

export interface FormatWeeksQuery {
  asOf: Date;
  dimension?: FormatDimension;
  // Case-insensitive.
  format?: string;
}

// A type, not an interface: db.execute requires rows assignable to Record<string, unknown>.
type FormatWeekRow = {
  dimension: FormatDimension;
  format: string;
  week_start: Date | string;
  coverage: "top" | "full";
  market_games: number;
  market_ccu: number;
  games: number;
  ccu_avg: number;
  share: number | null;
  leader_universe_id: string | null;
  leader_name: string | null;
  leader_ccu: number | null;
  leader_previous_ccu: number | null;
  leader_share: number | null;
  entrants: number;
  entrants_matured: number;
  hits_small: number;
  hits_large: number;
};

// The part of FORMAT_CONFIG that format_weeks reads, with widened types so tests can pass other values.
export interface FormatWeeksConfig {
  weeks: number;
  fullCoverageFrom: string;
  hitDays: number;
  hitThresholds: { small: number; large: number };
}

export async function formatWeeks(
  db: Database,
  query: FormatWeeksQuery,
  config: FormatWeeksConfig = FORMAT_CONFIG,
): Promise<FormatWeek[]> {
  const result = await db.execute<FormatWeekRow>(sql`
    select * from format_weeks(
      as_of => ${query.asOf.toISOString()}::timestamptz,
      weeks => ${config.weeks}::int,
      full_coverage_from => ${config.fullCoverageFrom}::date,
      hit_days => ${config.hitDays}::int,
      hit_small => ${config.hitThresholds.small}::int,
      hit_large => ${config.hitThresholds.large}::int,
      dimension_filter => ${query.dimension ?? null}::text,
      format_filter => ${query.format ?? null}::text
    )
  `);
  return result.rows.map((row) => ({
    dimension: row.dimension,
    format: row.format,
    weekStart: new Date(row.week_start),
    coverage: row.coverage,
    marketGames: row.market_games,
    marketCcu: row.market_ccu,
    games: row.games,
    ccuAverage: row.ccu_avg,
    share: row.share,
    leaderUniverseId: row.leader_universe_id === null ? null : Number(row.leader_universe_id),
    leaderName: row.leader_name,
    leaderCcu: row.leader_ccu,
    leaderPreviousCcu: row.leader_previous_ccu,
    leaderShare: row.leader_share,
    entrants: row.entrants,
    entrantsMatured: row.entrants_matured,
    hitsSmall: row.hits_small,
    hitsLarge: row.hits_large,
  }));
}

export type FormatPhase = "small" | "unknown" | "emerging" | "rising" | "declining" | "plateau";

// One format in the latest complete week, with its trends over the window and its phase (format_stats,
// drizzle/0017_format_stats.sql).
export interface FormatStat {
  dimension: FormatDimension;
  format: string;
  weekStart: Date;
  coverage: "top" | "full";
  games: number;
  ccuAverage: number;
  share: number;
  // The newest half of the window's shares over the oldest half's; null when the oldest half has no readings.
  shareTrend: number | null;
  leaderUniverseId: number | null;
  leaderName: string | null;
  leaderShare: number | null;
  // The same ratio over the latest week's leader's own CCU.
  leaderTrend: number | null;
  // Sums over the window's weeks.
  entrants: number;
  entrantsMatured: number;
  hitsSmall: number;
  hitsLarge: number;
  // The first day a game of the format peaked at the wave CCU; null when none did.
  firstWaveDay: Date | null;
  waveAgeDays: number | null;
  // The wave starts on the first day of the radar's history, so it may have begun earlier.
  waveBeforeHistory: boolean | null;
  // The followers with a matured 14-day window and a reading in it, and the median of their peaks.
  followers: number;
  followersMedianPeak: number | null;
  phase: FormatPhase;
  // The measured value and the threshold that gave the phase.
  phaseRule: string;
}

export interface FormatStatsQuery {
  asOf: Date;
}

type FormatStatRow = {
  dimension: FormatDimension;
  format: string;
  week_start: Date | string;
  coverage: "top" | "full";
  games: number;
  ccu_avg: number;
  share: number;
  share_trend: number | null;
  leader_universe_id: string | null;
  leader_name: string | null;
  leader_share: number | null;
  leader_trend: number | null;
  entrants: number;
  entrants_matured: number;
  hits_small: number;
  hits_large: number;
  first_wave_day: Date | string | null;
  wave_age_days: number | null;
  wave_before_history: boolean | null;
  followers: number;
  followers_median_peak: number | null;
  phase: FormatPhase;
  phase_rule: string;
};

// The part of FORMAT_CONFIG that format_stats reads, with widened types so tests can pass other values.
export interface FormatStatsConfig {
  fullCoverageFrom: string;
  hitDays: number;
  hitThresholds: { small: number; large: number };
  waveCcu: number;
  followerRanks: { first: number; last: number };
  trendWeeks: number;
  minimumGames: number;
  minimumCcu: number;
  emergingDays: number;
  risingShareRatio: number;
  decliningShareRatio: number;
  leaderCarryShare: number;
}

export async function formatStats(
  db: Database,
  query: FormatStatsQuery,
  config: FormatStatsConfig = FORMAT_CONFIG,
): Promise<FormatStat[]> {
  const result = await db.execute<FormatStatRow>(sql`
    select * from format_stats(
      as_of => ${query.asOf.toISOString()}::timestamptz,
      full_coverage_from => ${config.fullCoverageFrom}::date,
      hit_days => ${config.hitDays}::int,
      hit_small => ${config.hitThresholds.small}::int,
      hit_large => ${config.hitThresholds.large}::int,
      wave_ccu => ${config.waveCcu}::int,
      follower_first => ${config.followerRanks.first}::int,
      follower_last => ${config.followerRanks.last}::int,
      trend_weeks => ${config.trendWeeks}::int,
      minimum_games => ${config.minimumGames}::int,
      minimum_ccu => ${config.minimumCcu}::int,
      emerging_days => ${config.emergingDays}::int,
      rising_ratio => ${config.risingShareRatio}::double precision,
      declining_ratio => ${config.decliningShareRatio}::double precision,
      leader_carry_share => ${config.leaderCarryShare}::double precision
    )
  `);
  return result.rows.map((row) => ({
    dimension: row.dimension,
    format: row.format,
    weekStart: new Date(row.week_start),
    coverage: row.coverage,
    games: row.games,
    ccuAverage: row.ccu_avg,
    share: row.share,
    shareTrend: row.share_trend,
    leaderUniverseId: row.leader_universe_id === null ? null : Number(row.leader_universe_id),
    leaderName: row.leader_name,
    leaderShare: row.leader_share,
    leaderTrend: row.leader_trend,
    entrants: row.entrants,
    entrantsMatured: row.entrants_matured,
    hitsSmall: row.hits_small,
    hitsLarge: row.hits_large,
    firstWaveDay: row.first_wave_day === null ? null : new Date(row.first_wave_day),
    waveAgeDays: row.wave_age_days,
    waveBeforeHistory: row.wave_before_history,
    followers: row.followers,
    followersMedianPeak: row.followers_median_peak,
    phase: row.phase,
    phaseRule: row.phase_rule,
  }));
}
