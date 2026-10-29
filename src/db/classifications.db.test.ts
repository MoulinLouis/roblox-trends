import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GameClassification } from "@/lib/classify/schema";
import type { ClassificationUsage } from "@/lib/classify/types";
import { gameDetail } from "@/test/fixtures";
import {
  deleteBatch,
  insertSubmittingBatch,
  markBatchSubmitted,
  readClassificationCandidates,
  readOpenBatches,
  requestsSubmittedSince,
  storeBatchResults,
  syncClassificationOverrides,
} from "./classifications";
import { upsertGameDetails } from "./games";
import { classificationBatches, classificationOverrides, classifications } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const classification: GameClassification = {
  reason: "Players steal brainrots.",
  family: "Steal a",
  template: "Steal a {thing}",
  rewardLoop: "brainrots",
  coreAction: "steal brainrots",
  theme: "memes",
  setting: "base",
  progression: "collection",
  social: "theft",
  confidence: "high",
};
const usage: ClassificationUsage = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 };

const batchOne = "00000000-0000-4000-8000-000000000001";
const batchTwo = "00000000-0000-4000-8000-000000000002";
const batchThree = "00000000-0000-4000-8000-000000000003";

function at(day: number): Date {
  return new Date(Date.UTC(2026, 9, day));
}

describe.skipIf(!hasTestDatabase)("classification persistence", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(
      database.db,
      [gameDetail(1, { name: "Steal a Fish" }), gameDetail(2, { name: "Obby", description: "Jump." }), gameDetail(3)],
      at(1),
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    // Batches take their rows with them.
    await database.db.delete(classificationBatches);
    await database.db.delete(classificationOverrides);
  });

  const item = (universeId: number, name: string) => ({ universeId, name, hadThumbnail: true });
  const classified = (universeId: number, overrides: Partial<GameClassification> = {}) => ({
    universeId,
    status: "classified" as const,
    classification: { ...classification, ...overrides },
    usage,
  });
  const collected = (day: number) => ({ at: at(day), costUsd: 0.5, stats: { succeeded: 1 } });

  async function submit(id: string, day: number, items: ReturnType<typeof item>[], promptVersion = 3) {
    await insertSubmittingBatch(database.db, { id, model: "claude-sonnet-5-5", promptVersion, submittedAt: at(day) }, items);
    await markBatchSubmitted(database.db, id, `msgbatch_${id}`);
  }

  it("syncs the overrides and removes the ones no longer given", async () => {
    const first = { universeId: 1, field: "family" as const, value: "steal", reason: "Owner.", decidedAt: "2026-10-29" };
    const second = { universeId: 2, field: "coreAction" as const, value: "jump", reason: "Owner.", decidedAt: "2026-10-29" };
    expect(await syncClassificationOverrides(database.db, [first, second])).toBe(2);
    expect(await database.db.select().from(classificationOverrides)).toHaveLength(2);
    expect(await syncClassificationOverrides(database.db, [second])).toBe(1);
    expect(await database.db.select().from(classificationOverrides)).toEqual([second]);
    expect(await syncClassificationOverrides(database.db, [])).toBe(0);
    expect(await database.db.select().from(classificationOverrides)).toEqual([]);
  });

  it("reads every game with its latest success, pending state and failures since", async () => {
    await submit(batchOne, 2, [item(1, "Steal a Fish"), item(2, "Obby"), item(3, "Game 3")], 2);
    await storeBatchResults(
      database.db,
      batchOne,
      [classified(1), { universeId: 2, status: "failed", error: "refusal", usage: null }, { universeId: 3, status: "released" }],
      collected(3),
    );
    // Game 1 was retitled and classified again; game 2 failed twice; game 3 is pending.
    await submit(batchTwo, 4, [item(1, "Steal a Fish!"), item(2, "Obby"), item(3, "Game 3")], 3);
    await storeBatchResults(
      database.db,
      batchTwo,
      [classified(1), { universeId: 2, status: "failed", error: "max_tokens", usage }, { universeId: 3, status: "released" }],
      collected(5),
    );
    await submit(batchThree, 6, [item(3, "Game 3")]);

    const candidates = new Map((await readClassificationCandidates(database.db)).map((candidate) => [candidate.universeId, candidate]));
    expect(candidates.size).toBe(3);
    expect(candidates.get(1)).toMatchObject({
      name: "Steal a Fish",
      lastCcu: 100,
      pending: false,
      classified: { name: "Steal a Fish!", promptVersion: 3 },
      failures: [],
    });
    expect(candidates.get(2)).toMatchObject({
      description: "Jump.",
      pending: false,
      classified: null,
      failures: [
        { name: "Obby", finishedAt: at(3) },
        { name: "Obby", finishedAt: at(5) },
      ],
    });
    expect(candidates.get(3)).toMatchObject({ pending: true, classified: null, failures: [] });
  });

  it("keeps only the failures after the latest success, oldest first", async () => {
    await submit(batchOne, 2, [item(1, "A")]);
    await storeBatchResults(database.db, batchOne, [{ universeId: 1, status: "failed", error: "old", usage: null }], collected(3));
    await submit(batchTwo, 4, [item(1, "B")]);
    await storeBatchResults(database.db, batchTwo, [classified(1)], collected(5));
    await submit(batchThree, 6, [item(1, "C")]);
    await storeBatchResults(database.db, batchThree, [{ universeId: 1, status: "failed", error: "new", usage: null }], collected(7));

    const candidate = (await readClassificationCandidates(database.db)).find((row) => row.universeId === 1);
    expect(candidate?.classified).toEqual({ name: "B", promptVersion: 3 });
    expect(candidate?.failures).toEqual([{ name: "C", finishedAt: at(7) }]);
  });

  it("writes a batch without an id and one pending row per game, then sets the id", async () => {
    await insertSubmittingBatch(
      database.db,
      { id: batchOne, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at(2) },
      [item(1, "Steal a Fish"), item(2, "Obby")],
    );
    expect(await readOpenBatches(database.db)).toEqual([
      { id: batchOne, anthropicId: null, model: "claude-sonnet-5-5", requests: 2, submittedAt: at(2) },
    ]);
    const rows = await database.db.select().from(classifications);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "pending" && row.finishedAt === null)).toBe(true);

    await markBatchSubmitted(database.db, batchOne, "msgbatch_1");
    expect((await readOpenBatches(database.db))[0]?.anthropicId).toBe("msgbatch_1");
  });

  it("writes nothing when a row of the batch is invalid", async () => {
    await expect(
      insertSubmittingBatch(database.db, { id: batchOne, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at(2) }, [
        item(1, "Steal a Fish"),
        item(999, "Unknown game"),
      ]),
    ).rejects.toThrow();
    expect(await database.db.select().from(classificationBatches)).toEqual([]);
  });

  it("deletes a batch with its rows", async () => {
    await submit(batchOne, 2, [item(1, "Steal a Fish")]);
    await storeBatchResults(database.db, batchOne, [classified(1)], collected(3));
    await submit(batchTwo, 4, [item(2, "Obby")]);
    await deleteBatch(database.db, batchOne);
    expect((await readOpenBatches(database.db)).map((batch) => batch.id)).toEqual([batchTwo]);
    expect((await database.db.select().from(classifications)).map((row) => row.universeId)).toEqual([2]);
  });

  it("lists the batch not collected, even one without an Anthropic id", async () => {
    await submit(batchOne, 2, [item(1, "Steal a Fish")]);
    await storeBatchResults(database.db, batchOne, [classified(1)], collected(3));
    expect(await readOpenBatches(database.db)).toEqual([]);
    await insertSubmittingBatch(database.db, { id: batchTwo, model: "claude-opus-5-5", promptVersion: 3, submittedAt: at(5) }, [item(3, "Game 3")]);
    const open = await readOpenBatches(database.db);
    expect(open.map((batch) => [batch.id, batch.anthropicId === null])).toEqual([[batchTwo, true]]);
  });

  it("refuses a second batch while one is open, and allows it once the first is collected", async () => {
    await insertSubmittingBatch(database.db, { id: batchOne, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at(2) }, [item(1, "Steal a Fish")]);
    await expect(
      insertSubmittingBatch(database.db, { id: batchTwo, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at(3) }, [item(2, "Obby")]),
    ).rejects.toThrow();
    // The refused batch left nothing behind, and the open one is untouched.
    expect((await database.db.select().from(classificationBatches)).map((row) => row.id)).toEqual([batchOne]);
    expect((await database.db.select().from(classifications)).map((row) => row.universeId)).toEqual([1]);

    await markBatchSubmitted(database.db, batchOne, "msgbatch_1");
    await storeBatchResults(database.db, batchOne, [classified(1)], collected(4));
    await insertSubmittingBatch(database.db, { id: batchTwo, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at(5) }, [item(2, "Obby")]);
    expect((await readOpenBatches(database.db)).map((batch) => batch.id)).toEqual([batchTwo]);
  });

  it("stores results, releases the rest and marks the batch collected", async () => {
    await submit(batchOne, 2, [item(1, "Steal a Fish"), item(2, "Obby"), item(3, "Game 3")]);
    await storeBatchResults(
      database.db,
      batchOne,
      [classified(1), { universeId: 2, status: "failed", error: "refusal", usage }, { universeId: 3, status: "released" }],
      { at: at(3), costUsd: 1.25, stats: { succeeded: 1, failed: 1, expired: 1 } },
    );
    const rows = new Map((await database.db.select().from(classifications)).map((row) => [row.universeId, row]));
    expect([...rows.keys()].sort()).toEqual([1, 2]);
    expect(rows.get(1)).toMatchObject({
      status: "classified",
      error: null,
      family: "Steal a",
      template: "Steal a {thing}",
      rewardLoop: "brainrots",
      coreAction: "steal brainrots",
      theme: "memes",
      setting: "base",
      progression: "collection",
      social: "theft",
      confidence: "high",
      reason: "Players steal brainrots.",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      finishedAt: at(3),
    });
    expect(rows.get(2)).toMatchObject({ status: "failed", error: "refusal", family: null, reason: null, inputTokens: 100, finishedAt: at(3) });
    const [batch] = await database.db.select().from(classificationBatches);
    expect(batch).toMatchObject({ collectedAt: at(3), costUsd: 1.25, stats: { succeeded: 1, failed: 1, expired: 1 } });
    expect(await readOpenBatches(database.db)).toEqual([]);
  });

  it("releases the rows left without a result", async () => {
    await submit(batchOne, 2, [item(1, "Steal a Fish"), item(2, "Obby")]);
    await storeBatchResults(database.db, batchOne, [classified(1)], collected(3));
    expect((await database.db.select().from(classifications)).map((row) => row.universeId)).toEqual([1]);
  });

  it("sums the requests submitted after a time", async () => {
    expect(await requestsSubmittedSince(database.db, at(1))).toBe(0);
    // One open batch at a time: each is collected, with no result, before the next.
    await submit(batchOne, 2, [item(1, "Steal a Fish")]);
    await storeBatchResults(database.db, batchOne, [], collected(3));
    await submit(batchTwo, 4, [item(1, "Steal a Fish"), item(2, "Obby")]);
    await storeBatchResults(database.db, batchTwo, [], collected(5));
    await submit(batchThree, 6, [item(1, "Steal a Fish"), item(2, "Obby"), item(3, "Game 3")]);
    expect(await requestsSubmittedSince(database.db, at(3))).toBe(5);
    expect(await requestsSubmittedSince(database.db, at(4))).toBe(3);
    expect(await requestsSubmittedSince(database.db, at(1))).toBe(6);
  });

  describe("game_classifications", () => {
    const view = async () => {
      const result = await database.db.execute<{
        universe_id: string;
        family: string | null;
        template: string | null;
        core_action: string | null;
        theme: string | null;
        model: string | null;
        prompt_version: number | null;
        overridden: boolean;
      }>(
        // Plain SQL: the view is not part of the schema module.
        sql`select universe_id, family, template, core_action, theme, model, prompt_version, overridden from game_classifications order by universe_id`,
      );
      return result.rows.map((row) => ({ ...row, universe_id: Number(row.universe_id) }));
    };

    it("returns the latest classified row with its model and prompt version", async () => {
      await submit(batchOne, 2, [item(1, "Steal a Fish")], 2);
      await storeBatchResults(database.db, batchOne, [classified(1, { family: "old" })], collected(3));
      await submit(batchTwo, 4, [item(1, "Steal a Fish"), item(2, "Obby")], 3);
      await storeBatchResults(
        database.db,
        batchTwo,
        [classified(1, { family: "new" }), { universeId: 2, status: "failed", error: "refusal", usage: null }],
        collected(5),
      );
      expect(await view()).toEqual([
        { universe_id: 1, family: "new", template: "Steal a {thing}", core_action: "steal brainrots", theme: "memes", model: "claude-sonnet-5-5", prompt_version: 3, overridden: false },
      ]);
    });

    it("replaces only the overridden field and flags the row", async () => {
      await submit(batchOne, 2, [item(1, "Steal a Fish")]);
      await storeBatchResults(database.db, batchOne, [classified(1)], collected(3));
      await syncClassificationOverrides(database.db, [
        { universeId: 1, field: "coreAction", value: "steal fish", reason: "Owner.", decidedAt: "2026-10-29" },
      ]);
      expect(await view()).toMatchObject([{ universe_id: 1, family: "Steal a", core_action: "steal fish", overridden: true }]);
    });

    it("keeps a row for a game with an override and no classification", async () => {
      await syncClassificationOverrides(database.db, [
        { universeId: 3, field: "family", value: "obby", reason: "Owner.", decidedAt: "2026-10-29" },
      ]);
      expect(await view()).toEqual([
        { universe_id: 3, family: "obby", template: null, core_action: null, theme: null, model: null, prompt_version: null, overridden: true },
      ]);
    });
  });
});
