import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface RisingSeed {
  universeId: number;
  name: string;
  gain: number;
}

// Young games with the largest CCU gain over the last day, used as exploration seeds. The gain compares the average
// hourly CCU of the last six hours with the same six hours a day earlier; a game without data a day earlier rises from
// zero. A game whose CCU did not grow is not rising, so it is never a seed.
export async function selectRisingSeeds(db: Database, now: Date, count: number, maximumAgeDays: number): Promise<RisingSeed[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; name: string; gain: number }>(sql`
    with current_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - interval '6 hours'
      group by universe_id
    ),
    previous_window as (
      select universe_id, avg(ccu_avg) as ccu
      from game_hourly
      where bucket > ${at}::timestamptz - interval '30 hours' and bucket <= ${at}::timestamptz - interval '24 hours'
      group by universe_id
    )
    select g.universe_id, g.name, (cw.ccu - coalesce(pw.ccu, 0))::float8 as gain
    from games g
    join current_window cw on cw.universe_id = g.universe_id
    left join previous_window pw on pw.universe_id = g.universe_id
    where g.roblox_created_at > ${at}::timestamptz - make_interval(days => ${maximumAgeDays}::int)
      and cw.ccu > coalesce(pw.ccu, 0)
    order by gain desc, g.universe_id
    limit ${count}
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), name: row.name, gain: Number(row.gain) }));
}
