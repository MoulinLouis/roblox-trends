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
import { classificationCustomId, classificationRequest, readBatchResult, universeIdFromCustomId } from "@/lib/classify/request";
import { selectGamesToClassify, type Selection } from "@/lib/classify/selection";
import type { ClassifiedGame, ThumbnailImage } from "@/lib/classify/types";
import { CLASSIFICATION_CONFIG, JOB_CONFIG } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { JobDefinition } from "./runner";

export interface ClassifyDependencies {
  // Built inside the run, so building every job needs no Anthropic credentials: only the classify unit loads the key.
  batches: () => BatchApi;
  downloadThumbnail: (url: string | null) => Promise<Buffer | null>;
  overrides?: readonly ClassificationOverride[];
  newId?: () => string;
  // Measures the run's own wall-clock time, apart from the `now` of the slot.
  clock?: () => number;
}

type RequestCounts = Awaited<ReturnType<BatchApi["retrieve"]>>["request_counts"];

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

const dayMs = 24 * 60 * 60 * 1000;

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
      const clock = dependencies.clock ?? Date.now;
      const startedMs = clock();
      const overrides = await syncClassificationOverrides(db, dependencies.overrides ?? CLASSIFICATION_OVERRIDES);
      const api = dependencies.batches();
      const open = await readOpenBatches(db);
      // A submission whose answer was lost may have created a batch: nothing is submitted until the owner settles it.
      const blocked = open.find((batch) => batch.anthropicId === null);
      const collected: CollectedBatch[] = [];
      let waitingBatches = 0;
      for (const batch of open) {
        if (batch.anthropicId === null) continue;
        const { processing_status: status, request_counts: counts } = await api.retrieve(batch.anthropicId);
        if (status === "ended") collected.push(await collectBatch(db, api, batch, batch.anthropicId, counts, now));
        else waitingBatches += 1;
      }
      if (blocked) {
        logger.error("A classification batch submission was not confirmed", { batch: blocked.id, submittedAt: blocked.submittedAt });
      }

      let submitted: SubmittedBatch | null = null;
      let selection: Selection["counts"] | null = null;
      if (!blocked && waitingBatches === 0) {
        const used = await requestsSubmittedSince(db, new Date(now.getTime() - dayMs));
        const limit = Math.min(config.maximumGamesPerBatch, config.maximumRequestsPerDay - used);
        const chosen = selectGamesToClassify(await readClassificationCandidates(db), {
          now,
          limit: Math.max(limit, 0),
          minimumPromptVersion: config.minimumPromptVersion,
          retryFailedAfterHours: config.retryFailedAfterHours,
          maximumFailedAttempts: config.maximumFailedAttempts,
          thumbnailWaitHours: config.thumbnailWaitHours,
        });
        selection = chosen.counts;
        if (chosen.games.length > 0) submitted = await submitBatch(db, api, chosen.games, now, { ...dependencies, clock, startedMs });
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
  dependencies: ClassifyDependencies & { clock: () => number; startedMs: number },
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
  // The runner's timeout does not stop this run, and the process exits when it fires: a submission started late could be
  // killed mid-create, and the id of a paid batch would be lost.
  if (dependencies.clock() - dependencies.startedMs > JOB_CONFIG.classify.latestSubmissionMs) {
    throw new Error("The run is too late to submit a batch safely; the next run submits these games");
  }
  const id = (dependencies.newId ?? randomUUID)();
  await insertSubmittingBatch(
    db,
    { id, model, promptVersion: CLASSIFICATION_PROMPT_VERSION, submittedAt: now },
    games.map((game) => ({ universeId: game.universeId, name: game.name, hadThumbnail: images.has(game.universeId) })),
  );
  let anthropicId: string;
  try {
    // The SDK retries a timed-out or failed request, and a batch has no idempotency key: a retry after a lost
    // response would pay for a second batch whose id nobody saved. The timeout keeps the call inside the runner's.
    ({ id: anthropicId } = await api.create({ requests }, { maxRetries: 0, timeout: JOB_CONFIG.classify.createTimeoutMs }));
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
  counts: RequestCounts,
  now: Date,
): Promise<CollectedBatch> {
  // The first answer per game wins; cost and cache reads count only the answers kept.
  const results = new Map<number, BatchItemResult>();
  let costUsd = 0;
  let cacheReads = 0;
  let read = 0;
  for await (const response of await api.results(anthropicId)) {
    read += 1;
    // Not answered: nothing was billed, and the game is submitted again.
    if (response.result.type === "expired" || response.result.type === "canceled") {
      const universeId = universeIdFromCustomId(response.custom_id);
      if (universeId !== null && !results.has(universeId)) results.set(universeId, { universeId, status: "released" });
      continue;
    }
    const answer = readBatchResult(response);
    // A custom id the job did not write names no game.
    if (answer === null || results.has(answer.universeId)) continue;
    const { universeId, outcome } = answer;
    if (outcome.usage) {
      costUsd += classificationCostUsd(batch.model, outcome.usage, { batch: true });
      if (outcome.usage.cacheReadInputTokens > 0) cacheReads += 1;
    }
    results.set(
      universeId,
      outcome.ok
        ? { universeId, status: "classified", classification: outcome.classification, usage: outcome.usage }
        : { universeId, status: "failed", error: outcome.error, usage: outcome.usage },
    );
  }
  // A stream cut short without an error would release games that were answered and billed, and pay for them again.
  const expected = counts.succeeded + counts.errored + counts.canceled + counts.expired;
  if (read < expected) {
    throw new Error(`The results of batch ${batch.id} hold ${read} answers, fewer than the ${expected} it reports; the next run collects it again`);
  }
  const stored = [...results.values()];
  const classified = stored.filter((result) => result.status === "classified").length;
  const failed = stored.filter((result) => result.status === "failed").length;
  // Games without a response are released with the expired ones: storeBatchResults deletes their pending rows.
  const released = batch.requests - classified - failed;
  await storeBatchResults(db, batch.id, stored, { at: now, costUsd, stats: { classified, failed, released, cacheReads } });
  return { requests: batch.requests, classified, failed, released, costUsd, cacheReads };
}
