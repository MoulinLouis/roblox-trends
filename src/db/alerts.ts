import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { AlertDecision, AlertKind, Breakout, CardFacts, GameFormat, PastAlert, StoredAlert } from "@/lib/alerts/types";
import { ALERT_CONFIG } from "@/lib/config";
import type { Database } from "./client";
import { alerts, games } from "./schema";


export type BreakoutQuery = { createdSince: Date; until: Date };

// A type, not an interface: db.execute requires rows assignable to Record<string, unknown>.
type BreakoutRow = { universe_id: string; created_at: Date | string; crossed_at: Date | string };

// The games created since `createdSince` that read `crossingCcu` before `until`, and when: the first hour in
// game_hourly or in census_hourly (through the game's places), else the first v1 day in game_daily_all (days of the radar's own observations are covered by the hourly reads). A crossing
// more than `maximumAgeDays` after the game's creation is not early, so it is dropped.
export async function readBreakouts(
  db: Database,
  query: BreakoutQuery,
  config = ALERT_CONFIG,
): Promise<Array<Omit<Breakout, "keys" | "classified">>> {
  const since = query.createdSince.toISOString();
  const end = query.until.toISOString();
  // Hours past this are never needed: the age check below would drop them. A day of slack keeps the check exact.
  const scanDays = config.maximumAgeDays + 1;
  const result = await db.execute<BreakoutRow>(sql`
    with young as (
      select universe_id, roblox_created_at
      from games
      where roblox_created_at >= ${since}::timestamptz
    ),
    hourly as (
      select y.universe_id, min(h.bucket) as crossed_at
      from young y
      join game_hourly h on h.universe_id = y.universe_id
      where h.bucket >= ${since}::timestamptz
        and h.bucket < ${end}::timestamptz
        and h.bucket <= y.roblox_created_at + make_interval(days => ${scanDays}::int)
        and h.ccu_max >= ${config.crossingCcu}::int
      group by y.universe_id
    ),
    census as (
      select y.universe_id, min(c.bucket) as crossed_at
      from young y
      join places p on p.universe_id = y.universe_id
      join census_hourly c on c.place_id = p.place_id
      where c.bucket >= ${since}::timestamptz
        and c.bucket < ${end}::timestamptz
        and c.bucket <= y.roblox_created_at + make_interval(days => ${scanDays}::int)
        and c.ccu_max >= ${config.crossingCcu}::int
      group by y.universe_id
    ),
    observed as (
      select coalesce(h.universe_id, c.universe_id) as universe_id, least(h.crossed_at, c.crossed_at) as crossed_at
      from hourly h
      full join census c on c.universe_id = h.universe_id
    ),
    daily as (
      select y.universe_id, min(d.day) as crossed_at
      from young y
      join game_daily_all d on d.universe_id = y.universe_id
      where d.day >= ${since}::timestamptz
        and d.day < ${end}::timestamptz
        and d.day <= y.roblox_created_at + make_interval(days => ${scanDays}::int)
        and d.origin = 'legacy'
        and d.ccu_peak >= ${config.crossingCcu}::int
        and not exists (select 1 from observed o where o.universe_id = y.universe_id)
      group by y.universe_id
    ),
    crossings as (
      select universe_id, crossed_at from observed
      union all
      select universe_id, crossed_at from daily
    )
    select y.universe_id, y.roblox_created_at as created_at, x.crossed_at
    from crossings x
    join young y on y.universe_id = x.universe_id
    where x.crossed_at <= y.roblox_created_at + make_interval(days => ${config.maximumAgeDays}::int)
    order by x.crossed_at, y.universe_id
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    createdAt: new Date(row.created_at),
    crossedAt: new Date(row.crossed_at),
  }));
}

type FormatRow = {
  universe_id: string;
  name: string;
  family: string | null;
  template: string | null;
  core_action: string | null;
};

// Family and template with the owner's merges applied (game_formats); the core action from game_classifications. A game
// without a family has no game_formats row: it is unclassified.
export async function readGameFormats(
  db: Database,
  universeIds: number[],
): Promise<Map<number, GameFormat & { classified: boolean }>> {
  const formats = new Map<number, GameFormat & { classified: boolean }>();
  if (universeIds.length === 0) return formats;
  const result = await db.execute<FormatRow>(sql`
    select g.universe_id, g.name, f.family, f.template, c.core_action
    from games g
    left join game_formats f on f.universe_id = g.universe_id
    left join game_classifications c on c.universe_id = g.universe_id
    where g.universe_id = any(${sql.param(universeIds)}::bigint[])
  `);
  for (const row of result.rows) {
    formats.set(Number(row.universe_id), {
      name: row.name,
      family: row.family,
      template: row.template,
      coreAction: row.core_action,
      classified: row.family !== null,
    });
  }
  return formats;
}

// Every row of `games` is a tracked game: the radar keeps no other set.
export async function readTrackedGames(
  db: Database,
): Promise<Array<{ universeId: number; name: string; robloxCreatedAt: Date | null }>> {
  const rows = await db.select({ universeId: games.universeId, name: games.name, robloxCreatedAt: games.robloxCreatedAt }).from(games);
  return rows;
}

type CardRow = {
  universe_id: string;
  name: string;
  root_place_id: string;
  thumbnail_url: string | null;
  roblox_created_at: Date | string;
  last_ccu: number;
  day_before: number | null;
  up_votes: number | null;
  down_votes: number | null;
  family: string | null;
  template: string | null;
  reward_loop: string | null;
  core_action: string | null;
  peak_ccu: number | null;
};

// `crossedAt` holds each game's crossing hour. The CCU a day before is the peak of the game's hourly bucket 24 hours
// earlier, read like the crossing itself (ccu_max); the peak is the highest daily peak of game_daily_all.
export async function readCardFacts(
  db: Database,
  universeIds: number[],
  crossedAt: Map<number, Date>,
): Promise<Map<number, CardFacts>> {
  const facts = new Map<number, CardFacts>();
  const ids = universeIds.filter((id) => crossedAt.has(id));
  if (ids.length === 0) return facts;
  const crossings = ids.map((id) => (crossedAt.get(id) as Date).toISOString());
  const result = await db.execute<CardRow>(sql`
    select g.universe_id, g.name, g.root_place_id, g.thumbnail_url, g.roblox_created_at, g.last_ccu,
      prior.ccu_max as day_before, v.up_votes, v.down_votes,
      f.family, f.template, f.reward_loop, c.core_action, p.peak_ccu
    from unnest(${sql.param(ids)}::bigint[], ${sql.param(crossings)}::timestamptz[]) as w(universe_id, crossed_at)
    join games g on g.universe_id = w.universe_id
    left join lateral (
      select h.ccu_max from game_hourly h
      where h.universe_id = w.universe_id
        and h.bucket = time_bucket(interval '1 hour', w.crossed_at - interval '24 hours')
    ) prior on true
    left join lateral (
      select up_votes, down_votes from vote_observations o
      where o.universe_id = w.universe_id
      order by o.observed_at desc limit 1
    ) v on true
    left join lateral (
      select max(d.ccu_peak) as peak_ccu from game_daily_all d where d.universe_id = w.universe_id
    ) p on true
    left join game_formats f on f.universe_id = w.universe_id
    left join game_classifications c on c.universe_id = w.universe_id
  `);
  for (const row of result.rows) {
    const universeId = Number(row.universe_id);
    const votes = (row.up_votes ?? 0) + (row.down_votes ?? 0);
    facts.set(universeId, {
      name: row.name,
      rootPlaceId: Number(row.root_place_id),
      thumbnailUrl: row.thumbnail_url,
      robloxCreatedAt: new Date(row.roblox_created_at),
      crossedAt: crossedAt.get(universeId) as Date,
      lastCcu: row.last_ccu,
      ccuDayBefore: row.day_before,
      likeRatio: row.up_votes === null || votes === 0 ? null : row.up_votes / votes,
      family: row.family,
      template: row.template,
      rewardLoop: row.reward_loop,
      coreAction: row.core_action,
      peakCcu: row.peak_ccu ?? 0,
    });
  }
  return facts;
}

export async function readPastAlerts(db: Database, since: Date): Promise<PastAlert[]> {
  return db
    .select({ kind: alerts.kind, universeId: alerts.universeId, keys: alerts.keys, createdAt: alerts.createdAt })
    .from(alerts)
    .where(gte(alerts.createdAt, since))
    .orderBy(asc(alerts.createdAt), asc(alerts.universeId));
}

export async function recordAlerts(
  db: Database,
  entries: Array<{ decision: AlertDecision; evidence: unknown; createdAt: Date }>,
): Promise<number> {
  if (entries.length === 0) return 0;
  const result = await db
    .insert(alerts)
    .values(
      entries.map(({ decision, evidence, createdAt }) => ({
        kind: decision.kind,
        universeId: decision.universeId,
        keys: decision.keys,
        evidence,
        createdAt,
      })),
    )
    .onConflictDoNothing({ target: [alerts.kind, alerts.universeId] });
  return result.rowCount ?? 0;
}

export async function readUnsentAlerts(db: Database): Promise<StoredAlert[]> {
  return db.select().from(alerts).where(isNull(alerts.sentAt)).orderBy(asc(alerts.createdAt), asc(alerts.universeId));
}

export async function markAlertsSent(db: Database, ids: string[], sentAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(alerts)
    .set({ sentAt })
    .where(and(sql`${alerts.id} = any(${sql.param(ids)}::uuid[])`, isNull(alerts.sentAt)));
}

// The latest send of an alert of this kind; null when none went out.
export async function readLastSentAt(db: Database, kind: AlertKind): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: sql<Date | string | null>`max(${alerts.sentAt})` })
    .from(alerts)
    .where(and(eq(alerts.kind, kind), isNotNull(alerts.sentAt)));
  return row?.sentAt ? new Date(row.sentAt) : null;
}
