import { and, asc, gt, isNotNull, ne, sql } from "drizzle-orm";
import { CONTENT_FINGERPRINT_VERSION, contentFingerprint } from "@/lib/fingerprint";
import type { Database } from "./client";
import { games, gameVersions } from "./schema";

const BATCH_SIZE = 1_000;

export interface ContentFingerprintRefresh {
  games: number;
  versions: number;
}

// Recomputes, from the text stored beside them, the content fingerprints another version of the algorithm stored.
// `npm run db:migrate` runs it after the migrations. A job of the previous release that is still running can write its
// own fingerprints afterwards: poll corrects the games on their next read, and the next deploy corrects the rest.
export async function refreshContentFingerprints(db: Database): Promise<ContentFingerprintRefresh> {
  return { games: await refreshGames(db), versions: await refreshVersions(db) };
}

// Every game is compared, not only those of another version: a release older than the version column rewrites a
// game's fingerprint and leaves the version it finds.
async function refreshGames(db: Database): Promise<number> {
  let refreshed = 0;
  // Below 0: the v1 import brought the placeholder universe 0 that Roblox answers for some ids.
  for (let after = -1; ; ) {
    const rows = await db
      .select({
        universeId: games.universeId,
        name: games.name,
        description: games.description,
        metadataFingerprint: games.metadataFingerprint,
        contentFingerprint: games.contentFingerprint,
        contentFingerprintVersion: games.contentFingerprintVersion,
      })
      .from(games)
      .where(gt(games.universeId, after))
      .orderBy(asc(games.universeId))
      .limit(BATCH_SIZE);
    if (!rows.length) return refreshed;
    after = rows[rows.length - 1].universeId;
    const stale = rows.flatMap((row) => {
      const fingerprint = contentFingerprint(row.name, row.description);
      const current =
        row.contentFingerprint === fingerprint && row.contentFingerprintVersion === CONTENT_FINGERPRINT_VERSION;
      return current ? [] : [sql`(${row.universeId}::bigint, ${row.metadataFingerprint}::text, ${fingerprint}::text)`];
    });
    if (!stale.length) continue;
    // Rows are locked in universe-id order, like poll's upserts. A game whose text a poll changed since the read
    // already holds the fingerprint poll gave it.
    const result = await db.execute(sql`
      with fresh (universe_id, metadata_fingerprint, content_fingerprint) as (values ${sql.join(stale, sql`, `)}),
      locked as materialized (
        select g.universe_id, f.content_fingerprint
        from games g
        join fresh f on f.universe_id = g.universe_id
        where g.metadata_fingerprint = f.metadata_fingerprint
          and (
            g.content_fingerprint <> f.content_fingerprint
            or g.content_fingerprint_version <> ${CONTENT_FINGERPRINT_VERSION}
          )
        order by g.universe_id
        for update of g
      )
      update games g
      set content_fingerprint = l.content_fingerprint, content_fingerprint_version = ${CONTENT_FINGERPRINT_VERSION}
      from locked l
      where g.universe_id = l.universe_id
    `);
    refreshed += result.rowCount ?? 0;
  }
}

// Versions are written once and never updated, so their version tells which ones to recompute, and no other writer
// competes for their rows.
async function refreshVersions(db: Database): Promise<number> {
  let refreshed = 0;
  for (let after = 0; ; ) {
    const rows = await db
      .select({ id: gameVersions.id, name: gameVersions.name, description: gameVersions.description })
      .from(gameVersions)
      .where(
        and(
          isNotNull(gameVersions.contentFingerprint),
          ne(gameVersions.contentFingerprintVersion, CONTENT_FINGERPRINT_VERSION),
          gt(gameVersions.id, after),
        ),
      )
      .orderBy(asc(gameVersions.id))
      .limit(BATCH_SIZE);
    if (!rows.length) return refreshed;
    const fresh = sql.join(
      rows.map((row) => sql`(${row.id}::integer, ${contentFingerprint(row.name ?? "", row.description ?? "")}::text)`),
      sql`, `,
    );
    const result = await db.execute(sql`
      with fresh (id, content_fingerprint) as (values ${fresh})
      update game_versions v
      set content_fingerprint = f.content_fingerprint, content_fingerprint_version = ${CONTENT_FINGERPRINT_VERSION}
      from fresh f
      where v.id = f.id
    `);
    refreshed += result.rowCount ?? 0;
    after = rows[rows.length - 1].id;
  }
}
