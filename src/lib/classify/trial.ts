import type Anthropic from "@anthropic-ai/sdk";
import { chunk, compareText } from "@/lib/arrays";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { CLASSIFICATION_PROMPT_VERSION, classificationSystemPrompt } from "./prompt";
import { classificationCustomId, classificationRequest, readBatchResult } from "./request";
import type { ClassificationInput, ClassificationModel, ThumbnailImage, TrialResult } from "./types";

export interface TrialBatch {
  // Null from just before the submission until the API returns the id. A submission whose answer was lost may still
  // have created a batch, so a stored null stops every later run until the owner settles it.
  id: string | null;
  submittedAt: string;
  requests: number;
  // The games whose request went without a thumbnail, sorted. Thumbnails stored later do not change what was sent.
  withoutImage: number[];
}

export interface TrialState {
  promptVersion: number;
  batches: Partial<Record<ClassificationModel, TrialBatch>>;
}

// The trial directory, abstracted for tests. scripts/classify-trial.ts implements it on the file system.
export interface TrialStore {
  // Two runs on one directory would each submit a batch for a model that has none. Resolves with the release.
  lock(): Promise<() => Promise<void>>;
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
  withoutImage: ReadonlySet<number>;
}

type TrialOptions = { pollIntervalMs?: number; maximumWaitMs?: number };
type TrialOutcome = { results: TrialResult[]; pending: ClassificationModel[] };

// Every batch is paid for, so each model gets at most one per trial directory: its submission is recorded before it is
// sent, its id as soon as it exists, and a later run polls it instead of submitting again.
export async function runClassificationTrial(
  inputs: ClassificationInput[],
  models: readonly ClassificationModel[],
  dependencies: TrialDependencies,
  options: TrialOptions = {},
): Promise<TrialOutcome> {
  const release = await dependencies.store.lock();
  try {
    return await runLocked(inputs, models, dependencies, options);
  } finally {
    await release();
  }
}

async function runLocked(
  inputs: ClassificationInput[],
  models: readonly ClassificationModel[],
  dependencies: TrialDependencies,
  options: TrialOptions,
): Promise<TrialOutcome> {
  const { store, batches, now, log } = dependencies;
  let state: TrialState = (await store.readState()) ?? { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: {} };
  if (state.promptVersion !== CLASSIFICATION_PROMPT_VERSION) {
    throw new Error(`Trial directory holds prompt version ${state.promptVersion}; use a new directory`);
  }
  for (const [model, batch] of Object.entries(state.batches)) {
    if (batch?.id === null) throw new Error(unsavedSubmission(model, batch.submittedAt));
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

  const images = toSubmit.length > 0 ? await loadThumbnails(inputs, dependencies) : new Map<number, ThumbnailImage>();
  const withoutImage = inputs
    .map((input) => input.universeId)
    .filter((universeId) => !images.has(universeId))
    .sort((left, right) => left - right);
  const system = classificationSystemPrompt();
  for (const model of toSubmit) {
    const requests = inputs.map((input) => ({
      custom_id: classificationCustomId(input.universeId),
      params: classificationRequest(model, input, images.get(input.universeId) ?? null, system),
    }));
    const submittedAt = now().toISOString();
    state = withBatch(state, model, { id: null, submittedAt, requests: requests.length, withoutImage });
    await store.writeState(state);
    let id: string;
    try {
      // The SDK retries a timed-out or failed request, and a batch has no idempotency key: a retry after a lost
      // response would pay for a second batch whose id nobody saved. A failure is thrown instead, for the owner to check.
      ({ id } = await batches.create({ requests }, { maxRetries: 0 }));
    } catch (error) {
      if (rejectedByApi(error)) {
        state = withBatch(state, model, null);
        await store.writeState(state);
      } else {
        log(unsavedSubmission(model, submittedAt));
      }
      throw error;
    }
    // Logged before the state is written, so the id of a paid batch is on screen even if the write fails.
    log(`Submitted the ${model} batch ${id} (${requests.length} requests)`);
    state = withBatch(state, model, { id, submittedAt, requests: requests.length, withoutImage });
    await store.writeState(state);
  }

  const submitted = unfinished.map((model): SubmittedBatch => {
    const batch = state.batches[model]!;
    // Set for every model: a stored null throws above, and a new submission saves its id or throws.
    const id = batch.id!;
    if (!toSubmit.includes(model)) log(`Resuming the ${model} batch ${id}`);
    return { model, id, withoutImage: new Set(batch.withoutImage) };
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

function withBatch(state: TrialState, model: ClassificationModel, batch: TrialBatch | null): TrialState {
  const batches = { ...state.batches };
  if (batch === null) delete batches[model];
  else batches[model] = batch;
  return { ...state, batches };
}

// A 4xx answer means the API refused the request, so no batch exists. A timeout, a lost connection or a 5xx answer may
// come after the batch was created.
function rejectedByApi(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return typeof status === "number" && status >= 400 && status <= 499;
}

// The runner does not know the directory, so it names the state file alone.
function unsavedSubmission(model: string, submittedAt: string): string {
  return (
    `The ${model} batch submission of ${submittedAt} may have reached Anthropic without its id being saved. Find it ` +
    `in the Console's batch list and write its id into state.json, or delete the ${model} entry to submit again.`
  );
}

// Reads every stored thumbnail and downloads and stores the missing ones. A game whose thumbnail is neither stored nor
// downloadable is classified from its text.
async function loadThumbnails(
  inputs: ClassificationInput[],
  { store, downloadThumbnail, log }: TrialDependencies,
): Promise<Map<number, ThumbnailImage>> {
  const images = new Map<number, ThumbnailImage>();
  let stored = 0;
  let downloaded = 0;
  for (const group of chunk(inputs, CLASSIFICATION_CONFIG.thumbnailDownloadConcurrency)) {
    await Promise.all(
      group.map(async ({ universeId, thumbnailUrl }) => {
        let jpeg = await store.readThumbnail(universeId);
        if (jpeg !== null) {
          stored += 1;
        } else {
          jpeg = await downloadThumbnail(thumbnailUrl);
          if (jpeg === null) return;
          await store.writeThumbnail(universeId, jpeg);
          downloaded += 1;
        }
        images.set(universeId, { mediaType: "image/jpeg", data: jpeg.toString("base64") });
      }),
    );
  }
  log(`Thumbnails: ${stored} stored, ${downloaded} downloaded, ${inputs.length - images.size} without one`);
  return images;
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
      hadThumbnail: !batch.withoutImage.has(read.universeId),
      outcome: read.outcome,
    });
  }
  results.sort((left, right) => left.universeId - right.universeId);
  await store.writeResults(batch.model, results);
  log(`Stored ${results.length} ${batch.model} results`);
  return results;
}
