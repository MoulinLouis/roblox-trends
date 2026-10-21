import { sql } from "drizzle-orm";
import type { Pool, QueryResultRow } from "pg";
import type { Database } from "@/db/client";
import { recordDiscoveries, type DiscoveryRecord } from "@/db/discovery";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { writeChartPlacements, writeGameObservations, writeVoteObservations } from "@/db/observations";
import { gameDailyLegacy, games, gameVersions, places } from "@/db/schema";
import { chunk, compareText } from "@/lib/arrays";
import { contentFingerprint, rawFingerprint } from "@/lib/fingerprint";
import { logger } from "@/lib/logger";
import { INTEGER_MAX, legacyCount, legacyDiscovery, parseLegacyId, sortIdFromLegacyChartLabel } from "./mapping";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Rows read from one v1 table per query, so no step holds a whole table in memory.
const SOURCE_PAGE_SIZE = 5_000;
// Bounds every read on the v1 production database; the slowest one groups all snapshots once.
const SOURCE_STATEMENT_TIMEOUT = "10min";
const LEGACY_TABLES = ["games", "game_metadata_history", "snapshots", "daily_snapshots"] as const;
const AGGREGATES = [
  { view: "game_hourly", bucketMs: HOUR },
  { view: "game_daily", bucketMs: DAY },
] as const;

// Session settings for the import's target connections. Each statement commits on its own, which keeps the tuples
// decompressed per transaction low, but a rerun into compressed chunks (chart placements compress after 30 days,
// segmented by game) can still pass TimescaleDB's default limit of 100,000 and fail its window. The import is a
// one-off, so the limit is lifted instead (0 means no limit).
export const LEGACY_IMPORT_SESSION_SETTINGS = { "timescaledb.max_tuples_decompressed_per_dml_transaction": "0" } as const;

export interface LegacyImportOptions {
  // Raw rows (observations, votes, placements) are read from this time on. Games, versions, discoveries and daily rows
  // are always read in full, and the activity backfill covers the whole raw range.
  since?: Date;
  // Raw rows are read and written one window at a time; windows are aligned to multiples of this length (UTC days by
  // default, which are also the game_observations chunks).
  windowHours?: number;
  // The clock that places the retention window and the last bucket refreshed; tests pin it.
  now?: Date;
}

// Counts of rows written by this run, so a rerun reports 0 for what it already imported. `games` counts the v1 games
// upserted and `discoveries` the discovery windows merged, both of which a rerun repeats.
export interface LegacyImportStats {
  games: number;
  versions: number;
  observations: number;
  votes: number;
  placements: number;
  discoveries: number;
  dailyRows: number;
  // Distinct v1 (source, chart) labels that map to no v2 discovery source or chart sort; their rows are skipped.
  unmappedLabels: number;
  // v1 rows skipped because a value is not finite or does not fit its v2 column.
  invalidRows: number;
  from: string | null;
  to: string | null;
}

interface TimeWindow {
  from: Date;
  to: Date;
}

interface WriteCount {
  written: number;
  invalid: number;
}

// Copies the v1 history into the v2 schema. The source is only read, in read-only transactions. Every write uses keep
// mode, `do nothing` or least/greatest merges, so data collected by v2 always wins and a rerun is idempotent. Each
// statement commits on its own, and raw rows are imported window by window, each refreshed before the next: after a
// failure, a rerun (optionally with `since` set to the failed window's start) resumes the import.
export async function importLegacyHistory(target: Database, source: Pool, options: LegacyImportOptions = {}): Promise<LegacyImportStats> {
  const now = options.now ?? new Date();
  const windowMs = (options.windowHours ?? 24) * HOUR;
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error(`Invalid window length: ${options.windowHours} hours`);
  await assertLegacySource(target, source);
  await assertNotLegacyDatabase(target);
  await warnIfAlreadyPolled(target);

  const stats: LegacyImportStats = {
    games: 0,
    versions: 0,
    observations: 0,
    votes: 0,
    placements: 0,
    discoveries: 0,
    dailyRows: 0,
    unmappedLabels: 0,
    invalidRows: 0,
    from: null,
    to: null,
  };
  const imported = await importGames(target, source);
  stats.games = imported.size;
  stats.versions = await importVersions(target, source, imported);
  const discoveries = await importDiscoveries(target, source, imported);
  stats.discoveries = discoveries.merged;
  stats.unmappedLabels = discoveries.unmappedLabels;
  logger.info("Legacy games imported", { games: stats.games, versions: stats.versions, discoveries: stats.discoveries });

  const retentionStart = await rawRetentionStart(target, now);
  const [range] = await readSource<{ earliest: Date | null; first: Date | null; last: Date | null }>(
    source,
    "select min(bucket_at) as earliest, min(bucket_at) filter (where bucket_at >= $1) as first, max(bucket_at) as last from snapshots",
    [options.since ?? new Date(0)],
  );
  const { earliest, first, last } = range ?? { earliest: null, first: null, last: null };
  if (first && last) {
    stats.from = first.toISOString();
    stats.to = last.toISOString();
    for (let from = first; from <= last; ) {
      const window = { from, to: new Date((Math.floor(from.getTime() / windowMs) + 1) * windowMs) };
      try {
        const written = await importWindow(target, source, window, { imported, retentionStart, now });
        stats.observations += written.observations;
        stats.votes += written.votes;
        stats.placements += written.placements;
        stats.invalidRows += written.invalidRows;
        logger.info("Legacy window imported", { from: window.from.toISOString(), to: window.to.toISOString(), ...written });
      } catch (error) {
        throw new Error(`Importing the legacy window from ${window.from.toISOString()} failed`, { cause: error });
      }
      from = window.to;
    }
  }

  // After the raw windows: v1 maintenance moves raw days past its retention into daily_snapshots (in one
  // transaction), so a day it compacts while the import runs is read either as raw rows above or as a daily row here.
  const daily = await importDaily(target, source, imported);
  stats.dailyRows = daily.written;
  stats.invalidRows += daily.invalid;
  // Over the whole raw range rather than from `since`: a resumed run also fills the activity that the windows of the
  // interrupted run recorded. Only game_observations has retention, so the range starts where it keeps rows.
  if (earliest && last && last >= retentionStart) {
    await backfillGameActivity(target, { from: earliest > retentionStart ? earliest : retentionStart, to: last });
  }
  if (stats.invalidRows > 0) logger.warn("Skipped legacy rows with values v2 cannot store", { invalidRows: stats.invalidRows });
  return stats;
}

// Refuses a source that is not the v1 database, or that is the target itself. importLegacyHistory also refuses a
// target holding v1 tables, which on its own rules out the second case; the identity check names it outright.
export async function assertLegacySource(target: Database, source: Pool): Promise<void> {
  const [tables] = await readSource<{ missing: string[] }>(
    source,
    "select array(select name from unnest($1::text[]) as name where to_regclass('public.' || name) is null) as missing",
    [LEGACY_TABLES],
  );
  if (tables.missing.length > 0) {
    throw new Error(`Refusing to import: the source does not hold the v1 radar tables (missing ${tables.missing.join(", ")})`);
  }
  // A database is identified by its server (start time) and its own oid and name, wherever the URLs point.
  const identity = `select extract(epoch from pg_postmaster_start_time())::text || ':' || d.oid::text || ':' || d.datname as identity
    from pg_database d where d.datname = current_database()`;
  const [sourceIdentity] = await readSource<{ identity: string }>(source, identity);
  const targetIdentity = await target.execute<{ identity: string }>(sql.raw(identity));
  if (sourceIdentity.identity === targetIdentity.rows[0]?.identity) {
    throw new Error("Refusing to import: the source and the target are the same database");
  }
}

// The import is meant to run before the timers are enabled: once poll stores its 5-minute readings, a v1 hourly
// reading is added next to them in every hour where poll has no reading at exactly hh:00.
async function warnIfAlreadyPolled(target: Database): Promise<void> {
  const result = await target.execute<{ polled: boolean }>(sql`select exists (select 1 from job_runs where job = 'poll') as polled`);
  if (result.rows[0]?.polled) {
    logger.warn("v2 has already polled games: run the legacy import before enabling the timers", {
      effect: "v1 hourly readings join the 5-minute readings of hours where poll has no reading at hh:00",
    });
  }
}

async function importWindow(
  target: Database,
  source: Pool,
  window: TimeWindow,
  context: { imported: Set<number>; retentionStart: Date; now: Date },
): Promise<{ observations: number; votes: number; placements: number; invalidRows: number }> {
  // Only game_observations has retention (and feeds the aggregates); votes and placements are permanent.
  const retained =
    window.to > context.retentionStart
      ? { from: window.from > context.retentionStart ? window.from : context.retentionStart, to: window.to }
      : null;
  const observations = retained ? await importObservations(target, source, retained, context.imported) : { written: 0, invalid: 0 };
  const votes = await importVotes(target, source, window, context.imported);
  // During the parallel run both v1 and v2 collect charts hourly; a chart slot is a ranking, so v1 placements are
  // imported only for slots before v2's first charts run, never mixed into a slot v2 collected. Read for each window,
  // so a charts run that starts while the import is running is seen before the next window is written.
  const placements = await importPlacements(target, source, window, context.imported, await firstCollectedChartSlot(target));
  // Refreshed now rather than at the end: after a failure, only the failed window can lack its aggregates, and the
  // rerun that imports it refreshes it. A refresh with nothing new to materialize is a no-op, which keeps reruns cheap.
  if (retained) await refreshAggregates(target, retained, context.now);
  return {
    observations: observations.written,
    votes: votes.written,
    placements: placements.written,
    invalidRows: observations.invalid + votes.invalid + placements.invalid,
  };
}

async function firstCollectedChartSlot(target: Database): Promise<Date | null> {
  const result = await target.execute<{ slot: string | null }>(
    // Any run, failed ones included: charts store each sort as soon as it is read, so a failed run can hold placements.
    sql`select min(slot) as slot from job_runs where job = 'charts'`,
  );
  const slot = result.rows[0]?.slot;
  return slot ? new Date(slot) : null;
}

// Raw rows older than the retention window are dropped by TimescaleDB. Importing them again would let a
// later refresh recompute those aggregate buckets from legacy rows only, overwriting collected history.
async function rawRetentionStart(target: Database, now: Date): Promise<Date> {
  const policy = await target.execute<{ drop_after: string | null }>(sql`
    select config->>'drop_after' as drop_after from timescaledb_information.jobs
    where proc_name = 'policy_retention' and hypertable_name = 'game_observations'
  `);
  const dropAfter = policy.rows[0]?.drop_after;
  if (!dropAfter) return new Date(0);
  const result = await target.execute<{ start: string }>(
    sql`select (${now.toISOString()}::timestamptz - ${dropAfter}::interval + interval '1 day') as start`,
  );
  return new Date(result.rows[0].start);
}

interface LegacyGameRow {
  page_key: string;
  root_place_id: string;
  name: string;
  description: string;
  creator_id: string;
  creator_name: string;
  creator_type: string;
  genre: string | null;
  created_at: Date;
  updated_at: Date;
  first_seen_at: Date;
  last_seen_at: Date;
  thumbnail_url: string | null;
}

// Returns the universe ids now present in the target. Every later step imports only these games.
async function importGames(target: Database, source: Pool): Promise<Set<number>> {
  const imported = new Set<number>();
  const pages = readPages<LegacyGameRow>(
    source,
    // Universe-id order, like every other writer to games, so the import cannot deadlock with poll.
    `select universe_id::bigint::text as page_key, root_place_id, name, description, creator_id, creator_name, creator_type, genre,
       created_at, updated_at, first_seen_at, last_seen_at, thumbnail_url
     from games where universe_id::bigint > $1::bigint order by universe_id::bigint limit $2`,
  );
  let skipped = 0;
  for await (const page of pages) {
    const rows = page.flatMap((row) => {
      const universeId = parseLegacyId(row.page_key);
      const rootPlaceId = parseLegacyId(row.root_place_id);
      const creatorId = parseLegacyId(row.creator_id);
      if (universeId === null || rootPlaceId === null || creatorId === null) {
        skipped += 1;
        return [];
      }
      return [
        {
          universeId,
          rootPlaceId,
          name: row.name,
          description: row.description,
          creatorId,
          creatorName: row.creator_name,
          creatorType: row.creator_type,
          genre: row.genre,
          robloxCreatedAt: row.created_at,
          robloxUpdatedAt: row.updated_at,
          firstObservedAt: row.first_seen_at,
          // The stale-write guard of upsertGameDetails compares against this time, so it never runs ahead of the clock.
          lastObservedAt: new Date(Math.min(row.last_seen_at.getTime(), Date.now())),
          metadataFingerprint: rawFingerprint(row.name, row.description),
          contentFingerprint: contentFingerprint(row.name, row.description),
          // v1 stored the square game icon (games/icons) under this name.
          iconUrl: row.thumbnail_url,
        },
      ];
    });
    for (const part of chunk(rows, 500)) {
      // A game v2 already collected keeps its own details; only the observation window widens.
      await target
        .insert(games)
        .values(part)
        .onConflictDoUpdate({
          target: games.universeId,
          set: {
            firstObservedAt: sql`least(${games.firstObservedAt}, excluded.first_observed_at)`,
            lastObservedAt: sql`greatest(${games.lastObservedAt}, excluded.last_observed_at)`,
          },
        });
      await target
        .insert(places)
        .values(part.map((row) => ({ placeId: row.rootPlaceId, universeId: row.universeId, resolvedAt: row.firstObservedAt, error: null })))
        .onConflictDoNothing();
    }
    for (const row of rows) imported.add(row.universeId);
  }
  // Their versions, discoveries, observations, votes, placements and daily rows are skipped too.
  if (skipped > 0) logger.warn("Skipped legacy games with invalid ids", { skipped });
  return imported;
}

async function importVersions(target: Database, source: Pool, imported: Set<number>): Promise<number> {
  const pages = readPages<{ page_key: string; universe_id: string; name: string; description: string; game_updated_at: Date; observed_at: Date }>(
    source,
    // v1 added a history row on every publish (its fingerprint included the update time), whereas a v2 version is a
    // change of name or description. A row is kept when its text differs from the previous row of its game, in
    // (observed_at, id) order, as lag() would compare them; the lookup per row keeps pages independent of each other.
    `select h.id::text as page_key, h.universe_id, h.name, h.description, h.game_updated_at, h.observed_at
     from game_metadata_history h
     left join lateral (
       select p.name, p.description from game_metadata_history p
       where p.universe_id = h.universe_id and (p.observed_at, p.id) < (h.observed_at, h.id)
       order by p.observed_at desc, p.id desc
       limit 1
     ) previous on true
     where h.id > $1::bigint and (previous.name is null or previous.name <> h.name or previous.description <> h.description)
     order by h.id limit $2`,
  );
  let written = 0;
  for await (const page of pages) {
    const rows = page.flatMap((row) => {
      const universeId = parseLegacyId(row.universe_id);
      if (universeId === null || !imported.has(universeId)) return [];
      return [
        {
          universeId,
          kind: "metadata" as const,
          rawFingerprint: rawFingerprint(row.name, row.description),
          contentFingerprint: contentFingerprint(row.name, row.description),
          name: row.name,
          description: row.description,
          robloxUpdatedAt: row.game_updated_at,
          observedAt: row.observed_at,
        },
      ];
    });
    for (const part of chunk(rows, 1_000)) {
      const result = await target.insert(gameVersions).values(part).onConflictDoNothing({
        target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
      });
      written += result.rowCount ?? 0;
    }
  }
  return written;
}

async function importDiscoveries(target: Database, source: Pool, imported: Set<number>): Promise<{ merged: number; unmappedLabels: number }> {
  // One row per game, source and chart: far fewer than the snapshots it summarizes. Direct tracking re-polled known
  // games, so it is left out rather than reported as unmapped.
  const rows = await readSource<{ universe_id: string; source: string; chart: string; first_seen: Date; last_seen: Date }>(
    source,
    "select universe_id, source, chart, min(collected_at) as first_seen, max(collected_at) as last_seen from snapshots where source <> 'roblox-tracked' group by 1, 2, 3",
  );
  const records: DiscoveryRecord[] = [];
  // Every (source, chart) label passes through here, chart placements included, so this is where unknown ones show.
  const unmapped = new Map<string, number>();
  for (const row of rows) {
    const mapped = legacyDiscovery(row.source, row.chart);
    if (!mapped) {
      const label = `${row.source}: ${row.chart}`;
      unmapped.set(label, (unmapped.get(label) ?? 0) + 1);
      continue;
    }
    const universeId = parseLegacyId(row.universe_id);
    if (universeId === null || !imported.has(universeId)) continue;
    records.push({ universeId, ...mapped, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen });
  }
  if (unmapped.size > 0) {
    const gamesByLabel = Object.fromEntries([...unmapped].sort(([left], [right]) => compareText(left, right)));
    logger.warn("Skipped legacy labels without a v2 discovery source or chart sort", { gamesByLabel });
  }
  return { merged: await recordDiscoveries(target, records), unmappedLabels: unmapped.size };
}

async function importObservations(target: Database, source: Pool, window: TimeWindow, imported: Set<number>): Promise<WriteCount> {
  // v1 stored one row per source and chart in each hourly bucket; v2 keeps one observation per game and time.
  const rows = await readSource<{ universe_id: string; bucket_at: Date; ccu: number; visits: number; favorites: number }>(
    source,
    `select universe_id, bucket_at, max(ccu) as ccu, max(visits) as visits, max(favorites) as favorites
     from snapshots where bucket_at >= $1 and bucket_at < $2 group by 1, 2`,
    [window.from, window.to],
  );
  let invalid = 0;
  const observations = rows.flatMap((row) => {
    const universeId = parseLegacyId(row.universe_id);
    if (universeId === null || !imported.has(universeId)) return [];
    const ccu = legacyCount(row.ccu, INTEGER_MAX);
    const visits = legacyCount(row.visits);
    const favorites = legacyCount(row.favorites);
    if (ccu === null || visits === null || favorites === null) {
      invalid += 1;
      return [];
    }
    return [{ universeId, observedAt: row.bucket_at, ccu, visits, favorites, source: "legacy" as const }];
  });
  return { written: await writeGameObservations(target, observations, "keep"), invalid };
}

async function importVotes(target: Database, source: Pool, window: TimeWindow, imported: Set<number>): Promise<WriteCount> {
  const rows = await readSource<{ universe_id: string; bucket_at: Date; up_votes: number; down_votes: number }>(
    source,
    `select universe_id, bucket_at, max(up_votes) as up_votes, max(down_votes) as down_votes
     from snapshots where bucket_at >= $1 and bucket_at < $2 and up_votes is not null and down_votes is not null group by 1, 2`,
    [window.from, window.to],
  );
  let invalid = 0;
  const votes = rows.flatMap((row) => {
    const universeId = parseLegacyId(row.universe_id);
    if (universeId === null || !imported.has(universeId)) return [];
    const upVotes = legacyCount(row.up_votes, INTEGER_MAX);
    const downVotes = legacyCount(row.down_votes, INTEGER_MAX);
    if (upVotes === null || downVotes === null) {
      invalid += 1;
      return [];
    }
    return [{ universeId, observedAt: row.bucket_at, upVotes, downVotes }];
  });
  return { written: await writeVoteObservations(target, votes, "keep"), invalid };
}

async function importPlacements(
  target: Database,
  source: Pool,
  window: TimeWindow,
  imported: Set<number>,
  cutoff: Date | null,
): Promise<WriteCount> {
  const to = cutoff && cutoff < window.to ? cutoff : window.to;
  if (to <= window.from) return { written: 0, invalid: 0 };
  const rows = await readSource<{ chart: string; universe_id: string; bucket_at: Date; rank: number; ccu: number; is_sponsored: boolean | null }>(
    source,
    // Same rule as v2's toChartPlacements: one row per chart, game and bucket, organic before sponsored, then best rank.
    `select distinct on (chart, universe_id, bucket_at) chart, universe_id, bucket_at, rank, ccu, is_sponsored
     from snapshots where source = 'roblox-charts' and rank is not null and bucket_at >= $1 and bucket_at < $2
     order by chart, universe_id, bucket_at, (is_sponsored is true), rank`,
    [window.from, to],
  );
  let invalid = 0;
  const placements = rows.flatMap((row) => {
    // Unknown labels are reported once, by importDiscoveries.
    const sortId = sortIdFromLegacyChartLabel(row.chart);
    const universeId = parseLegacyId(row.universe_id);
    if (!sortId || universeId === null || !imported.has(universeId)) return [];
    const rank = legacyCount(row.rank, INTEGER_MAX);
    const playerCount = legacyCount(row.ccu, INTEGER_MAX);
    if (rank === null || playerCount === null) {
      invalid += 1;
      return [];
    }
    return [{ sortId, universeId, observedAt: row.bucket_at, rank, playerCount, isSponsored: row.is_sponsored }];
  });
  return { written: await writeChartPlacements(target, placements, "keep"), invalid };
}

interface LegacyDailyRow {
  page_key: string;
  universe_id: string;
  day_at: Date;
  average_ccu: number;
  peak_ccu: number;
  visits: number;
  favorites: number;
  up_votes: number | null;
  down_votes: number | null;
  best_rank: number | null;
}

async function importDaily(target: Database, source: Pool, imported: Set<number>): Promise<WriteCount> {
  const pages = readPages<LegacyDailyRow>(
    source,
    `select id::text as page_key, universe_id, day_at, average_ccu, peak_ccu, visits, favorites, up_votes, down_votes, best_rank
     from daily_snapshots where id > $1::bigint order by id limit $2`,
  );
  let written = 0;
  let invalid = 0;
  let offMidnight = 0;
  let offMidnightExample: string | undefined;
  for await (const page of pages) {
    const rows = page.flatMap((row) => {
      const universeId = parseLegacyId(row.universe_id);
      if (universeId === null || !imported.has(universeId)) return [];
      // v1 truncated days in its session time zone (UTC on Aiven). A day cut elsewhere is filed under the nearest UTC
      // midnight, which is the calendar day it covers for any offset below 12 hours.
      if (row.day_at.getTime() % DAY !== 0) {
        offMidnight += 1;
        offMidnightExample ??= row.day_at.toISOString();
      }
      const ccuPeak = legacyCount(row.peak_ccu, INTEGER_MAX);
      const visits = legacyCount(row.visits);
      const favorites = legacyCount(row.favorites);
      const upVotes = nullableCount(row.up_votes);
      const downVotes = nullableCount(row.down_votes);
      const bestRank = nullableCount(row.best_rank);
      if (
        !Number.isFinite(row.average_ccu) ||
        row.average_ccu < 0 ||
        ccuPeak === null ||
        visits === null ||
        favorites === null ||
        upVotes === undefined ||
        downVotes === undefined ||
        bestRank === undefined
      ) {
        invalid += 1;
        return [];
      }
      const day = new Date(Math.round(row.day_at.getTime() / DAY) * DAY);
      return [{ universeId, day, ccuAvg: row.average_ccu, ccuPeak, visits, favorites, upVotes, downVotes, bestRank }];
    });
    for (const part of chunk(rows, 2_000)) {
      const result = await target.insert(gameDailyLegacy).values(part).onConflictDoNothing();
      written += result.rowCount ?? 0;
    }
  }
  if (offMidnight > 0) {
    logger.warn("Legacy daily rows not at UTC midnight were filed under the nearest UTC day", { rows: offMidnight, example: offMidnightExample });
  }
  return { written, invalid };
}

// Undefined when v1 holds a value that v2 cannot store; a missing value stays null.
function nullableCount(value: number | null): number | null | undefined {
  return value === null ? null : (legacyCount(value, INTEGER_MAX) ?? undefined);
}

// refresh_continuous_aggregate refuses to run in a transaction block. A parameterless statement goes through the
// simple query protocol on its own; the literals are ISO strings built here. The window is widened to whole buckets
// (a refresh only materializes buckets it fully covers) but stops before the bucket that holds now - 1 hour, like the
// refresh policies: a bucket still filling, once materialized, would hide its later readings until a policy reached it
// (a day later for game_daily). Those buckets stay in the real-time half of the views.
async function refreshAggregates(target: Database, window: TimeWindow, now: Date): Promise<void> {
  for (const { view, bucketMs } of AGGREGATES) {
    const start = Math.floor(window.from.getTime() / bucketMs) * bucketMs;
    const end = Math.min(Math.ceil(window.to.getTime() / bucketMs) * bucketMs, Math.floor((now.getTime() - HOUR) / bucketMs) * bucketMs);
    if (end <= start) continue;
    const from = new Date(start).toISOString();
    const to = new Date(end).toISOString();
    await target.execute(sql.raw(`CALL refresh_continuous_aggregate('${view}', '${from}'::timestamptz, '${to}'::timestamptz)`));
  }
}

// Fills what the active set and the young-game rule read from games, from the observations in the given range:
// the latest reading of games v2 never observed, and the last reading with players of every game. Rows are locked in
// universe-id order first, like every other writer to games, so a concurrent poll cannot deadlock with these updates.
async function backfillGameActivity(target: Database, range: TimeWindow): Promise<void> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  await target.execute(sql`
    with latest as (
      select distinct on (universe_id) universe_id, ccu, observed_at
      from game_observations
      where observed_at >= ${from}::timestamptz and observed_at <= ${to}::timestamptz
      order by universe_id, observed_at desc
    ),
    locked as materialized (
      select g.universe_id from games g
      join latest on latest.universe_id = g.universe_id
      where g.last_ccu_at is null
      order by g.universe_id
      for update of g
    )
    update games g
    set last_ccu = latest.ccu, last_ccu_at = latest.observed_at
    from latest
    join locked on locked.universe_id = latest.universe_id
    where g.universe_id = latest.universe_id and g.last_ccu_at is null
  `);
  await target.execute(sql`
    with active as (
      select universe_id, max(observed_at) as observed_at
      from game_observations
      where observed_at >= ${from}::timestamptz and observed_at <= ${to}::timestamptz and ccu > 0
      group by universe_id
    ),
    locked as materialized (
      select g.universe_id from games g
      join active on active.universe_id = g.universe_id
      where g.last_active_at is null or g.last_active_at < active.observed_at
      order by g.universe_id
      for update of g
    )
    update games g
    set last_active_at = active.observed_at
    from active
    join locked on locked.universe_id = active.universe_id
    where g.universe_id = active.universe_id and (g.last_active_at is null or g.last_active_at < active.observed_at)
  `);
}

// Every read runs in its own read-only transaction: the source is the v1 production database, and a transaction-level
// guarantee also holds behind a connection pooler, where session settings may not stick.
async function readSource<Row extends QueryResultRow>(source: Pool, text: string, values: unknown[] = []): Promise<Row[]> {
  const client = await source.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin transaction read only");
    await client.query(`set local statement_timeout = '${SOURCE_STATEMENT_TIMEOUT}'`);
    const result = await client.query<Row>(text, values);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw error;
  } finally {
    // A client whose rollback failed is discarded rather than returned to the pool mid-transaction.
    client.release(broken);
  }
}

// Keyset pagination: `text` selects rows whose `page_key` is greater than $1, in key order, at most $2 of them.
async function* readPages<Row extends QueryResultRow & { page_key: string }>(source: Pool, text: string): AsyncGenerator<Row[]> {
  let after = "-1";
  for (;;) {
    const rows = await readSource<Row>(source, text, [after, SOURCE_PAGE_SIZE]);
    if (rows.length > 0) yield rows;
    if (rows.length < SOURCE_PAGE_SIZE) return;
    after = rows[rows.length - 1].page_key;
  }
}
