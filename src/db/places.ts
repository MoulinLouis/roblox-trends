import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { chunk } from "@/lib/arrays";
import type { Database } from "./client";
import { games, places } from "./schema";

export async function placesToSkip(db: Database, placeIds: number[], now: Date, retryDays: number): Promise<Set<number>> {
  const retryCutoff = new Date(now.getTime() - retryDays * 24 * 60 * 60 * 1000);
  const skip = new Set<number>();
  for (const part of chunk([...new Set(placeIds)], 5_000)) {
    const rows = await db
      .select({ placeId: places.placeId })
      .from(places)
      .where(and(inArray(places.placeId, part), or(isNotNull(places.universeId), gt(places.resolvedAt, retryCutoff))));
    for (const row of rows) skip.add(row.placeId);
  }
  return skip;
}

export async function savePlaceResolution(
  db: Database,
  resolution: { placeId: number; universeId: number | null; resolvedAt: Date; error: string | null },
): Promise<void> {
  await db
    .insert(places)
    .values(resolution)
    .onConflictDoUpdate({
      target: places.placeId,
      set: { universeId: sql`excluded.universe_id`, resolvedAt: sql`excluded.resolved_at`, error: sql`excluded.error` },
    });
}

export async function unpromotedUniverses(db: Database, placeIds: number[]): Promise<number[]> {
  const universes = new Set<number>();
  for (const part of chunk([...new Set(placeIds)], 5_000)) {
    const rows = await db
      .selectDistinct({ universeId: places.universeId })
      .from(places)
      .leftJoin(games, eq(games.universeId, places.universeId))
      .where(and(inArray(places.placeId, part), isNotNull(places.universeId), isNull(games.universeId)));
    for (const row of rows) if (row.universeId !== null) universes.add(row.universeId);
  }
  return [...universes].sort((a, b) => a - b);
}
