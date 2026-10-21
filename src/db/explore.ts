import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface RisingSeed {
  universeId: number;
  name: string;
  // Average hourly CCU of the current window, and of the same window a day earlier (0 when the game had none).
  currentCcu: number;
  previousCcu: number;
  growth: number;
}

export interface RisingSeedOptions {
  count: number;
  maximumAgeDays: number;
  currentWindowHours: number;
  previousWindowOffsetHours: number;
  smoothingCcu: number;
  minimumCurrentCcu: number;
}

// Young games whose CCU grew the most over the last day, used as exploration seeds. Growth is the log ratio of the
// current window's average hourly CCU to the same window a day earlier, both smoothed by `smoothingCcu`, so a small
// game that grew tenfold outranks a large one that grew a fifth. Only growing games are seeds. Both windows end at
// `now`, so a replay of an earlier hour sees only what existed then.
export async function selectRisingSeeds(db: Database, now: Date, options: RisingSeedOptions): Promise<RisingSeed[]> {
  const at = now.toISOString();
  const currentHours = options.currentWindowHours;
  const offsetHours = options.previousWindowOffsetHours;
  const result = await db.execute<{ universe_id: string; name: string; current_ccu: number; previous_ccu: number; growth: number }>(sql`
    with current_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - make_interval(hours => ${currentHours}::int)
        and bucket <= ${at}::timestamptz
      group by universe_id
    ),
    previous_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - make_interval(hours => ${offsetHours + currentHours}::int)
        and bucket <= ${at}::timestamptz - make_interval(hours => ${offsetHours}::int)
      group by universe_id
    ),
    candidates as (
      select g.universe_id, g.name, cw.ccu as current_ccu, coalesce(pw.ccu, 0) as previous_ccu
      from games g
      join current_window cw on cw.universe_id = g.universe_id
      left join previous_window pw on pw.universe_id = g.universe_id
      where g.roblox_created_at > ${at}::timestamptz - make_interval(days => ${options.maximumAgeDays}::int)
        and cw.ccu >= ${options.minimumCurrentCcu}::float8
        -- No data a day ago means no players only for a game already tracked then, or created since. A game found
        -- later had an unknown CCU then: it cannot be ranked.
        and (
          pw.universe_id is not null
          or g.first_observed_at <= ${at}::timestamptz - make_interval(hours => ${offsetHours}::int)
          or g.roblox_created_at > ${at}::timestamptz - make_interval(hours => ${offsetHours + currentHours}::int)
        )
    )
    select
      universe_id,
      name,
      current_ccu::float8 as current_ccu,
      previous_ccu::float8 as previous_ccu,
      ln((current_ccu + ${options.smoothingCcu}::float8) / (previous_ccu + ${options.smoothingCcu}::float8))::float8 as growth
    from candidates
    where current_ccu > previous_ccu
    order by growth desc, universe_id
    limit ${options.count}::int
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    currentCcu: Number(row.current_ccu),
    previousCcu: Number(row.previous_ccu),
    growth: Number(row.growth),
  }));
}
