import type Anthropic from "@anthropic-ai/sdk";
import { chunk, compareText } from "@/lib/arrays";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { CLASSIFICATION_PROMPT_VERSION, classificationSystemPrompt } from "./prompt";
import { classificationCustomId, classificationRequest, readBatchResult } from "./request";
import type { ClassificationInput, ClassificationModel, ThumbnailImage, TrialResult } from "./types";

export interface TrialState {
  promptVersion: number;
  batches: Partial<Record<ClassificationModel, { id: string; submittedAt: string; requests: number }>>;
}

// The trial directory, abstracted for tests. scripts/classify-trial.ts implements it on the file system.
export interface TrialStore {
  readState(): Promise<TrialState | null>;
  writeState(state: TrialState): Promise<void>;
  readThumbnail(universeId: number): Promise<Buffer | null>;
  writeThumbnail(universeId: number, jpeg: Buffer): Promise<void>;
  readResults(model: ClassificationModel): Promise<TrialResult[] | null>;
  writeResults(model: ClassificationModel, results: TrialResult[]): Promise<void>;
}

// The subset of client.messages.batches the runner uses.
export interface BatchApi {
  create(
    params: { requests: { custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming }[] },
    options: { maxRetries: number },
  ): Promise<{ id: string }>;
  retrieve(id: string): Promise<{
    processing_status: string;
    request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  }>;
  results(id: string): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
}

export interface TrialDependencies {
  store: TrialStore;
  batches: BatchApi;
  downloadThumbnail: (url: string | null) => Promise<Buffer | null>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

interface SubmittedBatch {
  model: ClassificationModel;
  id: string;
  // The games whose request carried their thumbnail.
  withImage: ReadonlySet<number>;
}

// Every batch is paid for, so each model gets at most one per trial directory: its id is saved as soon as it exists,
// and a later run polls it instead of submitting again.
export async function runClassificationTrial(
  inputs: ClassificationInput[],
  models: readonly ClassificationModel[],
  dependencies: TrialDependencies,
  options: { pollIntervalMs?: number; maximumWaitMs?: number } = {},
): Promise<{ results: TrialResult[]; pending: ClassificationModel[] }> {
  const { store, batches, now, log } = dependencies;
  let state: TrialState = (await store.readState()) ?? { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: {} };
  if (state.promptVersion !== CLASSIFICATION_PROMPT_VERSION) {
    throw new Error(`Trial directory holds prompt version ${state.promptVersion}; use a new directory`);
  }

  const finished: TrialResult[] = [];
  const unfinished: ClassificationModel[] = [];
  // A Set, so a model named twice cannot be submitted twice.
  for (const model of new Set(models)) {
    const stored = await store.readResults(model);
    if (stored === null) {
      unfinished.push(model);
    } else {
      log(`Reusing the stored ${model} results (${stored.length} games)`);
      finished.push(...stored);
    }
  }
  const toSubmit = unfinished.filter((model) => state.batches[model] === undefined);

  const thumbnails = unfinished.length > 0 ? await loadThumbnails(inputs, dependencies, toSubmit.length > 0) : null;
  const sentWithImage = new Set(thumbnails?.images.keys());
  const system = classificationSystemPrompt();
  for (const model of toSubmit) {
    const requests = inputs.map((input) => ({
      custom_id: classificationCustomId(input.universeId),
      params: classificationRequest(model, input, thumbnails?.images.get(input.universeId) ?? null, system),
    }));
    // The SDK retries a timed-out or failed request, and a batch has no idempotency key: a retry after a lost response
    // would pay for a second batch whose id nobody saved. A failure is thrown instead, for the owner to check.
    const { id } = await batches.create({ requests }, { maxRetries: 0 });
    // Logged before the state is written, so the id of a paid batch is on screen even if the write fails.
    log(`Submitted the ${model} batch ${id} (${requests.length} requests)`);
    state = {
      ...state,
      batches: { ...state.batches, [model]: { id, submittedAt: now().toISOString(), requests: requests.length } },
    };
    await store.writeState(state);
  }

  const submitted = unfinished.map((model): SubmittedBatch => {
    const { id } = state.batches[model]!;
    if (toSubmit.includes(model)) return { model, id, withImage: sentWithImage };
    log(`Resuming the ${model} batch ${id}`);
    // Thumbnails are stored only before a submission, so an earlier batch carried those stored before this run.
    return { model, id, withImage: thumbnails?.storedBefore ?? new Set() };
  });
  const pending = await pollUntilEnded(submitted, dependencies, {
    pollIntervalMs: options.pollIntervalMs ?? CLASSIFICATION_CONFIG.batchPollIntervalMs,
    maximumWaitMs: options.maximumWaitMs ?? CLASSIFICATION_CONFIG.batchMaximumWaitMs,
    onEnded: async (batch) => {
      finished.push(...(await collectResults(batch, dependencies)));
    },
  });

  finished.sort((left, right) => left.universeId - right.universeId || compareText(left.model, right.model));
  return { results: finished, pending: pending.map((batch) => batch.model) };
}

// Reads every stored thumbnail and, when `download` is set, downloads and stores the missing ones. A game whose
// thumbnail is neither stored nor downloadable is classified from its text.
async function loadThumbnails(
  inputs: ClassificationInput[],
  { store, downloadThumbnail, log }: TrialDependencies,
  download: boolean,
): Promise<{ images: Map<number, ThumbnailImage>; storedBefore: Set<number> }> {
  const images = new Map<number, ThumbnailImage>();
  const storedBefore = new Set<number>();
  let downloaded = 0;
  for (const group of chunk(inputs, CLASSIFICATION_CONFIG.thumbnailDownloadConcurrency)) {
    await Promise.all(
      group.map(async ({ universeId, thumbnailUrl }) => {
        let jpeg = await store.readThumbnail(universeId);
        if (jpeg !== null) {
          storedBefore.add(universeId);
        } else if (download) {
          jpeg = await downloadThumbnail(thumbnailUrl);
          if (jpeg === null) return;
          await store.writeThumbnail(universeId, jpeg);
          downloaded += 1;
        }
        if (jpeg !== null) images.set(universeId, { mediaType: "image/jpeg", data: jpeg.toString("base64") });
      }),
    );
  }
  if (download) {
    log(`Thumbnails: ${storedBefore.size} stored, ${downloaded} downloaded, ${inputs.length - images.size} without one`);
  }
  return { images, storedBefore };
}

// Polls every waiting batch each round until all have ended or the maximum wait has passed; returns those still
// processing. A batch is collected as soon as it ends, so a later timeout or crash does not lose its results.
async function pollUntilEnded(
  batches: SubmittedBatch[],
  { batches: api, now, sleep, log }: TrialDependencies,
  options: { pollIntervalMs: number; maximumWaitMs: number; onEnded: (batch: SubmittedBatch) => Promise<void> },
): Promise<SubmittedBatch[]> {
  const deadline = now().getTime() + options.maximumWaitMs;
  let waiting = batches;
  while (waiting.length > 0) {
    const stillWaiting: SubmittedBatch[] = [];
    for (const batch of waiting) {
      const { processing_status: status, request_counts: counts } = await api.retrieve(batch.id);
      log(
        `${batch.model} batch ${batch.id}: ${status}, ${counts.processing} processing, ${counts.succeeded} succeeded, ` +
          `${counts.errored} errored, ${counts.canceled} canceled, ${counts.expired} expired`,
      );
      if (status === "ended") await options.onEnded(batch);
      else stillWaiting.push(batch);
    }
    waiting = stillWaiting;
    const remainingMs = deadline - now().getTime();
    if (waiting.length === 0 || remainingMs <= 0) break;
    await sleep(Math.min(options.pollIntervalMs, remainingMs));
  }
  if (waiting.length > 0) {
    log(`Stopped waiting after ${options.maximumWaitMs / 60_000} minutes; a rerun resumes ${waiting.map((batch) => batch.model).join(", ")}`);
  }
  return waiting;
}

// Read once, then stored: a stored result file is reused instead of the batch on later runs.
async function collectResults(batch: SubmittedBatch, { batches, store, log }: TrialDependencies): Promise<TrialResult[]> {
  const results: TrialResult[] = [];
  for await (const response of await batches.results(batch.id)) {
    const read = readBatchResult(response);
    // A custom id the runner did not write names no game.
    if (read === null) continue;
    results.push({
      universeId: read.universeId,
      model: batch.model,
      hadThumbnail: batch.withImage.has(read.universeId),
      outcome: read.outcome,
    });
  }
  results.sort((left, right) => left.universeId - right.universeId);
  await store.writeResults(batch.model, results);
  log(`Stored ${results.length} ${batch.model} results`);
  return results;
}
