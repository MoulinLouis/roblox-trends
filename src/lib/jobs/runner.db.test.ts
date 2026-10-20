import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDatabase } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@/db/test-database";
import { executeJob } from "./runner";
import type { JobName } from "./types";

const pingBase = "https://hc-ping.example/key";

describe.skipIf(!hasTestDatabase)("executeJob", () => {
  let database: TestDatabase;
  let fetchMock: Mock<typeof fetch>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.delete(jobRuns);
    vi.stubEnv("HEALTHCHECKS_PING_BASE", pingBase);
    fetchMock = vi.fn<typeof fetch>(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function pingUrls(): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
  }

  function pingBody(index: number): unknown {
    return fetchMock.mock.calls[index]?.[1]?.body;
  }

  async function onlyRun(job: JobName) {
    const runs = await database.db.select().from(jobRuns).where(eq(jobRuns.job, job));
    expect(runs).toHaveLength(1);
    return runs[0];
  }

  it("records a successful run with its slot and stats", async () => {
    const status = await executeJob(
      { name: "poll", intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "success", stats: { games: 3 } }) },
      database.db,
      new Date("2026-10-20T14:07:00Z"),
    );
    expect(status).toBe("success");
    const run = await onlyRun("poll");
    expect(run.status).toBe("success");
    expect(run.slot.toISOString()).toBe("2026-10-20T14:05:00.000Z");
    expect(run.stats).toEqual({ games: 3 });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(pingUrls()).toEqual([
      `${pingBase}/radar-poll/start?create=1&rid=${run.id}`,
      `${pingBase}/radar-poll?create=1&rid=${run.id}`,
      `${pingBase}/radar-poll-quality?create=1&rid=${run.id}`,
    ]);
    expect(JSON.parse(String(pingBody(1)))).toEqual({ games: 3, status: "success" });
  });

  it("records a degraded run without pinging the quality check", async () => {
    const status = await executeJob(
      { name: "census", intervalMinutes: 60, timeoutMs: 1_000, run: async () => ({ status: "degraded", stats: { listed: 0 } }) },
      database.db,
    );
    expect(status).toBe("degraded");
    const run = await onlyRun("census");
    expect(run.status).toBe("degraded");
    expect(pingUrls()).toEqual([
      `${pingBase}/radar-census/start?create=1&rid=${run.id}`,
      `${pingBase}/radar-census?create=1&rid=${run.id}`,
    ]);
  });

  it("reports the run status even when a stat has the same name", async () => {
    await executeJob(
      { name: "poll", intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "degraded", stats: { status: "fine" } }) },
      database.db,
    );
    expect(JSON.parse(String(pingBody(1)))).toEqual({ status: "degraded" });
  });

  it("records a failed run with its error", async () => {
    const status = await executeJob(
      { name: "votes", intervalMinutes: 60, timeoutMs: 1_000, run: async () => { throw new Error("boom"); } },
      database.db,
    );
    expect(status).toBe("failed");
    const run = await onlyRun("votes");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    expect(pingUrls()).toEqual([
      `${pingBase}/radar-votes/start?create=1&rid=${run.id}`,
      `${pingBase}/radar-votes/fail?create=1&rid=${run.id}`,
    ]);
    expect(pingBody(1)).toBe("boom");
  });

  it("fails a run that exceeds its timeout", async () => {
    const status = await executeJob(
      {
        name: "charts",
        intervalMinutes: 60,
        timeoutMs: 20,
        run: () => new Promise((resolve) => setTimeout(() => resolve({ status: "success", stats: {} }), 500)),
      },
      database.db,
    );
    expect(status).toBe("failed");
    const run = await onlyRun("charts");
    expect(run.error).toMatch(/exceeded/);
    expect(pingUrls()).toEqual([
      `${pingBase}/radar-charts/start?create=1&rid=${run.id}`,
      `${pingBase}/radar-charts/fail?create=1&rid=${run.id}`,
    ]);
  });

  it("keeps the run status when Healthchecks is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const status = await executeJob(
      { name: "poll", intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "success", stats: {} }) },
      database.db,
    );
    expect(status).toBe("success");
    expect((await onlyRun("poll")).status).toBe("success");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("pings a failure when the run cannot even be recorded", async () => {
    const closed = createDatabase(database.url, { maxConnections: 1 });
    await closed.pool.end();
    const run = vi.fn(async () => ({ status: "success" as const, stats: {} }));
    const status = await executeJob({ name: "explore", intervalMinutes: 60, timeoutMs: 1_000, run }, closed.db);
    expect(status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
    const runId = new URL(pingUrls()[0] ?? pingBase).searchParams.get("rid");
    expect(pingUrls()).toEqual([
      `${pingBase}/radar-explore/start?create=1&rid=${runId}`,
      `${pingBase}/radar-explore/fail?create=1&rid=${runId}`,
    ]);
    expect(pingBody(1)).toMatch(/pool/);
  });
});
