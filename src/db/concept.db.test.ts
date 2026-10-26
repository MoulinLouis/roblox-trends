import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameDetail } from "@/test/fixtures";
import { readConceptHistory } from "./concept";
import { upsertGameDetails } from "./games";
import { writeGameObservations } from "./observations";
import { discoverySources } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("readConceptHistory", () => {
  let database: TestDatabase;
  const firstSeen = new Date("2026-10-01T00:00:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Skip a Stone" }), gameDetail(2)], firstSeen);
    await upsertGameDetails(database.db, [gameDetail(1, { name: "Skip a Stone [UPD]" })], new Date("2026-10-20T00:00:00Z"));
    await writeGameObservations(database.db, [
      { universeId: 1, observedAt: new Date("2026-08-01T06:00:00Z"), ccu: 300, visits: 1_000, favorites: 10 },
      { universeId: 1, observedAt: new Date("2026-10-19T06:00:00Z"), ccu: 1_000, visits: 50_000, favorites: 400 },
    ]);
    await database.db
      .insert(discoverySources)
      .values({ universeId: 1, source: "search", detail: "stone", firstSeenAt: firstSeen, lastSeenAt: firstSeen });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("reads the peak, the recent days, earlier names and sources of tracked attempts", async () => {
    const history = await readConceptHistory(database.db, [1, 2, 3], new Date("2026-09-01T00:00:00Z"));
    expect(history.get(1)).toEqual({
      firstObservedAt: firstSeen,
      peakCcu: 1_000,
      peakDay: new Date("2026-10-19T00:00:00Z"),
      daily: [{ day: new Date("2026-10-19T00:00:00Z"), ccuPeak: 1_000 }],
      earlierNames: ["Skip a Stone"],
      sources: ["search"],
    });
    expect(history.get(2)).toMatchObject({ peakCcu: null, peakDay: null, daily: [], earlierNames: [], sources: [] });
    expect(history.has(3)).toBe(false);
  });

  it("reads nothing for no ids", async () => {
    expect(await readConceptHistory(database.db, [], new Date("2026-09-01T00:00:00Z"))).toEqual(new Map());
  });
});
