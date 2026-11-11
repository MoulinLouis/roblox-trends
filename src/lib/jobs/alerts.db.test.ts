import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readUnsentAlerts } from "@/db/alerts";
import { insertSubmittingBatch, markBatchSubmitted, storeBatchResults } from "@/db/classifications";
import { upsertGameDetails } from "@/db/games";
import { writeGameObservations } from "@/db/observations";
import { alerts, classificationBatches, censusObservations, gameDailyLegacy, gameObservations, games, places, voteObservations } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import type { DiscordMessage } from "@/lib/alerts/discord";
import { hasStat, WATCHED_STATS } from "@/lib/status-report";
import { gameDetail } from "@/test/fixtures";
import { type AlertsDependencies, createAlertsJob } from "./alerts";

const at = (value: string) => new Date(value);
const batchId = "00000000-0000-4000-8000-0000000000b1";
const webhook = "https://discord.com/api/webhooks/1/secret-token";

describe.skipIf(!hasTestDatabase)("alerts job", () => {
  let database: TestDatabase;
  let posted: Array<{ url: string; message: DiscordMessage }>;
  let failing: boolean;
  let url: string | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    posted = [];
    failing = false;
    url = webhook;
    await database.db.delete(alerts);
    await database.db.delete(classificationBatches);
    await database.db.delete(gameObservations);
    await database.db.delete(censusObservations);
    await database.db.delete(voteObservations);
    await database.db.delete(gameDailyLegacy);
    await database.db.delete(places);
    await database.db.delete(games);
    await database.db.execute(sql`truncate game_hourly, census_hourly, game_daily`);
  });

  function job(extra: Partial<AlertsDependencies> = {}) {
    return createAlertsJob({
      webhookUrl: () => url,
      post: async (target, message) => {
        if (failing) throw new Error(`Failed to post to ${target}`);
        posted.push({ url: target, message });
      },
      ...extra,
    });
  }

  async function run(now: string, extra: Partial<AlertsDependencies> = {}) {
    const date = at(now);
    return job(extra).run({ db: database.db, now: date, slot: date, runId: "run" });
  }

  // Each game is created five days before its crossing and classified with the family and template given.
  async function breakout(universeId: number, crossing: string, format: string): Promise<void> {
    const crossed = at(crossing);
    const created = new Date(crossed.getTime() - 5 * 86_400_000);
    await upsertGameDetails(database.db, [gameDetail(universeId, { created, name: `Game ${universeId}` })], created);
    await writeGameObservations(database.db, [{ universeId, observedAt: crossed, ccu: 1_500, visits: 1_000, favorites: 10 }]);
    const id = `${batchId.slice(0, -2)}${String(universeId).padStart(2, "0")}`;
    await insertSubmittingBatch(database.db, { id, model: "claude-sonnet-5-5", promptVersion: 3, submittedAt: created }, [
      { universeId, name: `Game ${universeId}`, hadThumbnail: true },
    ]);
    await markBatchSubmitted(database.db, id, `msgbatch_${id}`);
    await storeBatchResults(
      database.db,
      id,
      [
        {
          universeId,
          status: "classified" as const,
          classification: {
            reason: "Test.",
            family: `family ${format}`,
            template: `template ${format}`,
            rewardLoop: "progress",
            coreAction: "throw",
            theme: "none",
            setting: "none",
            progression: "levels",
            social: "solo",
            confidence: "high",
          },
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        },
      ],
      { at: created, costUsd: 0, stats: {} },
    );
  }

  const unsent = async () => (await readUnsentAlerts(database.db)).map((alert) => `${alert.kind}:${alert.universeId}`);

  it("records a forming wave and posts it in the same run, and the next run posts nothing", async () => {
    // Games 1, 2 and 3 share a format: 1 is the first of it, 2 the second (no alert), 3 the third, which forms a wave.
    await breakout(1, "2026-03-10T10:00:00Z", "a");
    await breakout(2, "2026-03-10T12:00:00Z", "a");
    await breakout(3, "2026-03-10T14:00:00Z", "a");
    // 15:30 UTC is 16:30 Paris (winter): the digest is due too.
    const first = await run("2026-03-10T15:30:00Z");
    expect(first.stats).toMatchObject({ candidates: 3, firstBreakouts: 1, waves: 1, sent: 2, unsent: 0 });
    expect(first.status).toBe("success");
    expect(posted).toHaveLength(2);
    expect(posted.every((entry) => entry.url === webhook)).toBe(true);
    expect(await unsent()).toEqual([]);

    const second = await run("2026-03-10T16:30:00Z");
    expect(second.stats).toMatchObject({ firstBreakouts: 0, waves: 0, sent: 0, unsent: 0 });
    expect(posted).toHaveLength(2);
    expect(WATCHED_STATS.alerts?.values.filter((path) => !hasStat(second.stats, path))).toEqual([]);
  });

  it("records a winter first breakout at 06:30 Paris, posts the digest at 08:56 and not at 09:56", async () => {
    await breakout(1, "2026-01-15T03:00:00Z", "a");
    const early = await run("2026-01-15T05:30:00Z");
    expect(early.stats).toMatchObject({ firstBreakouts: 1, sent: 0, unsent: 1 });
    expect(early.status).toBe("success");
    expect(posted).toHaveLength(0);

    const morning = await run("2026-01-15T07:56:00Z");
    expect(morning.stats).toMatchObject({ sent: 1, unsent: 0 });
    expect(posted).toHaveLength(1);
    expect(posted[0].message.embeds).toHaveLength(1);

    await breakout(2, "2026-01-15T08:00:00Z", "b");
    const later = await run("2026-01-15T08:56:00Z");
    expect(later.stats).toMatchObject({ firstBreakouts: 1, sent: 0, unsent: 1 });
    expect(posted).toHaveLength(1);
  });

  it("does the same in summer, when Paris is UTC+2", async () => {
    await breakout(1, "2026-07-15T02:00:00Z", "a");
    // 05:30 UTC is 07:30 Paris, and 06:56 UTC is 08:56 Paris.
    await run("2026-07-15T05:30:00Z");
    expect(posted).toHaveLength(0);
    const morning = await run("2026-07-15T06:56:00Z");
    expect(morning.stats).toMatchObject({ sent: 1, unsent: 0 });
    expect(posted).toHaveLength(1);
    await run("2026-07-15T07:56:00Z");
    expect(posted).toHaveLength(1);
  });

  it("follows the local day across midnight in Paris", async () => {
    await breakout(1, "2026-07-15T20:00:00Z", "a");
    // 21:56 UTC is 23:56 Paris: the digest of the day goes out.
    await run("2026-07-15T21:56:00Z");
    expect(posted).toHaveLength(1);
    await breakout(2, "2026-07-15T22:00:00Z", "b");
    // 22:56 UTC is 00:56 Paris on the next day: before the digest hour, nothing goes out.
    const night = await run("2026-07-15T22:56:00Z");
    expect(night.stats).toMatchObject({ firstBreakouts: 1, sent: 0, unsent: 1 });
    expect(posted).toHaveLength(1);
    // 06:56 UTC is 08:56 Paris.
    await run("2026-07-16T06:56:00Z");
    expect(posted).toHaveLength(2);
  });

  it("records alerts without a webhook URL and degrades, and a later run with the URL posts them", async () => {
    await breakout(1, "2026-03-10T10:00:00Z", "a");
    await breakout(2, "2026-03-10T12:00:00Z", "a");
    await breakout(3, "2026-03-10T14:00:00Z", "a");
    for (const missing of [undefined, ""]) {
      url = missing;
      const result = await run("2026-03-10T15:30:00Z");
      expect(result.status).toBe("degraded");
      expect(result.stats).toMatchObject({ sent: 0, unsent: 2 });
      expect(posted).toHaveLength(0);
    }
    url = webhook;
    const later = await run("2026-03-10T16:30:00Z");
    expect(later.status).toBe("success");
    expect(later.stats).toMatchObject({ firstBreakouts: 0, waves: 0, sent: 2, unsent: 0 });
    expect(posted).toHaveLength(2);
  });

  it("leaves an alert unsent when the post throws, degrades, and sends it on the next run", async () => {
    await breakout(1, "2026-03-10T10:00:00Z", "a");
    await breakout(2, "2026-03-10T12:00:00Z", "a");
    await breakout(3, "2026-03-10T14:00:00Z", "a");
    failing = true;
    const failed = await run("2026-03-10T15:30:00Z");
    expect(failed.status).toBe("degraded");
    expect(failed.stats).toMatchObject({ sent: 0, unsent: 2 });
    expect(await unsent()).toEqual(["first_breakout:1", "wave:3"]);
    failing = false;
    const next = await run("2026-03-10T16:30:00Z");
    expect(next.status).toBe("success");
    expect(next.stats).toMatchObject({ sent: 2, unsent: 0 });
    expect(await unsent()).toEqual([]);
  });

  it("keeps the webhook URL out of the stats", async () => {
    await breakout(1, "2026-03-10T10:00:00Z", "a");
    await breakout(2, "2026-03-10T12:00:00Z", "a");
    await breakout(3, "2026-03-10T14:00:00Z", "a");
    failing = true;
    const failed = await run("2026-03-10T15:30:00Z");
    expect(JSON.stringify(failed.stats)).not.toContain("secret-token");
    failing = false;
    const sent = await run("2026-03-10T16:30:00Z");
    expect(JSON.stringify(sent.stats)).not.toContain("secret-token");
  });
});
