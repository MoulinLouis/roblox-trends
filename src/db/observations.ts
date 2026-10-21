import { and, eq, sql } from "drizzle-orm";
import { chunk, compareText, uniqueBy } from "@/lib/arrays";
import type { Database } from "./client";
import { censusObservations, chartPlacements, gameObservations, voteObservations } from "./schema";

// "replace" for live collectors (a retry in the same slot overwrites);
// "keep" for imports that must never overwrite collected data.
export type WriteMode = "replace" | "keep";

export type GameObservationRow = typeof gameObservations.$inferInsert;
export type CensusObservationRow = typeof censusObservations.$inferInsert;
export type VoteObservationRow = typeof voteObservations.$inferInsert;
export type ChartPlacementRow = typeof chartPlacements.$inferInsert;

// The widest row binds 6 parameters, and CHUNK_SIZE × 6 must stay under PostgreSQL's limit of 65,535 per statement.
const CHUNK_SIZE = 2_000;
const hourMs = 60 * 60 * 1000;

// Every writer deduplicates first (PostgreSQL rejects an upsert that affects one row twice; the first occurrence
// wins), then sorts by primary key: concurrent writers to one hypertable lock rows in the same order and cannot
// deadlock. The result is the number of rows written: every distinct row in replace mode, only the inserted ones in
// keep mode. Each chunk commits on its own, so when a later chunk throws, the earlier ones stay written.

export async function writeGameObservations(db: Database, rows: GameObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`).sort(compareUniverseTime);
  let written = 0;
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(gameObservations).values(part);
    const result =
      mode === "keep"
        ? await insert.onConflictDoNothing()
        : await insert.onConflictDoUpdate({
            target: [gameObservations.universeId, gameObservations.observedAt],
            set: { ccu: sql`excluded.ccu`, visits: sql`excluded.visits`, favorites: sql`excluded.favorites`, source: sql`excluded.source` },
          });
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function writeCensusObservations(db: Database, rows: CensusObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.placeId}:${row.observedAt.getTime()}`).sort(
    (left, right) => left.placeId - right.placeId || compareTime(left, right),
  );
  let written = 0;
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(censusObservations).values(part);
    const result =
      mode === "keep"
        ? await insert.onConflictDoNothing()
        : await insert.onConflictDoUpdate({
            target: [censusObservations.placeId, censusObservations.observedAt],
            set: { ccu: sql`excluded.ccu` },
          });
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function writeVoteObservations(db: Database, rows: VoteObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`).sort(compareUniverseTime);
  let written = 0;
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(voteObservations).values(part);
    const result =
      mode === "keep"
        ? await insert.onConflictDoNothing()
        : await insert.onConflictDoUpdate({
            target: [voteObservations.universeId, voteObservations.observedAt],
            set: { upVotes: sql`excluded.up_votes`, downVotes: sql`excluded.down_votes` },
          });
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function writeChartPlacements(db: Database, rows: ChartPlacementRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.sortId}:${row.universeId}:${row.observedAt.getTime()}`).sort(
    (left, right) => compareText(left.sortId, right.sortId) || compareUniverseTime(left, right),
  );
  let written = 0;
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(chartPlacements).values(part);
    const result =
      mode === "keep"
        ? await insert.onConflictDoNothing()
        : await insert.onConflictDoUpdate({
            target: [chartPlacements.sortId, chartPlacements.universeId, chartPlacements.observedAt],
            set: { rank: sql`excluded.rank`, playerCount: sql`excluded.player_count`, isSponsored: sql`excluded.is_sponsored` },
          });
    written += result.rowCount ?? 0;
  }
  return written;
}

// Replaces every placement of one sort in one slot, atomically: a chart is a ranking, so a retry within the hour must
// not leave a game that dropped out next to the game that took its rank. Rows are sorted by key, like the other writers.
export async function replaceChartSlot(db: Database, sortId: string, observedAt: Date, rows: ChartPlacementRow[]): Promise<number> {
  if (rows.some((row) => row.sortId !== sortId || row.observedAt.getTime() !== observedAt.getTime())) {
    throw new Error(`Every placement must belong to the replaced slot (${sortId} at ${observedAt.toISOString()})`);
  }
  const unique = uniqueBy(rows, (row) => row.universeId).sort((left, right) => left.universeId - right.universeId);
  const hourIndex = Math.floor(observedAt.getTime() / hourMs);
  return db.transaction(async (transaction) => {
    // Serializes replacements of one sort in one hour (a manual run next to the timer's): the later one waits, then
    // its delete sees and removes the earlier ranking. Unserialized, it could only fail on the primary key or leave
    // rows of the earlier ranking next to its own.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${sortId}), ${hourIndex}::int)`);
    await transaction
      .delete(chartPlacements)
      .where(and(eq(chartPlacements.sortId, sortId), eq(chartPlacements.observedAt, observedAt)));
    let written = 0;
    for (const part of chunk(unique, CHUNK_SIZE)) {
      const result = await transaction.insert(chartPlacements).values(part);
      written += result.rowCount ?? 0;
    }
    return written;
  });
}

function compareUniverseTime(left: { universeId: number; observedAt: Date }, right: { universeId: number; observedAt: Date }): number {
  return left.universeId - right.universeId || compareTime(left, right);
}

function compareTime(left: { observedAt: Date }, right: { observedAt: Date }): number {
  return left.observedAt.getTime() - right.observedAt.getTime();
}
