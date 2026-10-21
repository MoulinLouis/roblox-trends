import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./test-database";

describe.skipIf(!hasTestDatabase)("createDatabase", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function sessionTimeouts(options: Parameters<typeof createDatabase>[1]) {
    const { db, pool } = createDatabase(database.url, options);
    try {
      const result = await db.execute<{ statement: string; lock: string }>(
        sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`,
      );
      return result.rows[0];
    } finally {
      await pool.end();
    }
  }

  it("applies statement and lock timeouts to its sessions", async () => {
    expect(await sessionTimeouts({ statementTimeoutMs: 1_234, lockTimeoutMs: 567 })).toEqual({ statement: "1234ms", lock: "567ms" });
  });

  it("leaves the server defaults when no timeout is given", async () => {
    expect(await sessionTimeouts({})).toEqual({ statement: "0", lock: "0" });
  });

  it("sends session settings when the connection opens", async () => {
    // A custom (dotted) setting keeps its value verbatim, so the server must have parsed every escaped character.
    const probe = "a b\tc\nd\\e";
    const { db, pool } = createDatabase(database.url, { settings: { work_mem: "8MB", "radar.probe": probe } });
    try {
      const result = await db.execute<{ workMem: string; probe: string }>(
        sql`select current_setting('work_mem') as "workMem", current_setting('radar.probe') as probe`,
      );
      expect(result.rows[0]).toEqual({ workMem: "8MB", probe });
    } finally {
      await pool.end();
    }
  });
});
