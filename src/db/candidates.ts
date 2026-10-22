import { sql } from "drizzle-orm";
import { chunk, compareText } from "@/lib/arrays";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoveryCandidates } from "./schema";

export interface CandidateSighting {
  universeId: number;
  source: DiscoverySource;
  detail: string;
  playerCount: number;
  seenAt: Date;
}

export interface PromotionCandidate {
  universeId: number;
  // The highest CCU its sources listed it with at their latest sightings.
  playerCount: number;
}

// Queues universes the games table does not hold. A sighting already queued widens its window and takes the CCU of
// the latest sighting.
export async function enqueueCandidates(db: Database, sightings: CandidateSighting[]): Promise<void> {
  // Rows are locked in key order, so concurrent writers of the same candidates cannot deadlock.
  const rows = mergeByKey(sightings).sort(compareKeys);
  for (const part of chunk(rows, 1_000)) {
    await db
      .insert(discoveryCandidates)
      .values(
        part.map((row) => ({ ...row, playerCount: Math.round(row.playerCount) })),
      )
      .onConflictDoUpdate({
        target: [discoveryCandidates.universeId, discoveryCandidates.source, discoveryCandidates.detail],
        set: {
          playerCount: sql`case when excluded.last_seen_at >= ${discoveryCandidates.lastSeenAt} then excluded.player_count else ${discoveryCandidates.playerCount} end`,
          firstSeenAt: sql`least(${discoveryCandidates.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${discoveryCandidates.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
}

// The busiest queued universes that are still untracked, listed again within maximumAgeHours, and either never
// requested or requested at least retryHours ago.
export async function selectPromotionCandidates(
  db: Database,
  now: Date,
  options: { limit: number; maximumAgeHours: number; retryHours: number },
): Promise<PromotionCandidate[]> {
  if (options.limit <= 0) return [];
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string; player_count: number }>(sql`
    select c.universe_id, max(c.player_count) as player_count
    from discovery_candidates c
    where not exists (select 1 from games g where g.universe_id = c.universe_id)
    group by c.universe_id
    having max(c.last_seen_at) > ${at}::timestamptz - make_interval(hours => ${options.maximumAgeHours}::int)
      and (
        max(c.attempted_at) is null
        or max(c.attempted_at) <= ${at}::timestamptz - make_interval(hours => ${options.retryHours}::int)
      )
    order by max(c.player_count) desc, c.universe_id
    limit ${options.limit}::int
  `);
  return result.rows.map((row) => ({ universeId: Number(row.universe_id), playerCount: Number(row.player_count) }));
}

// After a poll run: the sightings of every game the games table now holds (promoted by this run or by another job)
// become its discovery rows, and the earliest of them its first observation, so its discovery path still starts when
// the radar first saw it. The requested candidates still untracked were not answered: they wait retryHours. Candidates
// no discovery listed for maximumAgeHours are dropped. Returns the number of games whose sightings moved.
export async function settleCandidates(
  db: Database,
  now: Date,
  requested: number[],
  options: { maximumAgeHours: number },
): Promise<number> {
  const at = now.toISOString();
  const moved = await db.execute<{ universe_id: string }>(sql`
    with tracked as (
      -- Locked in key order, like enqueueCandidates, so a concurrent explore run cannot deadlock with this one.
      select c.universe_id, c.source, c.detail
      from discovery_candidates c
      where exists (select 1 from games g where g.universe_id = c.universe_id)
      order by c.universe_id, c.source, c.detail
      for update of c
    ),
    moved as (
      delete from discovery_candidates c
      using tracked t
      where c.universe_id = t.universe_id and c.source = t.source and c.detail = t.detail
      returning c.universe_id, c.source, c.detail, c.first_seen_at, c.last_seen_at
    ),
    recorded as (
      insert into discovery_sources (universe_id, source, detail, first_seen_at, last_seen_at)
      select universe_id, source, detail, first_seen_at, last_seen_at from moved
      on conflict (universe_id, source, detail) do update set
        first_seen_at = least(discovery_sources.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(discovery_sources.last_seen_at, excluded.last_seen_at)
    ),
    earliest as (
      select universe_id, min(first_seen_at) as first_seen_at from moved group by universe_id
    ),
    observed as (
      update games g set first_observed_at = e.first_seen_at
      from earliest e
      where g.universe_id = e.universe_id and g.first_observed_at > e.first_seen_at
    )
    select universe_id from earliest
  `);
  if (requested.length) {
    const ids = sql.join(
      requested.map((universeId) => sql`${universeId}::bigint`),
      sql`, `,
    );
    await db.execute(sql`update discovery_candidates set attempted_at = ${at}::timestamptz where universe_id in (${ids})`);
  }
  await db.execute(sql`
    delete from discovery_candidates
    where last_seen_at <= ${at}::timestamptz - make_interval(hours => ${options.maximumAgeHours}::int)
  `);
  return moved.rows.length;
}

interface CandidateRow {
  universeId: number;
  source: DiscoverySource;
  detail: string;
  playerCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

// Duplicates of one key keep the widest seen window and the CCU of their latest sighting, the highest on a tie.
function mergeByKey(sightings: CandidateSighting[]): CandidateRow[] {
  const merged = new Map<string, CandidateRow>();
  for (const { seenAt, ...sighting } of sightings) {
    const key = `${sighting.universeId}:${sighting.source}:${sighting.detail}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...sighting, firstSeenAt: seenAt, lastSeenAt: seenAt });
      continue;
    }
    const later = seenAt.getTime() - existing.lastSeenAt.getTime();
    merged.set(key, {
      ...existing,
      playerCount: later > 0 ? sighting.playerCount : later < 0 ? existing.playerCount : Math.max(existing.playerCount, sighting.playerCount),
      firstSeenAt: seenAt < existing.firstSeenAt ? seenAt : existing.firstSeenAt,
      lastSeenAt: later > 0 ? seenAt : existing.lastSeenAt,
    });
  }
  return [...merged.values()];
}

function compareKeys(left: CandidateRow, right: CandidateRow): number {
  return left.universeId - right.universeId || compareText(left.source, right.source) || compareText(left.detail, right.detail);
}
