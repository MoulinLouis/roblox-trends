import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { RobloxGameDetail } from "@/lib/api/roblox";
import { chunk, uniqueBy } from "@/lib/arrays";
import { contentFingerprint, rawFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions, places } from "./schema";

// A game row binds 16 parameters, and CHUNK_SIZE × 16 must stay under PostgreSQL's limit of 65,535 per statement.
const CHUNK_SIZE = 500;

export interface GameUpsertResult {
  inserted: number[];
  metadataChanged: number[];
}

// Each chunk commits on its own. If a later chunk throws, the ids of chunks already committed are not returned:
// callers use them for stats only, and promotion re-reads the known ids afterwards.
export async function upsertGameDetails(db: Database, details: RobloxGameDetail[], observedAt: Date): Promise<GameUpsertResult> {
  const inserted: number[] = [];
  const metadataChanged: number[] = [];
  // Rows are locked in universe-id order, so concurrent upserts of overlapping games cannot deadlock.
  const ordered = uniqueBy(details, (detail) => detail.id).sort((left, right) => left.id - right.id);
  for (const part of chunk(ordered, CHUNK_SIZE)) {
    // One transaction per chunk: if the version insert fails after games stored the new fingerprint,
    // a retry would see no change and the version would be lost.
    await db.transaction(async (transaction) => {
      // PostgreSQL 18 exposes the pre-update row through RETURNING old.*; it is null for inserted rows.
      // Comparing with the current fingerprint (not all history) records reverts such as X → [🎃] X → X.
      const rows = await transaction
        .insert(games)
        .values(part.map((detail) => toGameRow(detail, observedAt)))
        .onConflictDoUpdate({
          target: games.universeId,
          set: {
            rootPlaceId: sql`excluded.root_place_id`,
            // Unchanged text keeps the stored value (and its TOAST pointer) instead of being rewritten every poll.
            name: sql`case when ${games.metadataFingerprint} = excluded.metadata_fingerprint then ${games.name} else excluded.name end`,
            description: sql`case when ${games.metadataFingerprint} = excluded.metadata_fingerprint then ${games.description} else excluded.description end`,
            creatorId: sql`excluded.creator_id`,
            creatorName: sql`excluded.creator_name`,
            creatorType: sql`excluded.creator_type`,
            genre: sql`excluded.genre`,
            robloxCreatedAt: sql`excluded.roblox_created_at`,
            robloxUpdatedAt: sql`excluded.roblox_updated_at`,
            firstObservedAt: sql`least(${games.firstObservedAt}, excluded.first_observed_at)`,
            lastObservedAt: sql`excluded.last_observed_at`,
            lastCcu: sql`excluded.last_ccu`,
            lastCcuAt: sql`excluded.last_ccu_at`,
            metadataFingerprint: sql`excluded.metadata_fingerprint`,
            contentFingerprint: sql`excluded.content_fingerprint`,
          },
          // A detail older than the stored observation (a late retry) is ignored: the row is neither updated
          // nor returned, so it counts as neither inserted nor changed.
          setWhere: sql`excluded.last_observed_at >= ${games.lastObservedAt}`,
        })
        .returning({
          universeId: games.universeId,
          previousFingerprint: sql<string | null>`old.metadata_fingerprint`,
          currentFingerprint: games.metadataFingerprint,
        });
      const versioned = new Set<number>();
      for (const row of rows) {
        if (row.previousFingerprint === null) {
          inserted.push(row.universeId);
          versioned.add(row.universeId);
        } else if (row.previousFingerprint !== row.currentFingerprint) {
          metadataChanged.push(row.universeId);
          versioned.add(row.universeId);
        }
      }

      const versions = part
        .filter((detail) => versioned.has(detail.id))
        .map((detail) => ({
          universeId: detail.id,
          kind: "metadata" as const,
          rawFingerprint: rawFingerprint(detail.name, detail.description),
          contentFingerprint: contentFingerprint(detail.name, detail.description),
          name: detail.name,
          description: detail.description,
          robloxUpdatedAt: detail.updated,
          observedAt,
        }));
      if (versions.length) {
        await transaction
          .insert(gameVersions)
          .values(versions)
          .onConflictDoNothing({
            target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
          });
      }

      // Every detail reveals its root place mapping, which saves census resolutions later.
      await transaction
        .insert(places)
        .values(part.map((detail) => ({ placeId: detail.rootPlaceId, universeId: detail.id, resolvedAt: observedAt, error: null })))
        .onConflictDoNothing();
      // It also completes places whose resolution failed earlier. A separate UPDATE locks only those rows,
      // whereas DO UPDATE ... WHERE would lock every conflicting place.
      const mappings = sql.join(
        part.map((detail) => sql`(${detail.rootPlaceId}::bigint, ${detail.id}::bigint)`),
        sql`, `,
      );
      await transaction
        .update(places)
        .set({ universeId: sql`mapping.universe_id`, resolvedAt: observedAt, error: null })
        .from(sql`(values ${mappings}) as mapping(place_id, universe_id)`)
        .where(and(eq(places.placeId, sql`mapping.place_id`), isNull(places.universeId)));
    });
  }
  return { inserted, metadataChanged };
}

export async function knownUniverseIds(db: Database, universeIds: number[]): Promise<Set<number>> {
  const known = new Set<number>();
  for (const part of chunk([...new Set(universeIds)], 5_000)) {
    const rows = await db.select({ universeId: games.universeId }).from(games).where(inArray(games.universeId, part));
    for (const row of rows) known.add(row.universeId);
  }
  return known;
}

function toGameRow(detail: RobloxGameDetail, observedAt: Date): typeof games.$inferInsert {
  return {
    universeId: detail.id,
    rootPlaceId: detail.rootPlaceId,
    name: detail.name,
    description: detail.description,
    creatorId: detail.creator.id,
    creatorName: detail.creator.name,
    creatorType: detail.creator.type,
    genre: detail.genre_l1 ?? detail.genre ?? null,
    robloxCreatedAt: detail.created,
    robloxUpdatedAt: detail.updated,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    lastCcu: Math.round(detail.playing),
    lastCcuAt: observedAt,
    metadataFingerprint: rawFingerprint(detail.name, detail.description),
    contentFingerprint: contentFingerprint(detail.name, detail.description),
  };
}
