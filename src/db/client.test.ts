import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "./client";

// The pool connects lazily and these tests run no query, so the unreachable URL is never contacted.
describe("getDatabase", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://radar@127.0.0.1:1/radar");
  });

  afterEach(async () => {
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("returns the shared instance to later calls with the same options", () => {
    const first = getDatabase("radar-poll", { statementTimeoutMs: 1_000, lockTimeoutMs: 30_000 });
    expect(getDatabase("radar-poll", { statementTimeoutMs: 1_000, lockTimeoutMs: 30_000 })).toBe(first);
  });

  it("rejects a later call with another application name or other timeouts", () => {
    getDatabase("radar-poll", { statementTimeoutMs: 1_000, lockTimeoutMs: 30_000 });
    expect(() => getDatabase("radar-votes", { statementTimeoutMs: 1_000, lockTimeoutMs: 30_000 })).toThrow(/shared database/);
    expect(() => getDatabase("radar-poll", { statementTimeoutMs: 2_000, lockTimeoutMs: 30_000 })).toThrow(/shared database/);
    expect(() => getDatabase("radar-poll", { statementTimeoutMs: 1_000 })).toThrow(/shared database/);
    expect(() => getDatabase()).toThrow(/shared database/);
  });
});
