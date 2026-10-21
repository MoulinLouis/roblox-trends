import { describe, expect, it } from "vitest";
import type { Database } from "./client";
import { assertSupportedPostgres } from "./legacy-guard";

function databaseReporting(version: number): Database {
  return { execute: async () => ({ rows: [{ version }] }) } as unknown as Database;
}

describe("assertSupportedPostgres", () => {
  it("rejects servers older than PostgreSQL 18", async () => {
    await expect(assertSupportedPostgres(databaseReporting(170_006))).rejects.toThrow(/PostgreSQL 18 or newer is required/);
  });

  it("accepts PostgreSQL 18 and newer", async () => {
    await expect(assertSupportedPostgres(databaseReporting(180_000))).resolves.toBeUndefined();
    await expect(assertSupportedPostgres(databaseReporting(190_001))).resolves.toBeUndefined();
  });
});
