import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { GameClassification } from "@/lib/classify/schema";
import type { ClassificationOverride } from "@/lib/classify/overrides";
import type { ClassificationCandidate } from "@/lib/classify/selection";
import type { ClassificationModel, ClassificationUsage } from "@/lib/classify/types";
import type { Database } from "./client";
import { classificationBatches, classificationOverrides, classifications } from "./schema";

export interface ClassificationBatchRow {
  id: string;
  anthropicId: string | null;
  model: ClassificationModel;
  requests: number;
  submittedAt: Date;
}

export interface BatchItem {
  universeId: number;
  name: string;
  hadThumbnail: boolean;
}

export type BatchItemResult =
  | { universeId: number; status: "classified"; classification: GameClassification; usage: ClassificationUsage }
  | { universeId: number; status: "failed"; error: string; usage: ClassificationUsage | null }
  | { universeId: number; status: "released" };

// Replaces the table's content with the given overrides, in one transaction. Returns their number.
export async function syncClassificationOverrides(db: Database, overrides: readonly ClassificationOverride[]): Promise<number> {
  await db.transaction(async (transaction) => {
    await transaction.delete(classificationOverrides);
    if (overrides.length === 0) return;
    await transaction.insert(classificationOverrides).values(
      overrides.map((override) => ({
        universeId: override.universeId,
        field: override.field,
        value: override.value,
        reason: override.reason,
        decidedAt: override.decidedAt,
      })),
    );
  });
  return overrides.length;
}

// Every game once, with what its classifications say: the latest successful one, whether a request is in flight, and the
// failures since that success. The lateral subqueries use classifications_game_idx.
export async function readClassificationCandidates(db: Database): Promise<ClassificationCandidate[]> {
  const result = await db.execute<{
    universe_id: string;
    name: string;
    description: string;
    genre: string | null;
    thumbnail_url: string | null;
    last_ccu: number;
    pending: boolean;
    classified_name: string | null;
    classified_prompt_version: number | null;
    failures: { name: string; finishedAt: string }[];
  }>(sql`
    select g.universe_id, g.name, g.description, g.genre, g.thumbnail_url, g.last_ccu,
      exists (select 1 from classifications p where p.universe_id = g.universe_id and p.status = 'pending') as pending,
      latest.name as classified_name, latest.prompt_version as classified_prompt_version,
      coalesce(failures.items, '[]'::jsonb) as failures
    from games g
    left join lateral (
      select c.name, b.prompt_version, c.finished_at
      from classifications c
      join classification_batches b on b.id = c.batch_id
      where c.universe_id = g.universe_id and c.status = 'classified'
      order by c.finished_at desc
      limit 1
    ) latest on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('name', f.name, 'finishedAt', f.finished_at) order by f.finished_at) as items
      from classifications f
      where f.universe_id = g.universe_id and f.status = 'failed'
        and (latest.finished_at is null or f.finished_at > latest.finished_at)
    ) failures on true
  `);
  return result.rows.map((row) => ({
    universeId: Number(row.universe_id),
    name: row.name,
    description: row.description,
    genre: row.genre,
    thumbnailUrl: row.thumbnail_url,
    lastCcu: Number(row.last_ccu),
    pending: row.pending,
    classified:
      row.classified_name === null || row.classified_prompt_version === null
        ? null
        : { name: row.classified_name, promptVersion: Number(row.classified_prompt_version) },
    failures: row.failures.map((failure) => ({ name: failure.name, finishedAt: new Date(failure.finishedAt) })),
  }));
}

// The batch row and its pending rows are written before the batch is submitted, with no Anthropic id yet.
export async function insertSubmittingBatch(
  db: Database,
  batch: { id: string; model: ClassificationModel; promptVersion: number; submittedAt: Date },
  items: readonly BatchItem[],
): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.insert(classificationBatches).values({
      id: batch.id,
      model: batch.model,
      promptVersion: batch.promptVersion,
      requests: items.length,
      submittedAt: batch.submittedAt,
    });
    if (items.length === 0) return;
    await transaction.insert(classifications).values(
      items.map((item) => ({
        batchId: batch.id,
        universeId: item.universeId,
        name: item.name,
        hadThumbnail: item.hadThumbnail,
        status: "pending" as const,
      })),
    );
  });
}

export async function markBatchSubmitted(db: Database, id: string, anthropicId: string): Promise<void> {
  await db.update(classificationBatches).set({ anthropicId }).where(eq(classificationBatches.id, id));
}

// Its rows go with it (cascade).
export async function deleteBatch(db: Database, id: string): Promise<void> {
  await db.delete(classificationBatches).where(eq(classificationBatches.id, id));
}

// Batches not collected yet, oldest first, including one still without an Anthropic id.
export async function readOpenBatches(db: Database): Promise<ClassificationBatchRow[]> {
  return db
    .select({
      id: classificationBatches.id,
      anthropicId: classificationBatches.anthropicId,
      model: classificationBatches.model,
      requests: classificationBatches.requests,
      submittedAt: classificationBatches.submittedAt,
    })
    .from(classificationBatches)
    .where(isNull(classificationBatches.collectedAt))
    .orderBy(asc(classificationBatches.submittedAt), asc(classificationBatches.id));
}

// Rows of the batch without a result are released, like expired ones: nothing was classified or billed.
export async function storeBatchResults(
  db: Database,
  id: string,
  results: readonly BatchItemResult[],
  collected: { at: Date; costUsd: number; stats: Record<string, unknown> },
): Promise<void> {
  await db.transaction(async (transaction) => {
    for (const result of results) {
      if (result.status === "released") continue;
      const usage = result.usage;
      const usageColumns = {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadInputTokens ?? null,
        cacheWriteTokens: usage?.cacheCreationInputTokens ?? null,
      };
      const values =
        result.status === "classified"
          ? { ...result.classification, status: "classified" as const, finishedAt: collected.at, ...usageColumns }
          : { status: "failed" as const, error: result.error, finishedAt: collected.at, ...usageColumns };
      await transaction
        .update(classifications)
        .set(values)
        .where(and(eq(classifications.batchId, id), eq(classifications.universeId, result.universeId)));
    }
    // Released rows and rows without a result are still pending.
    await transaction.delete(classifications).where(and(eq(classifications.batchId, id), eq(classifications.status, "pending")));
    await transaction
      .update(classificationBatches)
      .set({ collectedAt: collected.at, costUsd: collected.costUsd, stats: collected.stats })
      .where(eq(classificationBatches.id, id));
  });
}

// What the daily request cap counts: batches submitted after the given time, collected or not.
export async function requestsSubmittedSince(db: Database, since: Date): Promise<number> {
  const result = await db.execute<{ requests: string }>(sql`
    select coalesce(sum(requests), 0) as requests
    from classification_batches
    where submitted_at > ${since.toISOString()}::timestamptz
  `);
  return Number(result.rows[0]?.requests ?? 0);
}
