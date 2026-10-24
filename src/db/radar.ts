import { sql } from "drizzle-orm";
import { RADAR_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export const RADAR_SORTS = ["growth", "acceleration", "ccu", "age"] as const;
export type RadarSort = (typeof RADAR_SORTS)[number];

// What the week-over-week growth compares with. "tracked": poll read the game in some hour of the current window and
// in the same hour one week earlier. "census": poll did not, but Rolimon's listed its places in both (usually a game
// discovered since). "new": created after the start of the week-ago window. "unlisted": neither, while census stored a
// list in every hour of that window, so the game had too few players for Rolimon's and counts from 0. "unknown": no
// baseline (v1 hours, or a census outage then).
export type WeekBaseline = "tracked" | "census" | "new" | "unlisted" | "unknown";

// One row of rising_games (drizzle/0009_rising_games_execute.sql). Sample counts are hourly buckets.
export interface RisingGame {
  universeId: number;
  name: string;
  iconUrl: string | null;
  robloxCreatedAt: Date;
  firstObservedAt: Date;
  // The latest observation of the window and its time; null when none is that recent.
  ccuLast: number | null;
  ccuLastAt: Date | null;
  // Average hourly CCU of the current window.
  ccuAverage: number;
  ccuPeak: number;
  windowPeak: number;
  windowMedian: number;
  // The average CCU of the window's last hour: an event is a peak the game has come back down from.
  windowLast: number;
  isEvent: boolean;
  weekBaseline: WeekBaseline;
  // Share of tracked CCU now against the same hours a week earlier, among the games read in both; null without such
  // hours, or when the game had 0 CCU a week ago.
  weekGrowth: number | null;
  // The sort key of "growth": null when the week baseline is unknown. New and unlisted games count from 0.
  weekGrowthScore: number | null;
  // Average CCU of the window against the window before it.
  dayGrowth: number | null;
  firstSeenCcu: number | null;
  hoursToMiddle: number | null;
  hoursToEnd: number | null;
  samples: number;
  previousSamples: number;
  // Hours of the current window paired with the same hour a week earlier.
  weekSamples: number;
}

export interface RisingGamesQuery {
  asOf: Date;
  maxAgeDays: number;
  minimumCcu: number;
  sort: RadarSort;
  limit: number;
}

// A type, not an interface: db.execute requires rows assignable to Record<string, unknown>.
type RisingGameRow = {
  sort_rank: number;
  universe_id: string;
  name: string;
  icon_url: string | null;
  roblox_created_at: Date | string;
  first_observed_at: Date | string;
  ccu_last: number | null;
  ccu_last_at: Date | string | null;
  ccu_avg: number;
  ccu_peak: number | null;
  window_peak: number;
  window_median: number;
  window_last: number;
  is_event: boolean;
  week_baseline: WeekBaseline;
  week_growth: number | null;
  week_growth_score: number | null;
  day_growth: number | null;
  first_seen_ccu: number | null;
  hours_to_middle: number | null;
  hours_to_end: number | null;
  samples: number;
  previous_samples: number;
  week_samples: number;
};

// The function sorts and limits the rows itself, so it reads the history behind velocity for the page's rows only.
export async function risingGames(db: Database, query: RisingGamesQuery, config = RADAR_CONFIG): Promise<RisingGame[]> {
  const result = await db.execute<RisingGameRow>(sql`
    select * from rising_games(
      as_of => ${query.asOf.toISOString()}::timestamptz,
      max_age_days => ${query.maxAgeDays}::int,
      min_ccu => ${query.minimumCcu}::int,
      window_hours => ${config.windowHours}::int,
      smoothing_ccu => ${config.smoothingCcu}::double precision,
      event_peak_ratio => ${config.eventPeakToMedianRatio}::double precision,
      event_min_samples => ${config.eventMinimumSamples}::int,
      velocity_start => ${config.velocityThresholds.start}::int,
      velocity_middle => ${config.velocityThresholds.middle}::int,
      velocity_end => ${config.velocityThresholds.end}::int,
      velocity_max_gap_hours => ${config.velocityMaximumGapHours}::int,
      sort_by => ${query.sort}::text,
      row_limit => ${query.limit}::int
    )
    order by sort_rank
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    iconUrl: row.icon_url,
    robloxCreatedAt: new Date(row.roblox_created_at),
    firstObservedAt: new Date(row.first_observed_at),
    ccuLast: row.ccu_last,
    ccuLastAt: row.ccu_last_at === null ? null : new Date(row.ccu_last_at),
    ccuAverage: row.ccu_avg,
    ccuPeak: row.ccu_peak ?? 0,
    windowPeak: row.window_peak,
    windowMedian: row.window_median,
    windowLast: row.window_last,
    isEvent: row.is_event,
    weekBaseline: row.week_baseline,
    weekGrowth: row.week_growth,
    weekGrowthScore: row.week_growth_score,
    dayGrowth: row.day_growth,
    firstSeenCcu: row.first_seen_ccu,
    hoursToMiddle: row.hours_to_middle,
    hoursToEnd: row.hours_to_end,
    samples: row.samples,
    previousSamples: row.previous_samples,
    weekSamples: row.week_samples,
  }));
}
