import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
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

// Games never requested come first, busiest first, whatever their CCU time. A checked game is refreshed next, oldest
// check first, when that check is older than the refresh interval and the game is busy now: its CCU must be recent,
// because a game that Roblox stops returning keeps its last CCU forever. A game left pending, erroring or unanswered
// keeps its check time, so it stays due: a checked one on the next run, a never-checked one only once its last request
// is older than the retry interval, and after the others, so games that never get an answer cannot crowd the queue.
export async function selectGamesNeedingThumbnails(
  db: Database,
  now: Date,
  options: {
    refreshHours: number;
    refreshMinimumCcu: number;
    refreshMaximumCcuAgeHours: number;
    retryUnansweredAfterHours: number;
    limit: number;
  },
): Promise<number[]> {
  const at = now.toISOString();
  const result = await db.execute<{ universe_id: string }>(sql`
    select universe_id
    from games
    where (thumbnails_checked_at is null
           and (thumbnails_attempted_at is null
                or thumbnails_attempted_at < ${at}::timestamptz - make_interval(hours => ${options.retryUnansweredAfterHours}::int)))
       or (thumbnails_checked_at < ${at}::timestamptz - make_interval(hours => ${options.refreshHours}::int)
           and last_ccu >= ${options.refreshMinimumCcu}
           and last_ccu_at > ${at}::timestamptz - make_interval(hours => ${options.refreshMaximumCcuAgeHours}::int))
    order by
      case
        when thumbnails_checked_at is null and thumbnails_attempted_at is null then 0
        when thumbnails_checked_at is not null then 1
        else 2
      end,
      thumbnails_checked_at, thumbnails_attempted_at, last_ccu desc, universe_id
    limit ${options.limit}
  `);
  return result.rows.map((row) => Number(row.universe_id));
}

// Records every game requested, answered or not, including the games of a batch Roblox answered for none: a game that
// never gets an answer then waits for the retry interval instead of being requested again by every run. An older run
// that finishes last keeps the newer time. Rows are locked in universe-id order first, like every other writer to
// games, so a concurrent poll cannot deadlock with it.
export async function markThumbnailsAttempted(db: Database, universeIds: number[], attemptedAt: Date): Promise<void> {
  if (universeIds.length === 0) return;
  await db.execute(sql`
    with locked as materialized (
      select universe_id from games
      where universe_id = any(${sql.param(universeIds)}::bigint[])
      order by universe_id
      for update
    )
    update games g
    set thumbnails_attempted_at = greatest(g.thumbnails_attempted_at, ${attemptedAt.toISOString()}::timestamptz)
    from locked
    where g.universe_id = locked.universe_id
  `);
}

// Saves one batch in one transaction, so a game's update and its version commit together: a version lost after the
// new key was stored would never be recorded, because the next run would see no change. Per answer:
// - none, "pending" or "error": only the icon is updated, and the game stays due;
// - null (no usable custom thumbnail): the game is marked checked and its previous thumbnail is kept on purpose, so a
//   transient empty answer neither erases history nor records a fake change;
// - a thumbnail: stored, with a version when its key differs from the stored one.
// The stored key is read under the row lock (PostgreSQL 18 RETURNING old.*), not when the games were selected, and a
// run older than the check that last wrote a game leaves it alone, so overlapping runs neither record a change twice
// nor bring back an image that a newer run already replaced.
export async function saveThumbnails(db: Database, results: ThumbnailResult[], checkedAt: Date): Promise<{ changed: number }> {
  // Universe-id order, like upsertGameDetails, so concurrent writers to games never deadlock.
  const ordered = [...results].sort((left, right) => left.universeId - right.universeId);
  return db.transaction(async (transaction) => {
    const versions: (typeof gameVersions.$inferInsert)[] = [];
    for (const { universeId, answer, iconUrl } of ordered) {
      const target = and(
        eq(games.universeId, universeId),
        or(isNull(games.thumbnailsCheckedAt), lte(games.thumbnailsCheckedAt, checkedAt)),
      );
      const iconUpdate = iconUrl ? { iconUrl } : {};
      if (answer === undefined || answer === "pending" || answer === "error") {
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
