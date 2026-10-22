import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/logger";
import { createDatabase } from "./client";
import { DASHBOARD_DATABASE_OPTIONS } from "./dashboard";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("dashboard database session", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("reads but refuses every write", async () => {
    const { db, pool } = createDatabase(database.url, DASHBOARD_DATABASE_OPTIONS);
    try {
      const result = await db.execute<{ games: number }>(sql`select count(*)::int as games from games`);
      expect(result.rows).toEqual([{ games: 0 }]);
      const failure = await db
        .execute(sql`insert into job_runs (id, job, slot, status, started_at) values (gen_random_uuid(), 'poll', now(), 'running', now())`)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).not.toBeNull();
      expect(errorMessage(failure)).toContain("read-only transaction");
    } finally {
      await pool.end();
    }
  });
});
