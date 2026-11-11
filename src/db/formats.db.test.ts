import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GameClassification } from "@/lib/classify/schema";
import { FORMAT_CONFIG } from "@/lib/config";
import { gameDetail } from "@/test/fixtures";
import { createDatabase } from "./client";
import { insertSubmittingBatch, markBatchSubmitted, storeBatchResults } from "./classifications";
import { type FormatStat, type FormatStatsConfig, formatStats, type FormatWeek, formatWeeks } from "./formats";
import { upsertGameDetails } from "./games";
import { classificationBatches, gameDailyLegacy, games } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

const dayMs = 24 * 60 * 60 * 1000;
// Mondays of March 2026. Weeks start on them: the latest complete week for this as_of starts on 2026-03-23.
const config = { ...FORMAT_CONFIG, weeks: 4, fullCoverageFrom: "2026-03-16" };
const asOf = new Date("2026-03-30T00:00:00Z");
const batchId = "00000000-0000-4000-8000-0000000000f1";

interface Spec {
  id: number;
  family?: string;
  template?: string;
  rewardLoop?: string;
  created?: string;
}

function iso(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

describe.skipIf(!hasTestDatabase)("format queries", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    // A batch takes its classifications with it.
    await database.db.delete(classificationBatches);
    await database.db.delete(gameDailyLegacy);
    await database.db.delete(games);
  });

  // Games created long before the weeks under test unless `created` says otherwise, classified in one collected batch.
  async function seed(specs: Spec[]): Promise<void> {
    await upsertGameDetails(
      database.db,
      specs.map((spec) => gameDetail(spec.id, { created: new Date(spec.created ?? "2026-01-01T00:00:00Z") })),
      new Date("2026-03-01T00:00:00Z"),
    );
    await insertSubmittingBatch(
      database.db,
      { id: batchId, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: new Date("2026-03-01T00:00:00Z") },
      specs.map((spec) => ({ universeId: spec.id, name: `Game ${spec.id}`, hadThumbnail: true })),
    );
    await markBatchSubmitted(database.db, batchId, `msgbatch_${batchId}`);
    const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    await storeBatchResults(
      database.db,
      batchId,
      specs.map((spec) => ({
        universeId: spec.id,
        status: "classified" as const,
        classification: {
          reason: "Test.",
          family: spec.family ?? "obby",
          template: spec.template ?? "none",
          rewardLoop: spec.rewardLoop ?? "progress",
          coreAction: "jump",
          theme: "none",
          setting: "none",
          progression: "levels",
          social: "solo",
          confidence: "high",
        } satisfies GameClassification,
        usage,
      })),
      { at: new Date("2026-03-02T00:00:00Z"), costUsd: 0, stats: {} },
    );
  }

  // One reading per day from `from` for `days` days.
  async function readings(universeId: number, from: string, days: number, ccu: number, peak = ccu): Promise<void> {
    const rows = Array.from({ length: days }, (_, index) => ({
      universeId,
      day: new Date(iso(from) + index * dayMs),
      ccuAvg: ccu,
      ccuPeak: peak,
      visits: 1_000,
      favorites: 10,
    }));
    await database.db.insert(gameDailyLegacy).values(rows);
  }

  const rows = (weeks: FormatWeek[], dimension: string, format: string) =>
    weeks.filter((week) => week.dimension === dimension && week.format === format);

  it("shares a week's average CCU between the format and the market", async () => {
    await seed([{ id: 1 }, { id: 2 }, { id: 3, family: "tycoon" }]);
    await readings(1, "2026-03-23", 7, 300);
    await readings(2, "2026-03-23", 7, 100);
    await readings(3, "2026-03-23", 7, 600);
    const weeks = await formatWeeks(database.db, { asOf, dimension: "family" }, config);
    const obby = rows(weeks, "family", "obby");
    expect(obby).toHaveLength(1);
    expect(obby[0]).toMatchObject({
      weekStart: new Date("2026-03-23T00:00:00Z"),
      games: 2,
      ccuAverage: 400,
      marketGames: 3,
      marketCcu: 1_000,
    });
    expect(obby[0]?.share).toBeCloseTo(0.4, 10);
  });

  it("divides by the days the market has readings for", async () => {
    await seed([{ id: 1 }, { id: 3, family: "tycoon" }]);
    await readings(1, "2026-03-23", 4, 300);
    await readings(3, "2026-03-23", 4, 600);
    const [obby] = rows(await formatWeeks(database.db, { asOf, dimension: "family" }, config), "family", "obby");
    expect(obby).toMatchObject({ ccuAverage: 300, marketCcu: 900 });
  });

  it("ends the last week on as_of and ignores the session time zone", async () => {
    await seed([{ id: 1 }]);
    await readings(1, "2026-03-16", 14, 300);
    // A reading on the Monday the last week ends: it belongs to no returned week.
    await readings(1, "2026-03-30", 1, 9_999);
    const query = { asOf, dimension: "family" as const };
    const expected = await formatWeeks(database.db, query, config);
    expect(expected.map((week) => week.weekStart.toISOString())).toEqual([
      "2026-03-16T00:00:00.000Z",
      "2026-03-23T00:00:00.000Z",
    ]);
    expect(expected.map((week) => week.ccuAverage)).toEqual([300, 300]);

    // One connection, so the session setting applies to the call.
    const { db, pool } = createDatabase(database.url, {
      maxConnections: 1,
      applicationName: "radar-test-zone",
      settings: { timezone: "Pacific/Auckland" },
    });
    try {
      const zone = await db.execute<{ TimeZone: string }>(sql`show time zone`);
      expect(zone.rows[0]?.TimeZone).toBe("Pacific/Auckland");
      expect(await formatWeeks(db, query, config)).toEqual(expected);
      // Just before the Monday, the week before it is the last one.
      const before = await formatWeeks(db, { ...query, asOf: new Date("2026-03-29T23:59:59Z") }, config);
      expect(before.at(-1)?.weekStart).toEqual(new Date("2026-03-16T00:00:00Z"));
    } finally {
      await pool.end();
    }
  });

  it("names the leader, its share and its CCU the week before", async () => {
    await seed([{ id: 1 }, { id: 2 }]);
    // The week before the first returned one (Feb 23) gives that week's leader a previous CCU.
    await readings(1, "2026-02-23", 7, 50);
    await readings(1, "2026-03-02", 7, 100);
    await readings(2, "2026-03-02", 7, 20);
    await readings(1, "2026-03-16", 7, 200);
    await readings(2, "2026-03-16", 7, 100);
    await readings(1, "2026-03-23", 7, 300);
    await readings(2, "2026-03-23", 7, 100);
    const obby = rows(await formatWeeks(database.db, { asOf, dimension: "family" }, config), "family", "obby");
    // No readings in the week of Mar 9: no row.
    expect(obby.map((week) => week.weekStart.toISOString().slice(0, 10))).toEqual(["2026-03-02", "2026-03-16", "2026-03-23"]);
    expect(obby[0]).toMatchObject({ leaderUniverseId: 1, leaderName: "Game 1", leaderCcu: 100, leaderPreviousCcu: 50 });
    expect(obby[0]?.leaderShare).toBeCloseTo(100 / 120, 10);
    expect(obby[1]).toMatchObject({ leaderUniverseId: 1, leaderCcu: 200, leaderPreviousCcu: null });
    expect(obby[1]?.leaderShare).toBeCloseTo(200 / 300, 10);
    expect(obby[2]).toMatchObject({ leaderUniverseId: 1, leaderCcu: 300, leaderPreviousCcu: 200 });
    expect(obby[2]?.leaderShare).toBeCloseTo(0.75, 10);
  });

  it("counts entrants, matured ones and hits within the hit days, and keeps weeks without readings", async () => {
    await seed([
      { id: 1 },
      // Created on Wednesday 2026-03-18, in the week of Mar 16.
      { id: 5, family: "race", created: "2026-03-18T10:00:00Z" },
      // Created 5 days before as_of: not matured, so its 20,000 peak counts for nothing.
      { id: 6, family: "race", created: "2026-04-01T10:00:00Z" },
      // Created in the week of Mar 9, never read.
      { id: 7, family: "ghost", created: "2026-03-10T10:00:00Z" },
    ]);
    const lateAsOf = new Date("2026-04-06T00:00:00Z");
    await readings(1, "2026-03-09", 28, 300);
    await readings(5, "2026-03-20", 1, 800, 1_500);
    // The 15th day from the creation day: outside the 14 days.
    await readings(5, "2026-04-01", 1, 800, 12_000);
    await readings(6, "2026-04-02", 1, 5_000, 20_000);
    const weeks = await formatWeeks(database.db, { asOf: lateAsOf, dimension: "family" }, config);
    const week = (format: string, start: string) => rows(weeks, "family", format).find((row) => row.weekStart.toISOString().startsWith(start));
    expect(week("race", "2026-03-16")).toMatchObject({ entrants: 1, entrantsMatured: 1, hitsSmall: 1, hitsLarge: 0 });
    expect(week("race", "2026-03-30")).toMatchObject({ entrants: 1, entrantsMatured: 0, hitsSmall: 0, hitsLarge: 0 });
    expect(week("ghost", "2026-03-09")).toMatchObject({
      games: 0,
      ccuAverage: 0,
      share: 0,
      leaderUniverseId: null,
      leaderPreviousCcu: null,
      entrants: 1,
      entrantsMatured: 1,
      hitsSmall: 0,
    });
    expect(rows(weeks, "family", "ghost")).toHaveLength(1);
  });

  it("groups templates by spelling, leaves out none and joins family and reward loop", async () => {
    await seed([
      { id: 11, template: "Build To Survive {thing}" },
      { id: 12, template: "Build To Survive {thing}" },
      { id: 13, template: "Build to  Survive {thing}" },
      { id: 14, template: "none" },
    ]);
    for (const id of [11, 12, 13, 14]) await readings(id, "2026-03-23", 7, 100);
    const weeks = await formatWeeks(database.db, { asOf }, config);
    const templates = weeks.filter((week) => week.dimension === "template");
    expect(templates.map((week) => week.format)).toEqual(["Build To Survive {thing}"]);
    expect(templates[0]).toMatchObject({ games: 3, ccuAverage: 300 });
    expect(weeks.filter((week) => week.dimension === "family_reward_loop").map((week) => week.format)).toEqual(["obby × progress"]);
    expect(weeks.filter((week) => week.dimension === "reward_loop").map((week) => week.format)).toEqual(["progress"]);
  });

  it("marks the weeks before the full coverage date as top", async () => {
    await seed([{ id: 1 }]);
    await readings(1, "2026-03-09", 14, 300);
    const weeks = await formatWeeks(database.db, { asOf, dimension: "family" }, config);
    expect(weeks.map((week) => [week.weekStart.toISOString().slice(0, 10), week.coverage])).toEqual([
      ["2026-03-09", "top"],
      ["2026-03-16", "full"],
    ]);
  });

  it("filters by dimension and by format, ignoring case", async () => {
    await seed([{ id: 1 }, { id: 3, family: "tycoon" }]);
    await readings(1, "2026-03-23", 7, 300);
    await readings(3, "2026-03-23", 7, 600);
    const weeks = await formatWeeks(database.db, { asOf, dimension: "family", format: "OBBY" }, config);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ dimension: "family", format: "obby" });
  });
  describe("format_stats", () => {
    // The four weeks are Mar 2, 9, 16 and 23 (W-3 to W). All full coverage unless a test moves the date.
    const statsConfig: FormatStatsConfig = { ...FORMAT_CONFIG, trendWeeks: 4, fullCoverageFrom: "2026-03-02" };
    const marketCcu = 20_000;
    const weekStarts = ["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23"];
    const alpha = [1, 2, 3, 4, 5];

    // Per-week CCU of one game over the four weeks; a zero leaves the week without readings. The peak stays under
    // the wave threshold unless a test says otherwise.
    async function place(id: number, ccus: number[]): Promise<void> {
      for (const [index, ccu] of ccus.entries()) {
        if (ccu > 0) await readings(id, weekStarts[index] as string, 7, ccu, 5_000);
      }
    }

    // The format's games share these shares of a market of 20,000 CCU; game 900 is the rest of the market.
    async function shares(ids: number[], weekly: number[]): Promise<void> {
      for (const id of ids) await place(id, weekly.map((share) => (marketCcu * share) / ids.length));
      await place(900, weekly.map((share) => marketCcu * (1 - share)));
    }

    const seedAlpha = (extra: Spec[] = []) =>
      seed([...alpha.map((id) => ({ id, family: "alpha" })), { id: 900, family: "market" }, ...extra]);

    async function alphaStat(config = statsConfig): Promise<FormatStat> {
      const stats = await formatStats(database.db, { asOf }, config);
      const stat = stats.find((row) => row.dimension === "family" && row.format === "alpha");
      expect(stat).toBeDefined();
      return stat as FormatStat;
    }

    it("labels a format rising when its share trend reaches the ratio (step 4)", async () => {
      await seedAlpha();
      await shares(alpha, [0.1, 0.1, 0.15, 0.15]);
      const stat = await alphaStat();
      expect(stat.shareTrend).toBeCloseTo(1.5, 10);
      expect(stat).toMatchObject({ phase: "rising", games: 5, coverage: "full" });
      expect(stat.phaseRule).toContain("1.50");
      expect(stat.phaseRule).toContain("1.25");
    });

    it("labels a format declining when its share trend falls to the ratio (step 4)", async () => {
      await seedAlpha();
      await shares(alpha, [0.2, 0.2, 0.15, 0.15]);
      const stat = await alphaStat();
      expect(stat.shareTrend).toBeCloseTo(0.75, 10);
      expect(stat.phase).toBe("declining");
      expect(stat.phaseRule).toContain("0.75");
      expect(stat.phaseRule).toContain("0.80");
    });

    it("labels a format plateau between the ratios (step 6)", async () => {
      await seedAlpha();
      await shares(alpha, [0.2, 0.2, 0.19, 0.21]);
      const stat = await alphaStat();
      expect(stat.shareTrend).toBeCloseTo(1, 10);
      expect(stat.phase).toBe("plateau");
    });

    it("labels a format declining when a falling leader carries it (step 5)", async () => {
      await seedAlpha();
      // Flat shares of 0.2. Game 1 holds 70% of the format in week W and its CCU falls to 0.7 of the first half.
      await place(1, [4_000, 4_000, 2_800, 2_800]);
      for (const id of [2, 3, 4, 5]) await place(id, [0, 0, 300, 300]);
      await place(900, [16_000, 16_000, 16_000, 16_000]);
      const stat = await alphaStat();
      expect(stat.shareTrend).toBeCloseTo(1, 10);
      expect(stat.leaderShare).toBeCloseTo(0.7, 10);
      expect(stat.leaderTrend).toBeCloseTo(0.7, 10);
      expect(stat).toMatchObject({ phase: "declining", leaderUniverseId: 1, leaderName: "Game 1" });
      expect(stat.phaseRule).toContain("Game 1");
    });

    it("follows week W's leader through its own CCU when another led W-3 (step 5)", async () => {
      await seedAlpha();
      // Flat shares of 0.2. Game 2 leads week W and was second in W-3; game 1 led W-3 and falls.
      await place(1, [3_000, 3_000, 800, 800]);
      await place(2, [1_000, 1_000, 2_800, 2_800]);
      for (const id of [3, 4, 5]) await place(id, [0, 0, 400 / 3, 400 / 3]);
      await place(900, [16_000, 16_000, 16_000, 16_000]);
      const stat = await alphaStat();
      expect(stat.leaderUniverseId).toBe(2);
      expect(stat.leaderTrend).toBeCloseTo(2.8, 10);
      expect(stat.phase).toBe("plateau");
    });

    it("labels a format unknown when the window mixes coverages (step 2)", async () => {
      await seedAlpha();
      await shares(alpha, [0.1, 0.1, 0.15, 0.15]);
      const stat = await alphaStat({ ...statsConfig, fullCoverageFrom: "2026-03-16" });
      expect(stat.phase).toBe("unknown");
      expect(stat.phaseRule).toContain("2026-03-16");
    });

    it("labels a format emerging when its first wave day is under the emerging days old (step 3)", async () => {
      await seedAlpha([{ id: 6, family: "alpha" }]);
      await shares(alpha, [0.2, 0.2, 0.2, 0.2]);
      // Game 6 first peaks at 10,000 CCU 10 days before as_of.
      await readings(6, "2026-03-20", 1, 0, 10_000);
      const stat = await alphaStat();
      expect(stat).toMatchObject({ phase: "emerging", waveAgeDays: 10, waveBeforeHistory: false });
      expect(stat.phaseRule).toContain("10");
      expect(stat.phaseRule).toContain("28");
    });

    it("labels a format emerging, without dividing by zero, when W-3 and W-2 have no readings (step 3)", async () => {
      await seedAlpha();
      for (const id of alpha) await place(id, [0, 0, 800, 800]);
      await place(900, [20_000, 20_000, 16_000, 16_000]);
      const stat = await alphaStat();
      expect(stat.phase).toBe("emerging");
      expect(stat.shareTrend).toBeNull();
      expect(stat.phaseRule).toContain("no readings");
    });

    it("labels a format small below the minimum games or CCU in week W (step 1)", async () => {
      await seed([...alpha.slice(0, 4).map((id) => ({ id, family: "alpha" })), { id: 900, family: "market" }]);
      await shares(alpha.slice(0, 4), [0.2, 0.2, 0.2, 0.2]);
      const stat = await alphaStat();
      expect(stat).toMatchObject({ phase: "small", games: 4 });
      expect(stat.phaseRule).toContain("4 games");
    });

    it("takes the followers' median peak over ranks 2 to 10 in order of creation", async () => {
      const ids = Array.from({ length: 11 }, (_, index) => index + 1);
      // Created on successive days from Mar 1; the 14-day windows have ended by as_of.
      await seed(
        ids.map((id) => ({ id, family: "beta", created: `2026-03-${String(id).padStart(2, "0")}T10:00:00Z` })),
      );
      for (const id of ids) {
        await readings(id, `2026-03-${String(id).padStart(2, "0")}`, 1, 50, 100 * id);
        await readings(id, "2026-03-26", 1, 50, 50);
      }
      const stats = await formatStats(database.db, { asOf }, statsConfig);
      const beta = stats.find((row) => row.dimension === "family" && row.format === "beta");
      expect(beta).toMatchObject({ followers: 9, followersMedianPeak: 600, entrants: 11 });
    });

    it("counts the wave's age in days and flags a wave starting with the history", async () => {
      await seedAlpha([{ id: 6, family: "alpha" }, { id: 7, family: "market" }]);
      await shares(alpha, [0.2, 0.2, 0.2, 0.2]);
      // 40 days before as_of, and the first day of the history.
      await readings(6, "2026-02-18", 1, 100, 10_000);
      const atStart = await alphaStat();
      expect(atStart).toMatchObject({ waveAgeDays: 40, waveBeforeHistory: true, phase: "plateau" });
      expect(atStart.firstWaveDay).toEqual(new Date("2026-02-18T00:00:00Z"));
      // A reading from an earlier day: the wave begins inside the history.
      await readings(7, "2026-02-10", 1, 10, 10);
      expect(await alphaStat()).toMatchObject({ waveAgeDays: 40, waveBeforeHistory: false });
    });
  });
});
