import { eq, sql } from "drizzle-orm";
import type { GameThumbnail, GameThumbnailAnswer } from "@/lib/api/roblox";
import { chunk } from "@/lib/arrays";
import { urlFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions } from "./schema";

// A transaction holds the row locks of its games, which the poll job upserts every five minutes: a run commits in
// several short transactions rather than in one that locks every game it checked.
const CHUNK_SIZE = 500;

// Keyed on the media asset id, so a new CDN URL for the same image never records a fake A/B test.
export function thumbnailKey(thumbnail: GameThumbnail): string {
  return thumbnail.mediaId !== null ? `media:${thumbnail.mediaId}` : `url:${urlFingerprint(thumbnail.imageUrl)}`;
}

// Games never checked come first, busiest first, then busy games whose last check is older than the refresh interval.
// A game left pending or unanswered keeps its check time, so it stays due and the next run retries it.
export async function selectGamesNeedingThumbnails(
  db: Database,
  now: Date,
  options: { refreshHours: number; refreshMinimumCcu: number; limit: number },
): Promise<number[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string }>(sql`
    select universe_id
    from games
    where thumbnails_checked_at is null
       or (thumbnails_checked_at < ${at}::timestamptz - make_interval(hours => ${options.refreshHours}::int)
           and last_ccu >= ${options.refreshMinimumCcu})
    order by thumbnails_checked_at nulls first, last_ccu desc
    limit ${options.limit}
  `);
  return result.rows.map((row) => Number(row.universe_id));
}

// Per universe:
// - no entry (no answer) or "pending" (not ready yet): only the icon is updated, and the game stays due;
// - null (no usable custom thumbnail): the game is marked checked and its previous thumbnail is kept on purpose, so a
//   transient empty answer neither erases history nor records a fake change;
// - a thumbnail: stored, with a version when its key differs from the stored one.
// The stored key is read under the row lock (PostgreSQL 18 RETURNING old.*), not when the games were selected, so two
// overlapping runs record a change once.
export async function saveThumbnails(
  db: Database,
  universeIds: number[],
  thumbnails: Map<string, GameThumbnailAnswer>,
  icons: Map<string, string>,
  checkedAt: Date,
): Promise<{ changed: number }> {
  let changed = 0;
  // Universe-id order, like upsertGameDetails, so concurrent writers to games never deadlock.
  const ordered = [...new Set(universeIds)].sort((left, right) => left - right);
  for (const part of chunk(ordered, CHUNK_SIZE)) {
    // A game's update and its version commit together: a version lost after the new key was stored would never be
    // recorded, because the next run would see no change.
    changed += await db.transaction(async (transaction) => {
      const versions: (typeof gameVersions.$inferInsert)[] = [];
      for (const universeId of part) {
        const id = String(universeId);
        const iconUrl = icons.get(id);
        const iconUpdate = iconUrl ? { iconUrl } : {};
        const answer = thumbnails.get(id);
        if (answer === undefined || answer === "pending") {
          if (iconUrl) await transaction.update(games).set(iconUpdate).where(eq(games.universeId, universeId));
          continue;
        }
        if (answer === null) {
          await transaction
            .update(games)
            .set({ ...iconUpdate, thumbnailsCheckedAt: checkedAt })
            .where(eq(games.universeId, universeId));
          continue;
        }
        const key = thumbnailKey(answer);
        const [row] = await transaction
          .update(games)
          .set({ ...iconUpdate, thumbnailUrl: answer.imageUrl, thumbnailKey: key, thumbnailsCheckedAt: checkedAt })
          .where(eq(games.universeId, universeId))
          .returning({ previousKey: sql<string | null>`old.thumbnail_key` });
        if (row && row.previousKey !== key) {
          versions.push({ universeId, kind: "thumbnail", rawFingerprint: key, thumbnailUrl: answer.imageUrl, observedAt: checkedAt });
        }
      }
      if (versions.length === 0) return 0;
      const inserted = await transaction
        .insert(gameVersions)
        .values(versions)
        .onConflictDoNothing({
          target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
        })
        .returning({ id: gameVersions.id });
      return inserted.length;
    });
  }
  return { changed };
}
