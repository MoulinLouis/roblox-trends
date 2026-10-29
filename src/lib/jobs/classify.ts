import { randomUUID } from "node:crypto";
import {
  deleteBatch,
  insertSubmittingBatch,
  markBatchSubmitted,
  readClassificationCandidates,
  readOpenBatches,
  requestsSubmittedSince,
  storeBatchResults,
  syncClassificationOverrides,
  type BatchItemResult,
  type ClassificationBatchRow,
} from "@/db/classifications";
import type { Database } from "@/db/client";
import { chunk } from "@/lib/arrays";
import { type BatchApi, rejectedByApi } from "@/lib/classify/batches";
import { classificationCostUsd } from "@/lib/classify/cost";
import { CLASSIFICATION_OVERRIDES, type ClassificationOverride } from "@/lib/classify/overrides";
import { CLASSIFICATION_PROMPT_VERSION } from "@/lib/classify/prompt";
import { classificationCustomId, classificationRequest, readBatchResult } from "@/lib/classify/request";
import { selectGamesToClassify, type Selection } from "@/lib/classify/selection";
import type { ClassifiedGame, ThumbnailImage } from "@/lib/classify/types";
import { CLASSIFICATION_CONFIG, JOB_CONFIG } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { JobDefinition } from "./runner";

export interface ClassifyDependencies {
  // Built inside the run: the SDK client throws without ANTHROPIC_API_KEY, which only the classify unit loads.
  batches: () => BatchApi;
  downloadThumbnail: (url: string | null) => Promise<Buffer | null>;
  overrides?: readonly ClassificationOverride[];
  newId?: () => string;
}

interface SubmittedBatch {
  requests: number;
  withoutThumbnail: number;
}

interface CollectedBatch {
  requests: number;
  classified: number;
  failed: number;
  released: number;
  costUsd: number;
  cacheReads: number;
}

const hourMs = 3_600_000;

// Every batch is paid for, so the submission follows the trial's: the batch row is written before the request, the SDK
// does not retry, and only a 4xx answer (no batch exists) removes the row. Any other failure keeps the row without an
// Anthropic id, which blocks every later submission until the owner settles it.
export function createClassifyJob(dependencies: ClassifyDependencies): JobDefinition {
  const config = JOB_CONFIG.classify;
  return {
    name: "classify",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const overrides = await syncClassificationOverrides(db, dependencies.overrides ?? CLASSIFICATION_OVERRIDES);
      const api = dependencies.batches();
      const open = await readOpenBatches(db);
      // A submission whose answer was lost may have created a batch: nothing is submitted until the owner settles it.
      const blocked = open.find((batch) => batch.anthropicId === null);
      const collected: CollectedBatch[] = [];
      let waitingBatches = 0;
      for (const batch of open) {
        if (batch.anthropicId === null) continue;
        const { processing_status: status } = await api.retrieve(batch.anthropicId);
        if (status === "ended") collected.push(await collectBatch(db, api, batch, batch.anthropicId, now));
        else waitingBatches += 1;
      }
      if (blocked) {
        logger.error("A classification batch submission was not confirmed", { batch: blocked.id, submittedAt: blocked.submittedAt });
      }

      let submitted: SubmittedBatch | null = null;
      let selection: Selection["counts"] | null = null;
      if (!blocked && waitingBatches === 0) {
        const used = await requestsSubmittedSince(db, new Date(now.getTime() - 24 * hourMs));
        const limit = Math.min(config.maximumGamesPerBatch, config.maximumRequestsPerDay - used);
        const chosen = selectGamesToClassify(await readClassificationCandidates(db), {
          now,
          limit: Math.max(limit, 0),
          minimumPromptVersion: config.minimumPromptVersion,
          retryFailedAfterHours: config.retryFailedAfterHours,
          maximumFailedAttempts: config.maximumFailedAttempts,
        });
        selection = chosen.counts;
        if (chosen.games.length > 0) submitted = await submitBatch(db, api, chosen.games, now, dependencies);
      }

      const failedShare = Math.max(0, ...collected.map((batch) => batch.failed / Math.max(batch.requests, 1)));
      return {
        status: blocked || failedShare > config.maximumFailedShare ? "degraded" : "success",
        stats: {
          overrides,
          collected: collected.length,
          classified: sum(collected, "classified"),
          failed: sum(collected, "failed"),
          released: sum(collected, "released"),
          costUsd: sum(collected, "costUsd"),
          cacheReads: sum(collected, "cacheReads"),
          waitingBatches,
          submitted: submitted?.requests ?? 0,
          withoutThumbnail: submitted?.withoutThumbnail ?? 0,
          selection,
          blockedBatch: blocked ? { id: blocked.id, submittedAt: blocked.submittedAt.toISOString() } : null,
        },
      };
    },
  };
}

function sum(batches: readonly CollectedBatch[], key: Exclude<keyof CollectedBatch, "requests">): number {
  return batches.reduce((total, batch) => total + batch[key], 0);
}

async function submitBatch(
  db: Database,
  api: BatchApi,
  games: readonly ClassifiedGame[],
  now: Date,
  dependencies: ClassifyDependencies,
): Promise<SubmittedBatch> {
  const model = JOB_CONFIG.classify.model;
  const images = new Map<number, ThumbnailImage>();
  for (const group of chunk(games, CLASSIFICATION_CONFIG.thumbnailDownloadConcurrency)) {
    await Promise.all(
      group.map(async (game) => {
        const jpeg = await dependencies.downloadThumbnail(game.thumbnailUrl);
        if (jpeg !== null) images.set(game.universeId, { mediaType: "image/jpeg", data: jpeg.toString("base64") });
      }),
    );
  }
  const requests = games.map((game) => ({
    custom_id: classificationCustomId(game.universeId),
    params: classificationRequest(model, game, images.get(game.universeId) ?? null),
  }));
  const id = (dependencies.newId ?? randomUUID)();
  await insertSubmittingBatch(
    db,
    { id, model, promptVersion: CLASSIFICATION_PROMPT_VERSION, submittedAt: now },
    games.map((game) => ({ universeId: game.universeId, name: game.name, hadThumbnail: images.has(game.universeId) })),
  );
  let anthropicId: string;
  try {
    // The SDK retries a timed-out or failed request, and a batch has no idempotency key: a retry after a lost
    // response would pay for a second batch whose id nobody saved.
    ({ id: anthropicId } = await api.create({ requests }, { maxRetries: 0 }));
  } catch (error) {
    if (rejectedByApi(error)) await deleteBatch(db, id);
    throw error;
  }
  // Logged before the write, so the id of a paid batch is in the journal even if the write fails.
  logger.info("Submitted a classification batch", { batch: id, anthropicId, requests: requests.length });
  await markBatchSubmitted(db, id, anthropicId);
  return { requests: requests.length, withoutThumbnail: games.length - images.size };
}

async function collectBatch(
  db: Database,
  api: BatchApi,
  batch: ClassificationBatchRow,
  anthropicId: string,
  now: Date,
): Promise<CollectedBatch> {
  const results: BatchItemResult[] = [];
  let costUsd = 0;
  let cacheReads = 0;
  for await (const response of await api.results(anthropicId)) {
    // Not answered: nothing was billed, and the game is submitted again.
    if (response.result.type === "expired" || response.result.type === "canceled") {
      const universeId = readBatchResult(response)?.universeId;
      if (universeId !== undefined) results.push({ universeId, status: "released" });
      continue;
    }
    const read = readBatchResult(response);
    // A custom id the job did not write names no game.
    if (read === null) continue;
    const { universeId, outcome } = read;
    if (outcome.usage) {
      costUsd += classificationCostUsd(batch.model, outcome.usage, { batch: true });
      if (outcome.usage.cacheReadInputTokens > 0) cacheReads += 1;
    }
    results.push(
      outcome.ok
        ? { universeId, status: "classified", classification: outcome.classification, usage: outcome.usage }
        : { universeId, status: "failed", error: outcome.error, usage: outcome.usage },
    );
  }
  const classified = results.filter((result) => result.status === "classified").length;
  const failed = results.filter((result) => result.status === "failed").length;
  // Games without a response are released with the expired ones: storeBatchResults deletes their pending rows.
  const released = batch.requests - classified - failed;
  await storeBatchResults(db, batch.id, results, { at: now, costUsd, stats: { classified, failed, released, cacheReads } });
  return { requests: batch.requests, classified, failed, released, costUsd, cacheReads };
}
