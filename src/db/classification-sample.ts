import { sql } from "drizzle-orm";
import type { ClassificationInput } from "@/lib/classify/types";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import type { Database } from "./client";

export interface SampleOptions {
  now: Date;
  seed: string;
  requiredUniverseIds: readonly number[];
  quotas: Readonly<Record<string, number>>;
  excludeUniverseIds: readonly number[];
}

const REQUIRED = "required";
const ESTABLISHED = "established";

// Inputs ordered by stratum (in CLASSIFICATION_CONFIG.sample order: required, the waves, the young buckets,
// established), then by the seeded hash. The hash makes a draw reproducible, and an excluded game gives its place to the
// next one of its stratum. Required games take no quota.
export async function readClassificationSample(db: Database, options: SampleOptions): Promise<ClassificationInput[]> {
  const { youngDays, waves, youngPeakBuckets } = CLASSIFICATION_CONFIG.sample;
  const strata: string[] = [REQUIRED, ...waves.map((wave) => wave.stratum), ...youngPeakBuckets.map((bucket) => bucket.stratum), ESTABLISHED];
  // A misspelt stratum would otherwise draw nothing, silently.
  const unknown = Object.keys(options.quotas).filter((stratum) => !strata.includes(stratum));
  if (unknown.length) throw new Error(`Sample quotas name unknown strata: ${unknown.join(", ")}`);
  const quotas = strata.map((stratum) => options.quotas[stratum] ?? 0);

  const peak = sql`coalesce(p.peak_ccu, 0)`;
  const young = sql`g.roblox_created_at > ${options.now.toISOString()}::timestamptz - make_interval(days => ${youngDays}::int)`;
  // The first branch that applies sets the stratum: a required game that matches a wave stays required.
  const stratum = sql.join(
    [
      sql`when g.universe_id = any(${sql.param([...options.requiredUniverseIds])}::bigint[]) then ${REQUIRED}::text`,
      ...waves.map((wave) => sql`when g.name ~* ${wave.pattern}::text then ${wave.stratum}::text`),
      ...youngPeakBuckets.map((bucket) =>
        bucket.below === null
          ? sql`when ${young} then ${bucket.stratum}::text`
          : sql`when ${young} and ${peak} < ${bucket.below}::int then ${bucket.stratum}::text`,
      ),
    ],
    sql`\n`,
  );
  const result = await db.execute<{
    universe_id: string;
    name: string;
    description: string;
    genre: string | null;
    thumbnail_url: string | null;
    roblox_created_at: Date | string;
    peak_ccu: number | string;
    stratum: string;
  }>(sql`
    with peaks as (
      select universe_id, max(ccu_peak) as peak_ccu from game_daily_all group by universe_id
    ),
    classified as (
      select g.universe_id, g.name, g.description, g.genre, g.thumbnail_url, g.roblox_created_at, ${peak} as peak_ccu,
        case ${stratum} else ${ESTABLISHED}::text end as stratum
      from games g
      left join peaks p on p.universe_id = g.universe_id
      where g.universe_id <> all(${sql.param([...options.excludeUniverseIds])}::bigint[])
    ),
    ranked as (
      select c.*,
        row_number() over (partition by c.stratum order by md5(c.universe_id::text || ${options.seed}::text), c.universe_id) as draw
      from classified c
    )
    select r.universe_id, r.name, r.description, r.genre, r.thumbnail_url, r.roblox_created_at, r.peak_ccu, r.stratum
    from ranked r
    join unnest(${sql.param(strata)}::text[], ${sql.param(quotas)}::int[]) with ordinality as s(stratum, quota, position)
      on s.stratum = r.stratum
    where r.stratum = ${REQUIRED}::text or r.draw <= s.quota
    order by s.position, r.draw
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    description: row.description,
    genre: row.genre,
    thumbnailUrl: row.thumbnail_url,
    robloxCreatedAt: new Date(row.roblox_created_at).toISOString(),
    peakCcu: Number(row.peak_ccu),
    stratum: row.stratum,
  }));
}
