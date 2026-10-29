import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertGameDetails } from "@/db/games";
import { classificationBatches, classificationOverrides, classifications, games, jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import type { BatchApi } from "@/lib/classify/batches";
import type { ClassificationOverride } from "@/lib/classify/overrides";
import { CLASSIFICATION_PROMPT_VERSION } from "@/lib/classify/prompt";
import { JOB_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { createClassifyJob } from "./classify";
import { executeJob } from "./runner";

const config = JOB_CONFIG.classify;
const hourMs = 60 * 60 * 1000;
const start = new Date("2026-10-30T10:00:00Z");

const answer = {
  reason: "The title starts with +1.",
  family: "+1",
  template: "+1 {thing}",
  rewardLoop: "stats",
  coreAction: "skip stones",
  theme: "stone skipping",
  setting: "lake",
  progression: "stat growth",
  social: "solo",
  confidence: "high",
};

function message(values: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: config.model,
    content: [{ type: "text", text: JSON.stringify(answer), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1_200, output_tokens: 300, cache_creation_input_tokens: null, cache_read_input_tokens: 2_400 },
    ...values,
  } as Anthropic.Message;
}

function succeeded(universeId: number, values: Partial<Anthropic.Message> = {}): Anthropic.Messages.MessageBatchIndividualResponse {
  return { custom_id: `u${universeId}`, result: { type: "succeeded", message: message(values) } };
}

function ended(universeId: number, type: "expired" | "canceled"): Anthropic.Messages.MessageBatchIndividualResponse {
  return { custom_id: `u${universeId}`, result: { type } } as Anthropic.Messages.MessageBatchIndividualResponse;
}

type CreateParams = Parameters<BatchApi["create"]>[0];

class FakeBatches implements BatchApi {
  created: CreateParams[] = [];
  createError: unknown = null;
  private batches = new Map<string, { ended: boolean; responses: Anthropic.Messages.MessageBatchIndividualResponse[] }>();

  async create(params: CreateParams) {
    this.created.push(params);
    if (this.createError) throw this.createError;
    const id = `msgbatch_${this.created.length}`;
    this.batches.set(id, { ended: false, responses: [] });
    return { id };
  }

  async retrieve(id: string) {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`Unknown batch ${id}`);
    return {
      processing_status: batch.ended ? ("ended" as const) : ("in_progress" as const),
      request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    };
  }

  async results(id: string) {
    const responses = this.batches.get(id)?.responses ?? [];
    return (async function* () {
      yield* responses;
    })();
  }

  end(id: string, responses: Anthropic.Messages.MessageBatchIndividualResponse[]) {
    this.batches.set(id, { ended: true, responses });
  }
}

describe.skipIf(!hasTestDatabase)("classify job", () => {
  let database: TestDatabase;
  let api: FakeBatches;
  let overrides: ClassificationOverride[];

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    api = new FakeBatches();
    overrides = [];
    // Deleting the games cascades to their classifications.
    await database.db.delete(games);
    await database.db.delete(classificationBatches);
    await database.db.delete(classificationOverrides);
    await database.db.delete(jobRuns);
  });

  // Thumbnails exist for every game but 3.
  function job() {
    return createClassifyJob({
      batches: () => api,
      downloadThumbnail: async (url) => (url === null || url.endsWith("/3") ? null : Buffer.from("jpeg")),
      overrides,
    });
  }

  async function addGames(ids: number[], at = start, playing: (id: number) => number = (id) => id * 10) {
    await upsertGameDetails(database.db, ids.map((id) => gameDetail(id, { playing: playing(id) })), at);
    for (const id of ids) {
      await database.db.execute(
        // The thumbnail URL comes from the thumbnails job, not from game details.
        sql`update games set thumbnail_url = ${`https://tr.rbxcdn.com/thumbnail/${id}`} where universe_id = ${id}`,
      );
    }
  }

  async function run(at: Date) {
    const status = await executeJob(job(), database.db, at);
    const [row] = (await database.db.select().from(jobRuns).orderBy(jobRuns.startedAt)).slice(-1);
    return { status, stats: row.stats as Record<string, unknown>, row };
  }

  async function batch() {
    const [row] = await database.db.select().from(classificationBatches).orderBy(classificationBatches.submittedAt);
    return row;
  }

  async function rows(batchId?: string) {
    const all = await database.db.select().from(classifications);
    return all.filter((row) => batchId === undefined || row.batchId === batchId).sort((a, b) => a.universeId - b.universeId);
  }

  async function submitAndEnd(responses: Anthropic.Messages.MessageBatchIndividualResponse[], at = start) {
    await run(at);
    api.end(`msgbatch_${api.created.length}`, responses);
  }

  it("submits the never-classified games, busiest first, with Sonnet, custom ids and thumbnails", async () => {
    await addGames([1, 2, 3]);
    const { status, stats } = await run(start);
    expect(status).toBe("success");
    expect(api.created).toHaveLength(1);
    const requests = api.created[0].requests;
    expect(requests.map((request) => request.custom_id)).toEqual(["u3", "u2", "u1"]);
    expect(requests.every((request) => request.params.model === "claude-sonnet-5-5")).toBe(true);
    const hasImage = (index: number) =>
      Array.isArray(requests[index].params.messages[0].content) &&
      requests[index].params.messages[0].content.some((block) => block.type === "image");
    expect([hasImage(0), hasImage(1), hasImage(2)]).toEqual([false, true, true]);
    const stored = await batch();
    expect(stored).toMatchObject({
      anthropicId: "msgbatch_1",
      model: "claude-sonnet-5-5",
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      requests: 3,
      submittedAt: start,
      collectedAt: null,
    });
    expect(await rows()).toMatchObject([
      { universeId: 1, status: "pending", hadThumbnail: true },
      { universeId: 2, status: "pending", hadThumbnail: true },
      { universeId: 3, status: "pending", hadThumbnail: false },
    ]);
    expect(stats).toMatchObject({ submitted: 3, withoutThumbnail: 1, waitingBatches: 0, blockedBatch: null });
  });

  it("copies the given overrides into classification_overrides", async () => {
    overrides = [
      { universeId: 1, field: "family", value: "shooter", reason: "Owner review.", decidedAt: "2026-10-29" },
      { universeId: 2, field: "template", value: "Steal a {thing}", reason: "Owner review.", decidedAt: "2026-10-29" },
    ];
    const { stats } = await run(start);
    expect(stats.overrides).toBe(2);
    expect(await database.db.select().from(classificationOverrides)).toHaveLength(2);
  });

  it("submits nothing while a batch is processing", async () => {
    await addGames([1, 2]);
    await run(start);
    const { status, stats } = await run(new Date(start.getTime() + hourMs));
    expect(status).toBe("success");
    expect(api.created).toHaveLength(1);
    expect(stats).toMatchObject({ waitingBatches: 1, submitted: 0, collected: 0 });
  });

  it("stores the classifications and the cost of an ended batch, then submits the next games", async () => {
    await addGames([1, 2]);
    await submitAndEnd([succeeded(1), succeeded(2)]);
    await addGames([3], new Date(start.getTime() + hourMs));
    const { status, stats } = await run(new Date(start.getTime() + hourMs));
    expect(status).toBe("success");
    expect(stats).toMatchObject({ collected: 1, classified: 2, failed: 0, released: 0, cacheReads: 2, submitted: 1, waitingBatches: 0 });
    expect(stats.costUsd as number).toBeGreaterThan(0);
    const [first] = await database.db.select().from(classificationBatches).where(eq(classificationBatches.anthropicId, "msgbatch_1"));
    expect(first.collectedAt).toEqual(new Date(start.getTime() + hourMs));
    expect(first.costUsd).toBeCloseTo(stats.costUsd as number, 6);
    const stored = await rows(first.id);
    expect(stored).toMatchObject([
      { universeId: 1, status: "classified", family: "+1", coreAction: "skip stones", inputTokens: 1_200, cacheReadTokens: 2_400 },
      { universeId: 2, status: "classified" },
    ]);
    expect(api.created[1].requests.map((request) => request.custom_id)).toEqual(["u3"]);
  });

  it("stores a refused answer as a failed row, and degrades the run above the failed share", async () => {
    await addGames([1, 2]);
    await submitAndEnd([succeeded(1, { stop_reason: "refusal", content: [] }), succeeded(2, { stop_reason: "refusal", content: [] })]);
    const { status, stats } = await run(new Date(start.getTime() + hourMs));
    expect(status).toBe("degraded");
    expect(stats).toMatchObject({ classified: 0, failed: 2 });
    expect((stats.failed as number) / 2).toBeGreaterThan(config.maximumFailedShare);
    const stored = await rows();
    expect(stored.filter((row) => row.status === "failed")).toHaveLength(2);
    expect(stored[0].error).toContain("refused");
    expect(stored[0].inputTokens).toBe(1_200);
  });

  it("releases expired, canceled and unanswered games, which are submitted again in the same run", async () => {
    await addGames([1, 2, 3, 4]);
    await submitAndEnd([succeeded(1), ended(2, "expired"), ended(3, "canceled")]);
    const { stats } = await run(new Date(start.getTime() + hourMs));
    expect(stats).toMatchObject({ classified: 1, failed: 0, released: 3, submitted: 3 });
    expect(api.created[1].requests.map((request) => request.custom_id).sort()).toEqual(["u2", "u3", "u4"]);
    expect((await rows()).filter((row) => row.status === "classified").map((row) => row.universeId)).toEqual([1]);
  });

  it("classifies a retitled game again but not a bracket-only title change", async () => {
    await addGames([1, 2]);
    await submitAndEnd([succeeded(1), succeeded(2)]);
    const later = new Date(start.getTime() + hourMs);
    await upsertGameDetails(
      database.db,
      [gameDetail(1, { name: "Brand New Title", playing: 10 }), gameDetail(2, { name: "[UPDATE] Game 2", playing: 20 })],
      later,
    );
    await run(later);
    expect(api.created[1].requests.map((request) => request.custom_id)).toEqual(["u1"]);
  });

  it("caps the next batch at the daily request limit minus the last 24 hours of submissions", async () => {
    await addGames([1, 2, 3, 4, 5]);
    await database.db.insert(classificationBatches).values({
      id: randomUUID(),
      anthropicId: "msgbatch_old",
      model: "claude-sonnet-5-5",
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      requests: config.maximumRequestsPerDay - 2,
      submittedAt: new Date(start.getTime() - 23 * hourMs),
      collectedAt: new Date(start.getTime() - 22 * hourMs),
      costUsd: 1,
    });
    await run(start);
    expect(api.created[0].requests.map((request) => request.custom_id)).toEqual(["u5", "u4"]);
  });

  it("does not count submissions older than 24 hours", async () => {
    await addGames([1, 2]);
    await database.db.insert(classificationBatches).values({
      id: randomUUID(),
      anthropicId: "msgbatch_old",
      model: "claude-sonnet-5-5",
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      requests: config.maximumRequestsPerDay,
      submittedAt: new Date(start.getTime() - 25 * hourMs),
      collectedAt: new Date(start.getTime() - 24 * hourMs),
      costUsd: 1,
    });
    await run(start);
    expect(api.created[0].requests).toHaveLength(2);
  });

  it("deletes the batch and its rows and fails the run when the API refuses the request", async () => {
    await addGames([1, 2]);
    api.createError = Object.assign(new Error("Bad request"), { status: 400 });
    const { status } = await run(start);
    expect(status).toBe("failed");
    expect(await database.db.select().from(classificationBatches)).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("keeps the batch row without an id when the answer is lost, and blocks the next runs", async () => {
    await addGames([1, 2]);
    api.createError = new Error("socket hang up");
    expect((await run(start)).status).toBe("failed");
    const stored = await batch();
    expect(stored).toMatchObject({ anthropicId: null, requests: 2 });
    expect(await rows()).toHaveLength(2);

    api.createError = null;
    const later = new Date(start.getTime() + hourMs);
    const { status, stats } = await run(later);
    expect(status).toBe("degraded");
    expect(api.created).toHaveLength(1);
    expect(stats).toMatchObject({ submitted: 0, blockedBatch: { id: stored.id, submittedAt: start.toISOString() } });
  });
});
