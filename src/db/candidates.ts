import { sql } from "drizzle-orm";
import { chunk, compareText } from "@/lib/arrays";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoveryCandidates, discoverySources } from "./schema";

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
// the radar first saw it. The candidates Roblox did not answer wait retryHours; those no discovery listed for
// maximumAgeHours are dropped. Every statement locks its rows in key order, like the other writers of these tables, so
// it cannot deadlock with them. Returns the number of games whose sightings moved.
export async function settleCandidates(
  db: Database,
  now: Date,
  unanswered: number[],
  options: { maximumAgeHours: number },
): Promise<number> {
  const at = now.toISOString();
  // One transaction: a sighting is deleted from the queue only together with the discovery row it becomes.
  const moved = await db.transaction(async (transaction) => {
    const deleted = await transaction.execute<{
      universe_id: string;
      source: DiscoverySource;
      detail: string;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
    }>(sql`
      with tracked as materialized (
        select c.universe_id, c.source, c.detail
        from discovery_candidates c
        where exists (select 1 from games g where g.universe_id = c.universe_id)
        order by c.universe_id, c.source, c.detail
        for update of c
      )
      delete from discovery_candidates c
      using tracked t
      where c.universe_id = t.universe_id and c.source = t.source and c.detail = t.detail
      returning c.universe_id, c.source, c.detail, c.first_seen_at, c.last_seen_at
    `);
    const rows = deleted.rows
      .map((row) => ({
        universeId: Number(row.universe_id),
        source: row.source,
        detail: row.detail,
        firstSeenAt: new Date(row.first_seen_at),
        lastSeenAt: new Date(row.last_seen_at),
      }))
      .sort(compareKeys);
    for (const part of chunk(rows, 1_000)) {
      await transaction
        .insert(discoverySources)
        .values(part)
        .onConflictDoUpdate({
          target: [discoverySources.universeId, discoverySources.source, discoverySources.detail],
          set: {
            firstSeenAt: sql`least(${discoverySources.firstSeenAt}, excluded.first_seen_at)`,
            lastSeenAt: sql`greatest(${discoverySources.lastSeenAt}, excluded.last_seen_at)`,
          },
        });
    }
    const earliest = new Map<number, Date>();
    for (const row of rows) {
      const seen = earliest.get(row.universeId);
      if (!seen || row.firstSeenAt < seen) earliest.set(row.universeId, row.firstSeenAt);
    }
    if (earliest.size) {
      const sightings = sql.join(
        [...earliest].map(([universeId, firstSeenAt]) => sql`(${universeId}::bigint, ${firstSeenAt.toISOString()}::timestamptz)`),
        sql`, `,
      );
      await transaction.execute(sql`
        with earliest (universe_id, first_seen_at) as (values ${sightings}),
        locked as materialized (
          select g.universe_id, e.first_seen_at
          from games g
          join earliest e on e.universe_id = g.universe_id
          where g.first_observed_at > e.first_seen_at
          order by g.universe_id
          for update of g
        )
        update games g set first_observed_at = l.first_seen_at
        from locked l
        where g.universe_id = l.universe_id
      `);
    }
    return earliest.size;
  });
  if (unanswered.length) {
    await db.execute(sql`
      with locked as materialized (
        select universe_id, source, detail from discovery_candidates
        where universe_id = any(${sql.param(unanswered)}::bigint[])
        order by universe_id, source, detail
        for update
      )
      update discovery_candidates c set attempted_at = ${at}::timestamptz
      from locked l
      where c.universe_id = l.universe_id and c.source = l.source and c.detail = l.detail
    `);
  }
  await db.execute(sql`
    with stale as materialized (
      select universe_id, source, detail from discovery_candidates
      where last_seen_at <= ${at}::timestamptz - make_interval(hours => ${options.maximumAgeHours}::int)
      order by universe_id, source, detail
      for update
    )
    delete from discovery_candidates c
    using stale s
    where c.universe_id = s.universe_id and c.source = s.source and c.detail = s.detail
  `);
  return moved;
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

function compareKeys(left: Omit<CandidateRow, "playerCount">, right: Omit<CandidateRow, "playerCount">): number {
  return left.universeId - right.universeId || compareText(left.source, right.source) || compareText(left.detail, right.detail);
}
