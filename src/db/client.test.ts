import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, closeDatabaseWithin, getDatabase } from "./client";

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

describe("closeDatabaseWithin", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://radar@127.0.0.1:1/radar");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("closes an idle pool", async () => {
    getDatabase("radar-poll");
    await expect(closeDatabaseWithin(1_000)).resolves.toBe(true);
  });

  it("stops waiting for a pool that does not close in time", async () => {
    getDatabase("radar-poll");
    // A pool whose checked-out client never comes back.
    vi.spyOn(Pool.prototype, "end").mockImplementation(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(closeDatabaseWithin(10, { job: "poll" })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not close within 0.01 s"));
  });
});
