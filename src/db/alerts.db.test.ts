import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AlertDecision } from "@/lib/alerts/types";
import type { GameClassification } from "@/lib/classify/schema";
import { ALERT_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import {
  markAlertsSent,
  readBreakouts,
  readCardFacts,
  readGameFormats,
  readLastSentAt,
  readPastAlerts,
  readTrackedGames,
  readUnsentAlerts,
  recordAlerts,
} from "./alerts";
import { insertSubmittingBatch, markBatchSubmitted, storeBatchResults } from "./classifications";
import { upsertGameDetails } from "./games";
import { writeCensusObservations, writeGameObservations, writeVoteObservations } from "./observations";
import { savePlaceResolution } from "./places";
import { alerts, classificationBatches, censusObservations, gameDailyLegacy, gameObservations, games, places, voteObservations } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const at = (value: string) => new Date(value);
const createdSince = at("2026-03-25T00:00:00Z");
const until = at("2026-06-01T00:00:00Z");
// The age limit these fixtures are about (a crossing on day 30 counts, on day 31 not), whatever ALERT_CONFIG is tuned to.
const config = { ...ALERT_CONFIG, maximumAgeDays: 30 } as unknown as typeof ALERT_CONFIG;
const batchId = "00000000-0000-4000-8000-0000000000a1";

describe.skipIf(!hasTestDatabase)("alert queries", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(alerts);
    await database.db.delete(classificationBatches);
    await database.db.delete(gameObservations);
    await database.db.delete(censusObservations);
    await database.db.delete(voteObservations);
    await database.db.delete(gameDailyLegacy);
    await database.db.delete(places);
    await database.db.delete(games);
    // TRUNCATE empties a continuous aggregate and resets its watermark, so no test sees another's buckets.
    await database.db.execute(sql`truncate game_hourly, census_hourly, game_daily`);
  });

  async function game(universeId: number, created: string, name = `Game ${universeId}`): Promise<void> {
    await upsertGameDetails(
      database.db,
      [gameDetail(universeId, { created: at(created), name })],
      new Date(at(created).getTime() + 3_600_000),
    );
  }

  async function reading(universeId: number, observedAt: string, ccu: number): Promise<void> {
    await writeGameObservations(database.db, [{ universeId, observedAt: at(observedAt), ccu, visits: 1_000, favorites: 10 }]);
  }

  // refresh_continuous_aggregate refuses a transaction block: a statement without parameters runs on its own.
  async function refreshAggregates(): Promise<void> {
    for (const view of ["game_hourly", "census_hourly", "game_daily"]) {
      await database.db.execute(sql.raw(`call refresh_continuous_aggregate('${view}', null, null)`));
    }
  }

  async function breakouts(options: { createdSince?: Date; until?: Date } = {}) {
    const rows = await readBreakouts(
      database.db,
      { createdSince: options.createdSince ?? createdSince, until: options.until ?? until },
      config,
    );
    return new Map(rows.map((row) => [row.universeId, row]));
  }

  async function seedCrossings(): Promise<void> {
    // 1: 400 CCU, then 1,200 an hour later.
    await game(1, "2026-04-01T00:00:00Z");
    await reading(1, "2026-04-05T10:10:00Z", 400);
    await reading(1, "2026-04-05T11:10:00Z", 1_200);
    // 2: first read at 5,000.
    await game(2, "2026-04-02T00:00:00Z");
    await reading(2, "2026-04-02T05:10:00Z", 5_000);
    // 3: polled below the threshold, but Rolimon's census read 1,500 on its place.
    await game(3, "2026-04-03T00:00:00Z");
    await reading(3, "2026-04-04T08:10:00Z", 200);
    await savePlaceResolution(database.db, { placeId: 30, universeId: 3, resolvedAt: at("2026-04-03T00:00:00Z"), error: null });
    await writeCensusObservations(database.db, [{ placeId: 30, observedAt: at("2026-04-04T08:20:00Z"), ccu: 1_500 }]);
    // 4: crosses 31 days after its creation.
    await game(4, "2026-04-01T00:00:00Z");
    await reading(4, "2026-05-02T00:10:00Z", 2_000);
    // 5: v1 history only: the first day at or above 1,000.
    await game(5, "2026-04-01T00:00:00Z");
    await database.db.insert(gameDailyLegacy).values(
      [
        ["2026-04-03T00:00:00Z", 500],
        ["2026-04-04T00:00:00Z", 1_200],
        ["2026-04-05T00:00:00Z", 3_000],
      ].map(([day, peak]) => ({ universeId: 5, day: at(day as string), ccuAvg: 100, ccuPeak: peak as number, visits: 1, favorites: 1 })),
    );
    // 6: created before the window.
    await game(6, "2026-03-01T00:00:00Z");
    await reading(6, "2026-03-02T00:10:00Z", 5_000);
    // 7: never reaches the threshold.
    await game(7, "2026-04-01T00:00:00Z");
    await reading(7, "2026-04-02T00:10:00Z", 999);
  }

  function expectCrossings(found: Map<number, { crossedAt: Date; createdAt: Date }>) {
    expect([...found.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    expect(found.get(1)?.crossedAt).toEqual(at("2026-04-05T11:00:00Z"));
    expect(found.get(1)?.createdAt).toEqual(at("2026-04-01T00:00:00Z"));
    expect(found.get(2)?.crossedAt).toEqual(at("2026-04-02T05:00:00Z"));
    expect(found.get(3)?.crossedAt).toEqual(at("2026-04-04T08:00:00Z"));
    expect(found.get(5)?.crossedAt).toEqual(at("2026-04-04T00:00:00Z"));
  }

  it("finds the first hour a young game read the threshold, in polls, census or v1 days", async () => {
    await seedCrossings();
    expectCrossings(await breakouts());
    // Production reads mostly materialized buckets: the rows do not change once the fixtures are.
    await refreshAggregates();
    expectCrossings(await breakouts());
  });

  it("leaves out a crossing at or after `until` and games created before `createdSince`", async () => {
    await seedCrossings();
    const early = await breakouts({ until: at("2026-04-05T11:00:00Z") });
    expect([...early.keys()].sort((a, b) => a - b)).toEqual([2, 3, 5]);
    const late = await breakouts({ createdSince: at("2026-04-02T00:00:00Z") });
    expect([...late.keys()].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("prefers an hourly crossing to a v1 day", async () => {
    await game(8, "2026-04-01T00:00:00Z");
    await reading(8, "2026-04-06T09:10:00Z", 1_100);
    await database.db
      .insert(gameDailyLegacy)
      .values({ universeId: 8, day: at("2026-04-04T00:00:00Z"), ccuAvg: 100, ccuPeak: 4_000, visits: 1, favorites: 1 });
    expect((await breakouts()).get(8)?.crossedAt).toEqual(at("2026-04-06T09:00:00Z"));
  });

  it("counts a crossing on the last allowed day", async () => {
    await game(9, "2026-04-01T00:00:00Z");
    await reading(9, "2026-05-01T00:10:00Z", 1_000);
    expect((await breakouts()).get(9)?.crossedAt).toEqual(at("2026-05-01T00:00:00Z"));
  });

  it("reads every tracked game's id and name", async () => {
    await game(1, "2026-04-01T00:00:00Z", "Alpha");
    await game(2, "2026-02-01T00:00:00Z", "Beta");
    const tracked = await readTrackedGames(database.db);
    expect(tracked.sort((a, b) => a.universeId - b.universeId)).toEqual([
      { universeId: 1, name: "Alpha", robloxCreatedAt: at("2026-04-01T00:00:00Z") },
      { universeId: 2, name: "Beta", robloxCreatedAt: at("2026-02-01T00:00:00Z") },
    ]);
  });

  async function classify(universeId: number, family: string, template: string): Promise<void> {
    await insertSubmittingBatch(
      database.db,
      { id: batchId, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: at("2026-04-01T00:00:00Z") },
      [{ universeId, name: `Game ${universeId}`, hadThumbnail: true }],
    );
    await markBatchSubmitted(database.db, batchId, `msgbatch_${batchId}`);
    const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    await storeBatchResults(
      database.db,
      batchId,
      [
        {
          universeId,
          status: "classified" as const,
          classification: {
            reason: "Test.",
            family,
            template,
            rewardLoop: "progress",
            coreAction: "throw",
            theme: "none",
            setting: "none",
            progression: "levels",
            social: "solo",
            confidence: "high",
          } satisfies GameClassification,
          usage,
        },
      ],
      { at: at("2026-04-02T00:00:00Z"), costUsd: 0, stats: {} },
    );
  }

  it("reads a game's format, and reports an unclassified game with null fields", async () => {
    await game(1, "2026-04-01T00:00:00Z", "Skip Stones");
    await game(2, "2026-04-01T00:00:00Z", "Plain Name");
    await classify(1, "simulator", "clicker");
    const formats = await readGameFormats(database.db, [1, 2, 3]);
    expect(formats.get(1)).toEqual({ name: "Skip Stones", family: "simulator", template: "clicker", coreAction: "throw", classified: true });
    expect(formats.get(2)).toEqual({ name: "Plain Name", family: null, template: null, coreAction: null, classified: false });
    expect(formats.has(3)).toBe(false);
    expect((await readGameFormats(database.db, [])).size).toBe(0);
  });

  it("gathers a card's facts", async () => {
    await game(1, "2026-04-01T00:00:00Z", "Skip Stones");
    await classify(1, "simulator", "clicker");
    await reading(1, "2026-04-05T10:10:00Z", 400);
    await reading(1, "2026-04-05T10:40:00Z", 450);
    await reading(1, "2026-04-06T10:10:00Z", 1_200);
    await database.db.insert(gameDailyLegacy).values({ universeId: 1, day: at("2026-04-02T00:00:00Z"), ccuAvg: 1, ccuPeak: 9_000, visits: 1, favorites: 1 });
    await game(2, "2026-04-05T00:00:00Z");
    await refreshAggregates();
    const crossedAt = new Map([
      [1, at("2026-04-06T10:00:00Z")],
      [2, at("2026-04-06T10:00:00Z")],
    ]);
    const facts = await readCardFacts(database.db, [1, 2], crossedAt);
    expect(facts.get(1)).toMatchObject({
      name: "Skip Stones",
      rootPlaceId: 1_000_001,
      robloxCreatedAt: at("2026-04-01T00:00:00Z"),
      crossedAt: at("2026-04-06T10:00:00Z"),
      ccuDayBefore: 450,
      family: "simulator",
      template: "clicker",
      rewardLoop: "progress",
      coreAction: "throw",
      peakCcu: 9_000,
    });
    // No reading a day before the crossing, no votes, no classification.
    expect(facts.get(2)).toMatchObject({ ccuDayBefore: null, likeRatio: null, family: null, coreAction: null, peakCcu: 0 });
  });

  it("computes a like ratio from the latest votes", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    await writeVoteObservations(database.db, [
      { universeId: 1, observedAt: at("2026-04-06T09:00:00Z"), upVotes: 1, downVotes: 1 },
      { universeId: 1, observedAt: at("2026-04-06T10:00:00Z"), upVotes: 90, downVotes: 10 },
    ]);
    const facts = await readCardFacts(database.db, [1], new Map([[1, at("2026-04-06T10:00:00Z")]]));
    expect(facts.get(1)?.likeRatio).toBeCloseTo(0.9, 6);
  });

  const decision = (kind: AlertDecision["kind"], universeId: number, keys: string[]): AlertDecision => ({
    kind,
    universeId,
    keys,
    priors: Object.fromEntries(keys.map((key) => [key, []])),
  });

  it("records an alert once per kind and game", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    const entry = { decision: decision("first_breakout", 1, ["family:simulator"]), evidence: { crossed: 1 }, createdAt: at("2026-04-06T10:00:00Z") };
    expect(await recordAlerts(database.db, [entry])).toBe(1);
    expect(await recordAlerts(database.db, [entry])).toBe(0);
    expect(await recordAlerts(database.db, [{ ...entry, decision: decision("wave", 1, ["family:simulator"]) }])).toBe(1);
    expect(await database.db.select().from(alerts)).toHaveLength(2);
    expect(await recordAlerts(database.db, [])).toBe(0);
  });

  it("round-trips unsent alerts and marks them sent", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    await game(2, "2026-04-01T00:00:00Z");
    await recordAlerts(database.db, [
      { decision: decision("first_breakout", 1, ["a", "b"]), evidence: { n: 1 }, createdAt: at("2026-04-06T10:00:00Z") },
      { decision: decision("wave", 2, ["a"]), evidence: { n: 2 }, createdAt: at("2026-04-06T11:00:00Z") },
    ]);
    const unsent = await readUnsentAlerts(database.db);
    expect(unsent).toHaveLength(2);
    expect(unsent[0]).toMatchObject({ kind: "first_breakout", universeId: 1, keys: ["a", "b"], evidence: { n: 1 }, createdAt: at("2026-04-06T10:00:00Z"), sentAt: null });
    expect(unsent[1]).toMatchObject({ kind: "wave", universeId: 2 });
    await markAlertsSent(database.db, [unsent[0].id], at("2026-04-07T08:00:00Z"));
    expect((await readUnsentAlerts(database.db)).map((alert) => alert.universeId)).toEqual([2]);
    await markAlertsSent(database.db, [], at("2026-04-07T08:00:00Z"));
  });

  it("marks only unsent alerts, so a second mark keeps the first send time", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    await recordAlerts(database.db, [
      { decision: decision("wave", 1, ["a"]), evidence: {}, createdAt: at("2026-04-06T10:00:00Z") },
    ]);
    const [alert] = await readUnsentAlerts(database.db);
    await markAlertsSent(database.db, [alert.id], at("2026-04-07T08:00:00Z"));
    await markAlertsSent(database.db, [alert.id], at("2026-04-09T08:00:00Z"));
    expect(await readLastSentAt(database.db, "wave")).toEqual(at("2026-04-07T08:00:00Z"));
  });

  it("reads the latest send time of a kind", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    await game(2, "2026-04-01T00:00:00Z");
    expect(await readLastSentAt(database.db, "wave")).toBeNull();
    await recordAlerts(database.db, [
      { decision: decision("wave", 1, ["a"]), evidence: {}, createdAt: at("2026-04-06T10:00:00Z") },
      { decision: decision("wave", 2, ["a"]), evidence: {}, createdAt: at("2026-04-06T10:00:00Z") },
    ]);
    expect(await readLastSentAt(database.db, "wave")).toBeNull();
    const [first, second] = await readUnsentAlerts(database.db);
    await markAlertsSent(database.db, [first.id], at("2026-04-07T08:00:00Z"));
    await markAlertsSent(database.db, [second.id], at("2026-04-08T08:00:00Z"));
    expect(await readLastSentAt(database.db, "wave")).toEqual(at("2026-04-08T08:00:00Z"));
    expect(await readLastSentAt(database.db, "first_breakout")).toBeNull();
  });

  it("reads past alerts since a date, with their kinds, keys and dates", async () => {
    await game(1, "2026-04-01T00:00:00Z");
    await game(2, "2026-04-01T00:00:00Z");
    await recordAlerts(database.db, [
      { decision: decision("first_breakout", 1, ["a"]), evidence: {}, createdAt: at("2026-04-01T10:00:00Z") },
      { decision: decision("wave", 2, ["b", "c"]), evidence: {}, createdAt: at("2026-04-06T10:00:00Z") },
    ]);
    expect(await readPastAlerts(database.db, at("2026-04-02T00:00:00Z"))).toEqual([
      { kind: "wave", universeId: 2, keys: ["b", "c"], createdAt: at("2026-04-06T10:00:00Z") },
    ]);
    expect(await readPastAlerts(database.db, at("2026-04-01T00:00:00Z"))).toHaveLength(2);
  });
});
