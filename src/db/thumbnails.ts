import { eq, sql } from "drizzle-orm";
import type { GameThumbnail, GameThumbnailAnswer } from "@/lib/api/roblox";
import { urlFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions } from "./schema";

export interface ThumbnailResult {
  universeId: number;
  // undefined: Roblox gave no answer for this game.
  answer: GameThumbnailAnswer | undefined;
  // undefined: no completed icon was returned; the stored icon is kept.
  iconUrl: string | undefined;
}

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
    order by thumbnails_checked_at nulls first, last_ccu desc, universe_id
    limit ${options.limit}
  `);
  return result.rows.map((row) => Number(row.universe_id));
}

// Saves one batch in one transaction, so a game's update and its version commit together: a version lost after the
// new key was stored would never be recorded, because the next run would see no change. Per answer:
// - none or "pending": only the icon is updated, and the game stays due;
// - null (no usable custom thumbnail): the game is marked checked and its previous thumbnail is kept on purpose, so a
//   transient empty answer neither erases history nor records a fake change;
// - a thumbnail: stored, with a version when its key differs from the stored one.
// The stored key is read under the row lock (PostgreSQL 18 RETURNING old.*), not when the games were selected, so two
// overlapping runs record a change once.
export async function saveThumbnails(db: Database, results: ThumbnailResult[], checkedAt: Date): Promise<{ changed: number }> {
  // Universe-id order, like upsertGameDetails, so concurrent writers to games never deadlock.
  const ordered = [...results].sort((left, right) => left.universeId - right.universeId);
  return db.transaction(async (transaction) => {
    const versions: (typeof gameVersions.$inferInsert)[] = [];
    for (const { universeId, answer, iconUrl } of ordered) {
      const target = eq(games.universeId, universeId);
      const iconUpdate = iconUrl ? { iconUrl } : {};
      if (answer === undefined || answer === "pending") {
        if (iconUrl) await transaction.update(games).set(iconUpdate).where(target);
        continue;
      }
      if (answer === null) {
        await transaction.update(games).set({ ...iconUpdate, thumbnailsCheckedAt: checkedAt }).where(target);
        continue;
      }
      const key = thumbnailKey(answer);
      const [row] = await transaction
        .update(games)
        .set({ ...iconUpdate, thumbnailUrl: answer.imageUrl, thumbnailKey: key, thumbnailsCheckedAt: checkedAt })
        .where(target)
        .returning({ previousKey: sql<string | null>`old.thumbnail_key` });
      if (row && row.previousKey !== key) {
        versions.push({ universeId, kind: "thumbnail", rawFingerprint: key, thumbnailUrl: answer.imageUrl, observedAt: checkedAt });
      }
    }
    if (versions.length === 0) return { changed: 0 };
    const inserted = await transaction
      .insert(gameVersions)
      .values(versions)
      .onConflictDoNothing({
        target: [gameVersions.universeId, gameVersions.kind, gameVersions.rawFingerprint, gameVersions.observedAt],
      })
      .returning({ id: gameVersions.id });
    return { changed: inserted.length };
  });
}
