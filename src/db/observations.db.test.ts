import { and, between, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/logger";
import { createDatabase, type Database } from "./client";
import {
  replaceChartSlot,
  writeCensusObservations,
  writeChartPlacements,
  writeGameObservations,
  writeVoteObservations,
} from "./observations";
import { censusObservations, chartPlacements, gameObservations, voteObservations } from "./schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("observation writers", () => {
  let database: TestDatabase;
  const slot = new Date("2026-10-20T14:05:00Z");
  const nextSlot = new Date("2026-10-20T14:10:00Z");

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  // The rows are given in primary-key order. Another connection locks the first one, then the writer receives the rows
  // in reverse order. A writer that locks rows in key order waits on that first row before touching any other, so this
  // returns 0; an unsorted or partially sorted writer has already locked some of the others.
  async function rowsLockedBeforeTheFirst<Row>(
    table: PgTable,
    rows: Row[],
    write: (db: Database, rows: Row[]) => Promise<number>,
    matches: (row: Row) => SQL | undefined,
  ): Promise<number> {
    await write(database.db, rows);
    const holder = new Client({ connectionString: database.url });
    await holder.connect();
    const writer = createDatabase(database.url, { maxConnections: 1, applicationName: "radar-test-writer" });
    try {
      await holder.query("begin");
      await drizzle(holder).select({ found: sql`1` }).from(table).where(matches(rows[0])).for("update");
      const pending = write(writer.db, [...rows].reverse());
      // Awaited below; this only avoids an unhandled rejection when the wait fails first.
      pending.catch(() => undefined);
      await waitForLockWait("radar-test-writer");
      let locked = 0;
      for (const row of rows.slice(1)) {
        const free = await database.db
          .select({ found: sql`1` })
          .from(table)
          .where(matches(row))
          .for("update", { skipLocked: true });
        if (!free.length) locked += 1;
      }
      await holder.query("commit");
      await pending;
      return locked;
    } finally {
      await holder.end();
      await writer.pool.end();
    }
  }

  async function waitForLockWait(applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await database.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and application_name = ${applicationName} and wait_event_type = 'Lock'`,
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${applicationName} never waited on a row lock`);
  }

  it("replaces a game observation written twice in the same slot", async () => {
    await writeGameObservations(database.db, [{ universeId: 1, observedAt: slot, ccu: 100, visits: 10, favorites: 1 }]);
    // Replace mode reports every distinct row, updated or inserted.
    const written = await writeGameObservations(database.db, [
      { universeId: 1, observedAt: slot, ccu: 150, visits: 11, favorites: 2 },
      { universeId: 1, observedAt: slot, ccu: 999, visits: 99, favorites: 9 },
    ]);
    expect(written).toBe(1);
    const rows = await database.db.select().from(gameObservations).where(eq(gameObservations.universeId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].ccu).toBe(150);
  });

  it("keeps existing rows in keep mode", async () => {
    await writeGameObservations(database.db, [{ universeId: 2, observedAt: slot, ccu: 150, visits: 11, favorites: 2 }]);
    const legacy = { observedAt: slot, ccu: 1, visits: 1, favorites: 1, source: "legacy" as const };
    expect(await writeGameObservations(database.db, [{ universeId: 2, ...legacy }], "keep")).toBe(0);
    // Keep mode reports only the rows it inserted.
    expect(await writeGameObservations(database.db, [{ universeId: 2, ...legacy }, { universeId: 3, ...legacy }], "keep")).toBe(1);
    const [row] = await database.db.select().from(gameObservations).where(eq(gameObservations.universeId, 2));
    expect(row.ccu).toBe(150);
    expect(row.source).toBe("poll");
    const [inserted] = await database.db.select().from(gameObservations).where(eq(gameObservations.universeId, 3));
    expect(inserted).toMatchObject({ ccu: 1, source: "legacy" });
  });

  it("writes census, vote and chart rows idempotently", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await writeCensusObservations(database.db, [{ placeId: 10, observedAt: slot, ccu: 400 }]);
      await writeVoteObservations(database.db, [{ universeId: 1, observedAt: slot, upVotes: 90, downVotes: 10 }]);
      await writeChartPlacements(database.db, [{ sortId: "top-trending", universeId: 1, observedAt: slot, rank: 3, playerCount: 150, isSponsored: false }]);
    }
    expect(await database.db.select().from(censusObservations).where(eq(censusObservations.placeId, 10))).toHaveLength(1);
    expect(await database.db.select().from(voteObservations).where(eq(voteObservations.universeId, 1))).toHaveLength(1);
    expect(await database.db.select().from(chartPlacements).where(eq(chartPlacements.universeId, 1))).toHaveLength(1);
  });

  it("replaces every value of a row in replace mode and none in keep mode", async () => {
    await writeGameObservations(database.db, [{ universeId: 20, observedAt: slot, ccu: 5, visits: 50, favorites: 5, source: "legacy" }], "keep");
    await writeGameObservations(database.db, [{ universeId: 20, observedAt: slot, ccu: 6, visits: 60, favorites: 6 }]);
    await writeGameObservations(database.db, [{ universeId: 20, observedAt: slot, ccu: 7, visits: 70, favorites: 7, source: "legacy" }], "keep");
    const [game] = await database.db.select().from(gameObservations).where(eq(gameObservations.universeId, 20));
    expect(game).toMatchObject({ ccu: 6, visits: 60, favorites: 6, source: "poll" });

    await writeCensusObservations(database.db, [{ placeId: 20, observedAt: slot, ccu: 400 }]);
    await writeCensusObservations(database.db, [{ placeId: 20, observedAt: slot, ccu: 450 }]);
    await writeCensusObservations(database.db, [{ placeId: 20, observedAt: slot, ccu: 1 }], "keep");
    const [census] = await database.db.select().from(censusObservations).where(eq(censusObservations.placeId, 20));
    expect(census.ccu).toBe(450);

    await writeVoteObservations(database.db, [{ universeId: 20, observedAt: slot, upVotes: 90, downVotes: 10 }]);
    await writeVoteObservations(database.db, [{ universeId: 20, observedAt: slot, upVotes: 95, downVotes: 12 }]);
    await writeVoteObservations(database.db, [{ universeId: 20, observedAt: slot, upVotes: 1, downVotes: 1 }], "keep");
    const [votes] = await database.db.select().from(voteObservations).where(eq(voteObservations.universeId, 20));
    expect(votes).toMatchObject({ upVotes: 95, downVotes: 12 });

    const placement = { sortId: "top-trending", universeId: 20, observedAt: slot };
    await writeChartPlacements(database.db, [{ ...placement, rank: 3, playerCount: 150, isSponsored: false }]);
    await writeChartPlacements(database.db, [{ ...placement, rank: 5, playerCount: 120, isSponsored: null }]);
    await writeChartPlacements(database.db, [{ ...placement, rank: 1, playerCount: 1, isSponsored: true }], "keep");
    const [chart] = await database.db.select().from(chartPlacements).where(eq(chartPlacements.universeId, 20));
    expect(chart).toMatchObject({ rank: 5, playerCount: 120, isSponsored: null });
  });

  it("replaces only the given sort and slot of the chart placements", async () => {
    const placement = (sortId: string, universeId: number, observedAt = slot) => ({ sortId, universeId, observedAt, rank: 1, playerCount: 1, isSponsored: null });
    await writeChartPlacements(database.db, [
      placement("top-rated", 50),
      placement("top-rated", 51),
      placement("top-rated", 50, nextSlot),
      placement("top-earning", 50),
    ]);
    expect(await replaceChartSlot(database.db, "top-rated", slot, [placement("top-rated", 52), placement("top-rated", 52)])).toBe(1);
    const stored = await database.db
      .select({ sortId: chartPlacements.sortId, universeId: chartPlacements.universeId, observedAt: chartPlacements.observedAt })
      .from(chartPlacements)
      .where(between(chartPlacements.universeId, 50, 59))
      .orderBy(chartPlacements.sortId, chartPlacements.observedAt, chartPlacements.universeId);
    expect(stored).toEqual([
      { sortId: "top-earning", universeId: 50, observedAt: slot },
      { sortId: "top-rated", universeId: 52, observedAt: slot },
      { sortId: "top-rated", universeId: 50, observedAt: nextSlot },
    ]);
  });

  it("keeps the previous chart slot when its replacement fails", async () => {
    const placement = (universeId: number, playerCount = 1) => ({ sortId: "top-revisited", universeId, observedAt: slot, rank: 1, playerCount, isSponsored: null });
    expect(await replaceChartSlot(database.db, "top-revisited", slot, [placement(60), placement(61)])).toBe(2);
    // The delete runs first; a player count beyond the integer column then fails the insert.
    const failure = await replaceChartSlot(database.db, "top-revisited", slot, [placement(62, 3_000_000_000)]).catch((error: unknown) => error);
    expect(errorMessage(failure)).toMatch(/out of range/);
    const stored = await database.db
      .select({ universeId: chartPlacements.universeId })
      .from(chartPlacements)
      .where(and(eq(chartPlacements.sortId, "top-revisited"), eq(chartPlacements.observedAt, slot)))
      .orderBy(chartPlacements.universeId);
    expect(stored.map((row) => row.universeId)).toEqual([60, 61]);
  });

  it("refuses chart placements outside the replaced slot", async () => {
    const placement = { sortId: "top-revisited", universeId: 63, observedAt: slot, rank: 1, playerCount: 1, isSponsored: null };
    await expect(replaceChartSlot(database.db, "top-revisited", nextSlot, [placement])).rejects.toThrow(/must belong to the replaced slot/);
    await expect(replaceChartSlot(database.db, "top-rated", slot, [placement])).rejects.toThrow(/must belong to the replaced slot/);
  });

  it("writes a batch that spans several chunks and keeps the first duplicate", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ universeId: 10_000 + index, observedAt: slot, ccu: index, visits: 0, favorites: 0 }));
    // The duplicate comes after the first 2,000 rows of the input; the first occurrence still wins.
    expect(await writeGameObservations(database.db, [...rows, { ...rows[0], ccu: -1 }])).toBe(2_500);
    const [stored] = await database.db
      .select({ rows: sql<number>`count(*)::int` })
      .from(gameObservations)
      .where(between(gameObservations.universeId, 10_000, 12_499));
    expect(stored.rows).toBe(2_500);
    const [first] = await database.db.select().from(gameObservations).where(eq(gameObservations.universeId, 10_000));
    expect(first.ccu).toBe(0);
  });

  it("writes into a compressed chunk", async () => {
    const old = new Date("2026-09-01T00:00:00Z");
    const oldNextSlot = new Date("2026-09-01T00:05:00Z");
    await writeGameObservations(database.db, [{ universeId: 40, observedAt: old, ccu: 100, visits: 10, favorites: 1 }]);
    // Only the 2026-09-01 chunk: the 2026-10-20 chunk of the other tests stays uncompressed.
    const compressed = await database.db.execute(
      sql`select compress_chunk(c) from show_chunks('game_observations', older_than => '2026-09-02'::timestamptz) c`,
    );
    expect(compressed.rows).toHaveLength(1);
    const chunks = await database.db.execute<{ compressed: boolean }>(
      sql`select is_compressed as compressed from timescaledb_information.chunks
          where hypertable_name = 'game_observations' and range_start = '2026-09-01'::timestamptz`,
    );
    expect(chunks.rows).toEqual([{ compressed: true }]);
    const stored = () =>
      database.db
        .select()
        .from(gameObservations)
        .where(between(gameObservations.universeId, 40, 41))
        .orderBy(gameObservations.universeId);

    const legacy = { ccu: 1, visits: 1, favorites: 1, source: "legacy" as const };
    const kept = await writeGameObservations(
      database.db,
      [
        { universeId: 40, observedAt: old, ...legacy },
        { universeId: 41, observedAt: oldNextSlot, ...legacy },
      ],
      "keep",
    );
    expect(kept).toBe(1);
    expect(await stored()).toEqual([
      { universeId: 40, observedAt: old, ccu: 100, visits: 10, favorites: 1, source: "poll" },
      { universeId: 41, observedAt: oldNextSlot, ccu: 1, visits: 1, favorites: 1, source: "legacy" },
    ]);

    expect(await writeGameObservations(database.db, [{ universeId: 40, observedAt: old, ccu: 200, visits: 20, favorites: 2 }])).toBe(1);
    expect((await stored())[0]).toEqual({ universeId: 40, observedAt: old, ccu: 200, visits: 20, favorites: 2, source: "poll" });
  });

  it("locks game observations in key order", async () => {
    const row = (universeId: number, observedAt: Date) => ({ universeId, observedAt, ccu: 1, visits: 1, favorites: 1 });
    const locked = await rowsLockedBeforeTheFirst(
      gameObservations,
      [row(300, slot), row(300, nextSlot), row(301, slot)],
      writeGameObservations,
      (key) => and(eq(gameObservations.universeId, key.universeId), eq(gameObservations.observedAt, key.observedAt)),
    );
    expect(locked).toBe(0);
  });

  it("locks census observations in key order", async () => {
    const row = (placeId: number, observedAt: Date) => ({ placeId, observedAt, ccu: 1 });
    const locked = await rowsLockedBeforeTheFirst(
      censusObservations,
      [row(300, slot), row(300, nextSlot), row(301, slot)],
      writeCensusObservations,
      (key) => and(eq(censusObservations.placeId, key.placeId), eq(censusObservations.observedAt, key.observedAt)),
    );
    expect(locked).toBe(0);
  });

  it("locks vote observations in key order", async () => {
    const row = (universeId: number, observedAt: Date) => ({ universeId, observedAt, upVotes: 1, downVotes: 1 });
    const locked = await rowsLockedBeforeTheFirst(
      voteObservations,
      [row(300, slot), row(300, nextSlot), row(301, slot)],
      writeVoteObservations,
      (key) => and(eq(voteObservations.universeId, key.universeId), eq(voteObservations.observedAt, key.observedAt)),
    );
    expect(locked).toBe(0);
  });

  it("locks chart placements in key order", async () => {
    const row = (sortId: string, universeId: number, observedAt: Date) => ({ sortId, universeId, observedAt, rank: 1, playerCount: 1, isSponsored: false });
    const locked = await rowsLockedBeforeTheFirst(
      chartPlacements,
      [row("top-trending", 300, slot), row("top-trending", 300, nextSlot), row("top-trending", 301, slot), row("up-and-coming", 300, slot)],
      writeChartPlacements,
      (key) =>
        and(
          eq(chartPlacements.sortId, key.sortId),
          eq(chartPlacements.universeId, key.universeId),
          eq(chartPlacements.observedAt, key.observedAt),
        ),
    );
    expect(locked).toBe(0);
  });
});
