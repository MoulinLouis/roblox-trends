import { sql } from "drizzle-orm";
import { ACTIVE_SET_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export interface ActiveUniverse {
  universeId: number;
  priority: number;
  // Poll's tail lane: young or established.
  robloxCreatedAt: Date;
  // When the game's details were last stored (games.last_ccu_at, set by poll and by every promotion); null when they
  // never were. Poll reports how old they are.
  lastDetailsAt: Date | null;
  // When the game's details were last requested, answered or not: the later of lastDetailsAt and
  // games.details_attempted_at, which poll sets for every game it requests; null when neither is set. Poll rotates its
  // tail on it, so a game Roblox does not answer waits behind the others like a game it polled.
  lastDetailsRequestAt: Date | null;
}

// Games worth polling, highest priority first: poll's hot set is the head of this order, and votes' deadline shedding
// drops the quietest.
// A game's priority is its best CCU evidence from the lookback windows: its hourly peaks, its census count and the
// CCU stored by its latest poll or promotion. The stored CCU counts only while it is recent: a game that Roblox stops
// returning (deleted, or malformed in every response) would otherwise stay active forever and degrade every run.
// A young game stays active for a week after its last players, so one empty poll does not drop it.
export async function selectActiveUniverses(db: Database, now: Date): Promise<ActiveUniverse[]> {
  const config = ACTIVE_SET_CONFIG;
  const at = now.toISOString();
  const result = await db.execute<{
    universe_id: string;
    priority: number;
    roblox_created_at: Date | string;
    last_details_at: Date | string | null;
    last_details_request_at: Date | string | null;
  }>(sql`
    with recent as (
      select universe_id, max(ccu_max) as peak
      from game_hourly
      -- The hour that straddles the window's start counts: its peak may fall inside the window.
      where bucket >= time_bucket(interval '1 hour', ${at}::timestamptz - make_interval(hours => ${config.lookbackHours}::int))
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
        g.last_active_at,
        g.last_ccu_at,
        g.details_attempted_at,
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
    select
      universe_id,
      priority::int as priority,
      roblox_created_at,
      last_ccu_at as last_details_at,
      -- greatest() ignores nulls: null only when the game was neither stored nor requested.
      greatest(last_ccu_at, details_attempted_at) as last_details_request_at
    from candidates
    where priority >= ${config.minimumCcu}
       or (
         roblox_created_at > ${at}::timestamptz - make_interval(days => ${config.recentGameMaximumAgeDays}::int)
         and last_active_at > ${at}::timestamptz - make_interval(days => ${config.recentGameActivityDays}::int)
       )
    order by priority desc, universe_id
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    priority: Number(row.priority),
    robloxCreatedAt: new Date(row.roblox_created_at),
    lastDetailsAt: toDate(row.last_details_at),
    lastDetailsRequestAt: toDate(row.last_details_request_at),
  }));
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}
