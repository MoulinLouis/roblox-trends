import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { CLASSIFICATION_PROMPT_VERSION } from "./prompt";
import { classificationCustomId } from "./request";
import type { GameClassification } from "./schema";
import {
  type BatchApi,
  runClassificationTrial,
  type TrialBatch,
  type TrialDependencies,
  type TrialState,
  type TrialStore,
} from "./trial";
import type { ClassificationInput, ClassificationModel, TrialResult } from "./types";

const opus: ClassificationModel = "claude-opus-5-5";
const haiku: ClassificationModel = "claude-haiku-5-5";

type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;

function game(universeId: number, thumbnailUrl: string | null = `https://tr.rbxcdn.com/${universeId}.png`): ClassificationInput {
  return {
    universeId,
    name: `Game ${universeId}`,
    description: "Collect pets.",
    genre: null,
    thumbnailUrl,
    robloxCreatedAt: "2026-10-01T00:00:00.000Z",
    peakCcu: 0,
    stratum: "young-under-100",
  };
}

const answer: GameClassification = {
  reason: "The title names pets.",
  family: "simulator",
  template: "none",
  rewardLoop: "pets",
  coreAction: "collect pets",
  theme: "pets",
  setting: "island",
  progression: "collection",
  social: "solo",
  confidence: "medium",
};

function answered(customId: string): Anthropic.Messages.MessageBatchIndividualResponse {
  const message = {
    id: `msg_${customId}`,
    type: "message",
    role: "assistant",
    model: haiku,
    content: [{ type: "text", text: JSON.stringify(answer), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Anthropic.Message;
  return { custom_id: customId, result: { type: "succeeded", message } };
}

function result(universeId: number, model: ClassificationModel, hadThumbnail: boolean): TrialResult {
  return {
    universeId,
    model,
    hadThumbnail,
    outcome: {
      ok: true,
      classification: answer,
      usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    },
  };
}

function jpeg(url: string): Buffer {
  return Buffer.from(`jpeg of ${url}`);
}

class MemoryStore implements TrialStore {
  state: TrialState | null = null;
  locked = false;
  readonly thumbnails = new Map<number, Buffer>();
  readonly results = new Map<ClassificationModel, TrialResult[]>();

  async lock() {
    if (this.locked) throw new Error("The trial directory is locked");
    this.locked = true;
    return async () => {
      this.locked = false;
    };
  }
  async readState() {
    return structuredClone(this.state);
  }
  async writeState(state: TrialState) {
    if (!this.locked) throw new Error("State written without the lock");
    this.state = structuredClone(state);
  }
  async readThumbnail(universeId: number) {
    return this.thumbnails.get(universeId) ?? null;
  }
  async writeThumbnail(universeId: number, image: Buffer) {
    this.thumbnails.set(universeId, image);
  }
  async readResults(model: ClassificationModel) {
    return structuredClone(this.results.get(model) ?? null);
  }
  async writeResults(model: ClassificationModel, results: TrialResult[]) {
    this.results.set(model, structuredClone(results));
  }
}

interface FakeBatch {
  model: ClassificationModel;
  customIds: string[];
  retrievals: number;
}

// Ends a model's batch on its Nth retrieve (the first by default) and answers every custom id, plus one line whose
// custom id names no game.
class FakeBatchApi {
  readonly created: { model: ClassificationModel; requests: BatchRequest[]; maxRetries: number }[] = [];
  readonly retrieved: string[] = [];
  readonly resultsRead: string[] = [];
  // What create throws for a model.
  readonly failures = new Map<ClassificationModel, unknown>();
  private readonly batches = new Map<string, FakeBatch>();

  constructor(
    private readonly endsAfter: Partial<Record<ClassificationModel, number>> = {},
    private readonly onRetrieve: () => void = () => {},
  ) {}

  seed(id: string, model: ClassificationModel, inputs: ClassificationInput[]): void {
    this.batches.set(id, { model, customIds: inputs.map((input) => classificationCustomId(input.universeId)), retrievals: 0 });
  }

  readonly api: BatchApi = {
    create: async ({ requests }, { maxRetries }) => {
      const model = requests[0].params.model as ClassificationModel;
      if (this.failures.has(model)) throw this.failures.get(model);
      this.created.push({ model, requests, maxRetries });
      const id = `msgbatch_${this.created.length}`;
      this.batches.set(id, { model, customIds: requests.map((request) => request.custom_id), retrievals: 0 });
      return { id };
    },
    retrieve: async (id) => {
      this.onRetrieve();
      this.retrieved.push(id);
      const batch = this.batch(id);
      batch.retrievals += 1;
      const ended = batch.retrievals >= (this.endsAfter[batch.model] ?? 1);
      const requests = batch.customIds.length;
      return {
        processing_status: ended ? "ended" : "in_progress",
        request_counts: { processing: ended ? 0 : requests, succeeded: ended ? requests : 0, errored: 0, canceled: 0, expired: 0 },
      };
    },
    results: async (id) => {
      this.resultsRead.push(id);
      const { customIds } = this.batch(id);
      return (async function* () {
        yield { custom_id: "not-a-game", result: { type: "canceled" } } satisfies Anthropic.Messages.MessageBatchIndividualResponse;
        for (const customId of customIds) yield answered(customId);
      })();
    },
  };

  createdModels(): ClassificationModel[] {
    return this.created.map((batch) => batch.model);
  }

  private batch(id: string): FakeBatch {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`Unknown batch ${id}`);
    return batch;
  }
}

function setup(endsAfter: Partial<Record<ClassificationModel, number>> = {}) {
  const store = new MemoryStore();
  let stateAtFirstRetrieve: TrialState | null | undefined;
  const batches = new FakeBatchApi(endsAfter, () => {
    if (stateAtFirstRetrieve === undefined) stateAtFirstRetrieve = structuredClone(store.state);
  });
  const statesAtCreate: (TrialState | null)[] = [];
  const downloads: (string | null)[] = [];
  const logs: string[] = [];
  const start = Date.parse("2026-10-28T12:00:00.000Z");
  let time = start;
  const dependencies: TrialDependencies = {
    store,
    batches: {
      ...batches.api,
      create: (params, options) => {
        statesAtCreate.push(structuredClone(store.state));
        return batches.api.create(params, options);
      },
    },
    downloadThumbnail: async (url) => {
      downloads.push(url);
      return url === null ? null : jpeg(url);
    },
    now: () => new Date(time),
    sleep: async (ms) => {
      time += ms;
    },
    log: (message) => logs.push(message),
  };
  return {
    store,
    batches,
    downloads,
    logs,
    dependencies,
    stateAtFirstRetrieve: () => stateAtFirstRetrieve,
    statesAtCreate,
    elapsedMs: () => time - start,
  };
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function storedBatch(id: string, withoutImage: number[] = []): TrialBatch {
  return { id, submittedAt: "2026-10-28T10:00:00.000Z", requests: 2, withoutImage };
}

function imageData(request: BatchRequest): string | null {
  const [message] = request.params.messages;
  if (typeof message.content === "string") return null;
  for (const block of message.content) {
    if (block.type !== "image") continue;
    if (block.source.type !== "base64") throw new Error(`Unexpected image source: ${block.source.type}`);
    expect(block.source.media_type).toBe("image/jpeg");
    return block.source.data;
  }
  return null;
}

describe("runClassificationTrial", () => {
  it("accepts the SDK's batches resource as its BatchApi", () => {
    expectTypeOf<Anthropic.Messages.Batches>().toExtend<BatchApi>();
  });

  it("submits one batch per model and saves its id before polling", async () => {
    const trial = setup();
    const inputs = [game(30), game(10), game(20)];

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.batches.createdModels()).toEqual([opus, haiku]);
    // A retried create whose first response was lost would pay for a second batch.
    expect(trial.batches.created.map((batch) => batch.maxRetries)).toEqual([0, 0]);
    expect(trial.stateAtFirstRetrieve()).toEqual({
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      batches: {
        [opus]: { id: "msgbatch_1", submittedAt: "2026-10-28T12:00:00.000Z", requests: 3, withoutImage: [] },
        [haiku]: { id: "msgbatch_2", submittedAt: "2026-10-28T12:00:00.000Z", requests: 3, withoutImage: [] },
      },
    });
    expect(trial.batches.created[0].requests.map((request) => request.custom_id)).toEqual(["u30", "u10", "u20"]);
    // Both requests share one system prompt, the cached prefix.
    const systems = trial.batches.created.flatMap((batch) => batch.requests.map((request) => JSON.stringify(request.params.system)));
    expect(new Set(systems).size).toBe(1);
    expect(trial.batches.resultsRead).toEqual(["msgbatch_1", "msgbatch_2"]);
    expect(outcome).toEqual({
      results: [
        result(10, haiku, true),
        result(10, opus, true),
        result(20, haiku, true),
        result(20, opus, true),
        result(30, haiku, true),
        result(30, opus, true),
      ],
      pending: [],
    });
    expect(trial.store.results.get(opus)).toEqual([result(10, opus, true), result(20, opus, true), result(30, opus, true)]);
    expect(trial.store.results.get(haiku)).toHaveLength(3);
  });

  it("resumes a stored batch instead of submitting again", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.store.state = { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: { [opus]: storedBatch("msgbatch_earlier") } };
    trial.batches.seed("msgbatch_earlier", opus, inputs);

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.batches.createdModels()).toEqual([haiku]);
    expect(trial.batches.retrieved).toContain("msgbatch_earlier");
    expect(trial.store.state?.batches[opus]).toEqual(storedBatch("msgbatch_earlier"));
    expect(outcome.results.filter((item) => item.model === opus).map((item) => item.universeId)).toEqual([10, 20]);
    expect(outcome.pending).toEqual([]);
  });

  it("keeps the first model's batch id when the API rejects the second submission, and a rerun submits only the second", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.batches.failures.set(haiku, apiError(429, "429 rate_limit_error"));

    await expect(runClassificationTrial(inputs, [opus, haiku], trial.dependencies)).rejects.toThrow("429 rate_limit_error");

    expect(trial.store.state).toEqual({
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      batches: { [opus]: { id: "msgbatch_1", submittedAt: "2026-10-28T12:00:00.000Z", requests: 2, withoutImage: [] } },
    });
    expect(trial.batches.retrieved).toEqual([]);

    trial.batches.failures.clear();
    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.batches.createdModels()).toEqual([opus, haiku]);
    expect(trial.store.state?.batches[opus]?.id).toBe("msgbatch_1");
    expect(outcome.results).toHaveLength(4);
  });

  // The entry is complete but for the id, so an owner who finds the batch in the Console only has to write its id.
  it("records each submission before sending it", async () => {
    const trial = setup();

    await runClassificationTrial([game(10), game(20, null)], [opus, haiku], trial.dependencies);

    expect(trial.statesAtCreate.map((state) => state?.batches)).toEqual([
      { [opus]: { id: null, submittedAt: "2026-10-28T12:00:00.000Z", requests: 2, withoutImage: [20] } },
      {
        [opus]: { id: "msgbatch_1", submittedAt: "2026-10-28T12:00:00.000Z", requests: 2, withoutImage: [20] },
        [haiku]: { id: null, submittedAt: "2026-10-28T12:00:00.000Z", requests: 2, withoutImage: [20] },
      },
    ]);
  });

  // A timeout, a lost connection or a server error can follow a batch that was created and is billed.
  it.each([
    ["a server error", apiError(500, "500 api_error")],
    ["an error without a status", new Error("Connection error.")],
  ])("keeps a submission that failed with %s, and a rerun refuses to submit again", async (_, error) => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.batches.failures.set(opus, error);

    await expect(runClassificationTrial(inputs, [opus, haiku], trial.dependencies)).rejects.toBe(error);

    expect(trial.store.state?.batches).toEqual({
      [opus]: { id: null, submittedAt: "2026-10-28T12:00:00.000Z", requests: 2, withoutImage: [] },
    });
    const message =
      "The claude-opus-5-5 batch submission of 2026-10-28T12:00:00.000Z may have reached Anthropic without its id being " +
      "saved. Find it in the Console's batch list and write its id into state.json, or delete the claude-opus-5-5 entry " +
      "to submit again.";
    expect(trial.logs).toContain(message);

    trial.batches.failures.clear();
    const downloads = trial.downloads.length;
    await expect(runClassificationTrial(inputs, [opus, haiku], trial.dependencies)).rejects.toThrow(message);
    expect(trial.batches.created).toEqual([]);
    expect(trial.downloads).toHaveLength(downloads);
    expect(trial.store.state?.batches[opus]?.id).toBeNull();
  });

  it("drops a submission the API rejected, and a rerun submits it", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    const error = apiError(400, "400 invalid_request_error");
    trial.batches.failures.set(opus, error);

    await expect(runClassificationTrial(inputs, [opus], trial.dependencies)).rejects.toBe(error);

    expect(trial.store.state?.batches).toEqual({});

    trial.batches.failures.clear();
    const outcome = await runClassificationTrial(inputs, [opus], trial.dependencies);

    expect(trial.batches.createdModels()).toEqual([opus]);
    expect(trial.store.state?.batches[opus]?.id).toBe("msgbatch_1");
    expect(outcome.results).toHaveLength(2);
  });

  it("releases the directory lock when it ends and when it throws", async () => {
    const trial = setup();

    await runClassificationTrial([game(10)], [haiku], trial.dependencies);
    expect(trial.store.locked).toBe(false);

    trial.batches.failures.set(opus, new Error("Connection error."));
    await expect(runClassificationTrial([game(10)], [opus], trial.dependencies)).rejects.toThrow("Connection error.");
    expect(trial.store.locked).toBe(false);
  });

  it("does nothing while another run holds the directory lock", async () => {
    const trial = setup();
    trial.store.locked = true;

    await expect(runClassificationTrial([game(10)], [opus, haiku], trial.dependencies)).rejects.toThrow(
      "The trial directory is locked",
    );

    expect(trial.store.locked).toBe(true);
    expect(trial.downloads).toEqual([]);
    expect(trial.batches.created).toEqual([]);
  });

  it("reuses stored results", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.store.state = { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: { [opus]: storedBatch("msgbatch_earlier") } };
    trial.store.results.set(opus, [result(10, opus, true), result(20, opus, false)]);

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.batches.createdModels()).toEqual([haiku]);
    expect(trial.batches.retrieved).not.toContain("msgbatch_earlier");
    expect(trial.batches.resultsRead).not.toContain("msgbatch_earlier");
    expect(outcome.results.filter((item) => item.model === opus)).toEqual([result(10, opus, true), result(20, opus, false)]);
  });

  it("downloads no thumbnail when every model already has a batch or results", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.store.state = { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: { [haiku]: storedBatch("msgbatch_earlier", [20]) } };
    trial.batches.seed("msgbatch_earlier", haiku, inputs);
    trial.store.results.set(opus, [result(10, opus, true), result(20, opus, true)]);

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.downloads).toEqual([]);
    expect(trial.batches.created).toEqual([]);
    expect(outcome.results.filter((item) => item.model === haiku)).toEqual([result(10, haiku, true), result(20, haiku, false)]);
  });

  it("downloads only the missing thumbnails, a bounded number at a time", async () => {
    const trial = setup();
    const inputs = Array.from({ length: 20 }, (_, index) => game(index + 1));
    trial.store.thumbnails.set(1, jpeg("stored"));
    let inFlight = 0;
    let mostInFlight = 0;
    const downloaded: (string | null)[] = [];
    trial.dependencies.downloadThumbnail = async (url) => {
      downloaded.push(url);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return url === null ? null : jpeg(url);
    };

    await runClassificationTrial(inputs, [haiku], trial.dependencies);

    expect(downloaded).toHaveLength(19);
    expect(downloaded).not.toContain(inputs[0].thumbnailUrl);
    expect(mostInFlight).toBe(CLASSIFICATION_CONFIG.thumbnailDownloadConcurrency);
    expect(trial.store.thumbnails.get(1)).toEqual(jpeg("stored"));
    expect(trial.store.thumbnails.get(2)).toEqual(jpeg(inputs[1].thumbnailUrl!));
    expect(imageData(trial.batches.created[0].requests[0])).toBe(jpeg("stored").toString("base64"));
  });

  it("returns pending models after the maximum wait", async () => {
    const trial = setup({ [opus]: Number.POSITIVE_INFINITY, [haiku]: 2 });
    const inputs = [game(10), game(20)];

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies, {
      pollIntervalMs: 1_000,
      maximumWaitMs: 4_500,
    });

    expect(outcome.pending).toEqual([opus]);
    expect(outcome.results.map((item) => item.model)).toEqual([haiku, haiku]);
    expect(trial.store.state?.batches[opus]?.id).toBe("msgbatch_1");
    expect(trial.store.results.has(opus)).toBe(false);
    expect(trial.store.results.get(haiku)).toHaveLength(2);
    expect(trial.batches.resultsRead).toEqual(["msgbatch_2"]);
    // Polls at 0, 1, 2, 3, 4 and 4.5 seconds; Haiku ends on its second poll.
    expect(trial.elapsedMs()).toBe(4_500);
    expect(trial.batches.retrieved.filter((id) => id === "msgbatch_1")).toHaveLength(6);
    expect(trial.batches.retrieved.filter((id) => id === "msgbatch_2")).toHaveLength(2);
    expect(trial.logs.filter((line) => line.includes("msgbatch_1") && line.includes("2 processing"))).toHaveLength(6);
  });

  it("classifies without an image when the thumbnail is missing", async () => {
    const trial = setup();
    const inputs = [game(10), game(20, null), game(30)];
    trial.dependencies.downloadThumbnail = async (url) => (url === inputs[2].thumbnailUrl || url === null ? null : jpeg(url));

    const outcome = await runClassificationTrial(inputs, [haiku], trial.dependencies);

    const [withImage, withoutUrl, failedDownload] = trial.batches.created[0].requests;
    expect(imageData(withImage)).toBe(jpeg(inputs[0].thumbnailUrl!).toString("base64"));
    expect(imageData(withoutUrl)).toBeNull();
    expect(imageData(failedDownload)).toBeNull();
    expect([...trial.store.thumbnails.keys()]).toEqual([10]);
    expect(outcome.results.map((item) => [item.universeId, item.hadThumbnail])).toEqual([
      [10, true],
      [20, false],
      [30, false],
    ]);
  });

  it("records the games sent without a thumbnail in the batch's entry, sorted", async () => {
    const trial = setup();
    const inputs = [game(40, null), game(10), game(30)];
    trial.dependencies.downloadThumbnail = async (url) => (url === inputs[2].thumbnailUrl || url === null ? null : jpeg(url));

    await runClassificationTrial(inputs, [haiku], trial.dependencies);

    expect(trial.store.state?.batches[haiku]?.withoutImage).toEqual([30, 40]);
  });

  // Thumbnails stored since the submission, or deleted, do not change what the batch carried.
  it("reads which requests of a resumed batch carried an image from its entry, not from the stored thumbnails", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    trial.store.thumbnails.set(10, jpeg("10"));
    trial.store.thumbnails.set(20, jpeg("20"));
    trial.store.state = { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: { [opus]: storedBatch("msgbatch_earlier", [10]) } };
    trial.batches.seed("msgbatch_earlier", opus, inputs);

    const outcome = await runClassificationTrial(inputs, [opus], trial.dependencies);

    expect(outcome.results.map((item) => [item.universeId, item.hadThumbnail])).toEqual([
      [10, false],
      [20, true],
    ]);
  });

  it("records the image a resumed batch carried, not one downloaded since", async () => {
    const trial = setup();
    const inputs = [game(10), game(20)];
    // The earlier run stored game 10's thumbnail, failed to download game 20's and submitted Opus before it stopped.
    trial.store.thumbnails.set(10, jpeg("10"));
    trial.store.state = { promptVersion: CLASSIFICATION_PROMPT_VERSION, batches: { [opus]: storedBatch("msgbatch_earlier", [20]) } };
    trial.batches.seed("msgbatch_earlier", opus, inputs);

    const outcome = await runClassificationTrial(inputs, [opus, haiku], trial.dependencies);

    expect(trial.downloads).toEqual([inputs[1].thumbnailUrl]);
    expect(outcome.results.map((item) => [item.universeId, item.model, item.hadThumbnail])).toEqual([
      [10, haiku, true],
      [10, opus, true],
      [20, haiku, true],
      [20, opus, false],
    ]);
  });

  it("refuses a directory of another prompt version", async () => {
    const trial = setup();
    const version = CLASSIFICATION_PROMPT_VERSION + 1;
    trial.store.state = { promptVersion: version, batches: {} };

    await expect(runClassificationTrial([game(10)], [opus, haiku], trial.dependencies)).rejects.toThrow(
      `Trial directory holds prompt version ${version}; use a new directory`,
    );
    expect(trial.downloads).toEqual([]);
    expect(trial.batches.created).toEqual([]);
  });
});
