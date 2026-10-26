import { sql } from "drizzle-orm";
import type { ConceptHistory } from "@/lib/concept/types";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";

// The radar's history of the attempts a concept check found, in four statements whatever their number. Untracked
// universes are absent from the map.
export async function readConceptHistory(db: Database, universeIds: number[], since: Date): Promise<Map<number, ConceptHistory>> {
  const history = new Map<number, ConceptHistory>();
  if (!universeIds.length) return history;
  const ids = sql`${sql.param(universeIds)}::bigint[]`;
  const [tracked, days, versions, sources] = await Promise.all([
    db.execute<{ universe_id: string; name: string; first_observed_at: Date | string }>(sql`
      select universe_id, name, first_observed_at from games where universe_id = any(${ids})
    `),
    db.execute<{ universe_id: string; day: Date | string; ccu_peak: number }>(sql`
      select universe_id, day, ccu_peak from game_daily_all where universe_id = any(${ids}) order by universe_id, day
    `),
    db.execute<{ universe_id: string; name: string }>(sql`
      select universe_id, name from game_versions
      where universe_id = any(${ids}) and kind = 'metadata' and name is not null
      order by universe_id, observed_at, id
    `),
    db.execute<{ universe_id: string; source: DiscoverySource }>(sql`
      select universe_id, source from discovery_sources where universe_id = any(${ids})
      group by universe_id, source order by universe_id, min(first_seen_at), source
    `),
  ]);
  const currentNames = new Map<number, string>();
  for (const row of tracked.rows) {
    const universeId = Number(row.universe_id);
    currentNames.set(universeId, row.name);
    history.set(universeId, {
      firstObservedAt: new Date(row.first_observed_at),
      peakCcu: null,
      peakDay: null,
      daily: [],
      earlierNames: [],
      sources: [],
    });
  }
  for (const row of days.rows) {
    const entry = history.get(Number(row.universe_id));
    if (!entry) continue;
    const day = new Date(row.day);
    const ccuPeak = Number(row.ccu_peak);
    // Days come oldest first, so a tie keeps the first day of the peak.
    if (entry.peakCcu === null || ccuPeak > entry.peakCcu) {
      entry.peakCcu = ccuPeak;
      entry.peakDay = day;
    }
    if (day >= since) entry.daily.push({ day, ccuPeak });
  }
  for (const row of versions.rows) {
    const universeId = Number(row.universe_id);
    const entry = history.get(universeId);
    if (entry && row.name !== currentNames.get(universeId) && !entry.earlierNames.includes(row.name)) entry.earlierNames.push(row.name);
  }
  for (const row of sources.rows) history.get(Number(row.universe_id))?.sources.push(row.source);
  return history;
}
