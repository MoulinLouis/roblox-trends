import { sql } from "drizzle-orm";
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

// Every writer deduplicates first (PostgreSQL rejects an upsert that affects one row twice; the first occurrence
// wins), then sorts by primary key: concurrent writers to one hypertable lock rows in the same order and cannot
// deadlock. Each chunk commits on its own, and the result is the number of distinct rows submitted, including rows
// that keep mode left unchanged.

export async function writeGameObservations(db: Database, rows: GameObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`).sort(compareUniverseTime);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(gameObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [gameObservations.universeId, gameObservations.observedAt],
        set: { ccu: sql`excluded.ccu`, visits: sql`excluded.visits`, favorites: sql`excluded.favorites`, source: sql`excluded.source` },
      });
  }
  return unique.length;
}

export async function writeCensusObservations(db: Database, rows: CensusObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.placeId}:${row.observedAt.getTime()}`).sort(
    (left, right) => left.placeId - right.placeId || compareTime(left, right),
  );
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(censusObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [censusObservations.placeId, censusObservations.observedAt],
        set: { ccu: sql`excluded.ccu` },
      });
  }
  return unique.length;
}

export async function writeVoteObservations(db: Database, rows: VoteObservationRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.universeId}:${row.observedAt.getTime()}`).sort(compareUniverseTime);
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(voteObservations).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [voteObservations.universeId, voteObservations.observedAt],
        set: { upVotes: sql`excluded.up_votes`, downVotes: sql`excluded.down_votes` },
      });
  }
  return unique.length;
}

export async function writeChartPlacements(db: Database, rows: ChartPlacementRow[], mode: WriteMode = "replace"): Promise<number> {
  const unique = uniqueBy(rows, (row) => `${row.sortId}:${row.universeId}:${row.observedAt.getTime()}`).sort(
    (left, right) => compareText(left.sortId, right.sortId) || compareUniverseTime(left, right),
  );
  for (const part of chunk(unique, CHUNK_SIZE)) {
    const insert = db.insert(chartPlacements).values(part);
    if (mode === "keep") await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [chartPlacements.sortId, chartPlacements.universeId, chartPlacements.observedAt],
        set: { rank: sql`excluded.rank`, playerCount: sql`excluded.player_count`, isSponsored: sql`excluded.is_sponsored` },
      });
  }
  return unique.length;
}

function compareUniverseTime(left: { universeId: number; observedAt: Date }, right: { universeId: number; observedAt: Date }): number {
  return left.universeId - right.universeId || compareTime(left, right);
}

function compareTime(left: { observedAt: Date }, right: { observedAt: Date }): number {
  return left.observedAt.getTime() - right.observedAt.getTime();
}
