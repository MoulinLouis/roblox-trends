import { sql } from "drizzle-orm";
import { RADAR_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export const RADAR_SORTS = ["growth", "acceleration", "ccu", "age"] as const;
export type RadarSort = (typeof RADAR_SORTS)[number];

// One row of rising_games (drizzle/0007_rising_games.sql). Sample counts are hourly buckets.
export interface RisingGame {
  universeId: number;
  name: string;
  iconUrl: string | null;
  robloxCreatedAt: Date;
  firstObservedAt: Date;
  // The latest observation of the window; null when none is that recent.
  ccuLast: number | null;
  // Average hourly CCU of the current window.
  ccuAverage: number;
  ccuPeak: number;
  windowPeak: number;
  windowMedian: number;
  isEvent: boolean;
  // Share of tracked CCU now against the same window a week earlier; null without week-ago samples.
  weekGrowth: number | null;
  // The sort key of "growth": null when the game existed a week ago but was not tracked.
  weekGrowthScore: number | null;
  // Average CCU of the window against the window before it.
  dayGrowth: number | null;
  firstSeenCcu: number | null;
  hoursToMiddle: number | null;
  hoursToEnd: number | null;
  samples: number;
  previousSamples: number;
  weekSamples: number;
}

export interface RisingGamesQuery {
  asOf: Date;
  maxAgeDays: number;
  minimumCcu: number;
  sort: RadarSort;
  limit: number;
}

// Every sort ends with the window's average CCU, then the universe id, so the order is stable.
const orderBy: Record<RadarSort, string> = {
  growth: "week_growth_score desc nulls last, ccu_avg desc, universe_id",
  acceleration: "day_growth desc nulls last, ccu_avg desc, universe_id",
  ccu: "ccu_avg desc, universe_id",
  age: "roblox_created_at desc, ccu_avg desc, universe_id",
};

// A type, not an interface: db.execute requires rows assignable to Record<string, unknown>.
type RisingGameRow = {
  universe_id: string;
  name: string;
  icon_url: string | null;
  roblox_created_at: Date | string;
  first_observed_at: Date | string;
  ccu_last: number | null;
  ccu_avg: number;
  ccu_peak: number | null;
  window_peak: number;
  window_median: number;
  is_event: boolean;
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
      velocity_end => ${config.velocityThresholds.end}::int
    )
    order by ${sql.raw(orderBy[query.sort])}
    limit ${query.limit}::int
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    iconUrl: row.icon_url,
    robloxCreatedAt: new Date(row.roblox_created_at),
    firstObservedAt: new Date(row.first_observed_at),
    ccuLast: row.ccu_last,
    ccuAverage: row.ccu_avg,
    ccuPeak: row.ccu_peak ?? 0,
    windowPeak: row.window_peak,
    windowMedian: row.window_median,
    isEvent: row.is_event,
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
