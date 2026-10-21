import { sql } from "drizzle-orm";
import { ACTIVE_SET_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export interface ActiveUniverse {
  universeId: number;
  priority: number;
}

// Games worth polling, highest priority first so deadline shedding drops the quietest.
// A game's priority is its best CCU evidence from the lookback windows: its hourly peaks, its census count and the
// CCU stored by its latest poll or promotion. The stored CCU counts only while it is recent: a game that Roblox stops
// returning (deleted, or malformed in every response) would otherwise stay active forever and degrade every run.
export async function selectActiveUniverses(db: Database, now: Date): Promise<ActiveUniverse[]> {
  const config = ACTIVE_SET_CONFIG;
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; priority: number }>(sql`
    with recent as (
      select universe_id, max(ccu_max) as peak
      from game_hourly
      where bucket > ${at}::timestamptz - make_interval(hours => ${config.lookbackHours}::int)
      group by universe_id
    ),
    census_now as (
      select p.universe_id, max(c.ccu) as ccu
      from census_observations c
      join places p on p.place_id = c.place_id
      where c.observed_at > ${at}::timestamptz - make_interval(mins => ${config.censusLookbackMinutes}::int)
        and p.universe_id is not null
      group by p.universe_id
    ),
    candidates as (
      select
        g.universe_id,
        g.roblox_created_at,
        g.last_ccu,
        g.last_ccu_at,
        greatest(
          coalesce(r.peak, 0),
          coalesce(c.ccu, 0),
          case
            when g.last_ccu_at > ${at}::timestamptz - make_interval(hours => ${config.lookbackHours}::int) then g.last_ccu
            else 0
          end
        ) as priority
      from games g
      left join recent r on r.universe_id = g.universe_id
      left join census_now c on c.universe_id = g.universe_id
    )
    select universe_id, priority::int as priority
    from candidates
    where priority >= ${config.minimumCcu}
       or (
         roblox_created_at > ${at}::timestamptz - make_interval(days => ${config.recentGameMaximumAgeDays}::int)
         and last_ccu > 0
         and last_ccu_at > ${at}::timestamptz - make_interval(days => ${config.recentGameActivityDays}::int)
       )
    order by priority desc, universe_id
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), priority: Number(row.priority) }));
}
