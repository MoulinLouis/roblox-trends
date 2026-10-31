import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface ExplorationSeed {
  universeId: number;
  name: string;
  // Average hourly CCU over the window.
  ccu: number;
}

export interface ExplorationSeedOptions {
  count: number;
  maximumAgeDays: number;
  windowHours: number;
  minimumCcu: number;
}

// Young games read in the window with at least `minimumCcu` average hourly CCU, busiest first: explore searches the
// words their titles share. The window ends at `now`, so a replay of an earlier hour sees only what existed then.
export async function selectExplorationSeeds(db: Database, now: Date, options: ExplorationSeedOptions): Promise<ExplorationSeed[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; name: string; ccu: number }>(sql`
    select g.universe_id, g.name, avg(h.ccu_avg)::float8 as ccu
    from games g
    join game_hourly h on h.universe_id = g.universe_id
    where g.roblox_created_at > ${at}::timestamptz - make_interval(days => ${options.maximumAgeDays}::int)
      and h.bucket > ${at}::timestamptz - make_interval(hours => ${options.windowHours}::int)
      and h.bucket <= ${at}::timestamptz
    group by g.universe_id, g.name
    having avg(h.ccu_avg) >= ${options.minimumCcu}::float8
    order by ccu desc, g.universe_id
    limit ${options.count}::int
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), name: row.name, ccu: Number(row.ccu) }));
}

// When each term was last searched, from the `terms` stat of the explore runs whose slot falls after `since` and up
// to `now`. Slots, not wall-clock start times, so a replay sees the runs before it.
export async function lastSearchedTerms(db: Database, since: Date, now: Date): Promise<Map<string, Date>> {
  const result = await db.execute<{ term: string; searched_at: Date | string }>(sql`
    select term, max(r.slot) as searched_at
    from job_runs r
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(r.stats -> 'terms') = 'array' then r.stats -> 'terms' else '[]'::jsonb end
    ) as term
    where r.job = 'explore'
      and r.slot > ${since.toISOString()}::timestamptz
      and r.slot <= ${now.toISOString()}::timestamptz
    group by term
  `);
  return new Map(result.rows.map((row) => [row.term, new Date(row.searched_at)]));
}
