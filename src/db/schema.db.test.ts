import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("v2 schema migrations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("creates the four hypertables", async () => {
    const result = await database.db.execute<{ hypertable_name: string }>(
      sql`select hypertable_name from timescaledb_information.hypertables order by 1`,
    );
    expect(result.rows.map((row) => row.hypertable_name)).toEqual([
      "census_observations",
      "chart_placements",
      "game_observations",
      "vote_observations",
    ]);
  });

  it("creates the continuous aggregates", async () => {
    const result = await database.db.execute<{ view_name: string }>(
      sql`select view_name from timescaledb_information.continuous_aggregates order by 1`,
    );
    expect(result.rows.map((row) => row.view_name)).toEqual(["census_hourly", "game_daily", "game_hourly"]);
  });

  it("serves unmaterialized observations through the hourly aggregate", async () => {
    await database.db.execute(sql`
      insert into game_observations (universe_id, observed_at, ccu, visits, favorites) values
        (1, '2026-10-20T14:00:00Z', 100, 1000, 10),
        (1, '2026-10-20T14:05:00Z', 300, 1100, 11),
        (1, '2026-10-20T14:10:00Z', 200, 1200, 12)
    `);
    const result = await database.db.execute<{ ccu_min: number; ccu_max: number; samples: string; visits_last: string }>(
      sql`select ccu_min, ccu_max, samples, visits_last from game_hourly where universe_id = 1`,
    );
    expect(result.rows).toEqual([{ ccu_min: 100, ccu_max: 300, samples: "3", visits_last: "1200" }]);
  });

  it("refuses to migrate a database that still holds v1 tables", async () => {
    const legacy = await createTestDatabase({ migrate: false });
    try {
      await legacy.db.execute(sql`create table snapshots (id integer)`);
      await expect(migrateDatabase(legacy.db)).rejects.toThrow(/v1/);
    } finally {
      await legacy.drop();
    }
  });
});
