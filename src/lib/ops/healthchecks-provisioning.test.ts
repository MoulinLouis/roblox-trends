import { describe, expect, it, vi } from "vitest";
import { HEALTHCHECKS_CONFIG, JOB_CONFIG } from "@/lib/config";
import { JOB_NAMES } from "@/lib/jobs/types";
import { desiredChecks, HEALTHCHECKS_API_URL, upsertCheck } from "./healthchecks-provisioning";

describe("desiredChecks", () => {
  const checks = desiredChecks();

  it("holds a heartbeat and a quality check per job plus the operations checks, within the free plan", () => {
    expect(checks).toHaveLength(JOB_NAMES.length * 2 + Object.keys(HEALTHCHECKS_CONFIG.operations).length);
    expect(checks.length).toBeLessThanOrEqual(20);
    expect(new Set(checks.map((check) => check.slug)).size).toBe(checks.length);
  });

  it("uses each job's interval as the period and its timeout plus the margin as the heartbeat grace", () => {
    expect(checks.find((check) => check.slug === "radar-poll")).toMatchObject({ timeout: 300, grace: 270 + 300 });
    expect(checks.find((check) => check.slug === "radar-census-quality")).toMatchObject({ timeout: 600, grace: 3_600 });
    for (const name of JOB_NAMES) {
      const heartbeat = checks.find((check) => check.slug === `radar-${name}`);
      expect(heartbeat?.grace, name).toBeGreaterThan(JOB_CONFIG[name].timeoutMs / 1_000);
    }
  });

  it("gives the operations units the period and grace of their timers", () => {
    expect(checks.find((check) => check.slug === "radar-system")).toMatchObject({ timeout: 900, grace: 900 });
    expect(checks.find((check) => check.slug === "radar-restore-test")).toMatchObject({ timeout: 604_800, grace: 21_600 });
  });

  it("stays within the limits Healthchecks accepts", () => {
    for (const check of checks) {
      for (const seconds of [check.timeout, check.grace]) {
        expect(seconds, check.slug).toBeGreaterThanOrEqual(60);
        expect(seconds, check.slug).toBeLessThanOrEqual(31_536_000);
        expect(Number.isInteger(seconds), check.slug).toBe(true);
      }
      expect(check.slug).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("alerts on a lasting census degradation before the census loses its baseline", () => {
    expect(HEALTHCHECKS_CONFIG.qualityGraceMinutes).toBeLessThan(JOB_CONFIG.census.baselineMaxAgeHours * 60);
  });
});

// The message of the error the call rejects with; a call that resolves fails the test.
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the call to reject");
}

describe("upsertCheck", () => {
  const check = { slug: "radar-poll", name: "poll job", tags: "radar job", desc: "", timeout: 300, grace: 570 };

  it("upserts by slug, attaches every channel and authenticates with the API key header", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(upsertCheck("secret-key", check, fetchImpl)).resolves.toEqual({ slug: "radar-poll", created: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HEALTHCHECKS_API_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Api-Key")).toBe("secret-key");
    expect(JSON.parse(String(init.body))).toEqual({ ...check, channels: "*", unique: ["slug"] });
  });

  it("reports an update when the check already existed", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(upsertCheck("secret-key", check, fetchImpl)).resolves.toEqual({ slug: "radar-poll", created: false });
  });

  it("throws on a rejected request without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("check limit reached", { status: 403 }));
    const message = await rejectionMessage(upsertCheck("secret-key", check, fetchImpl));
    expect(message).toContain("HTTP 403");
    expect(message).toContain("check limit reached");
    expect(message).not.toContain("secret-key");
  });

  it("redacts the key from a response that echoes it", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid api key: secret-key", { status: 401 }));
    const message = await rejectionMessage(upsertCheck("secret-key", check, fetchImpl));
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain("secret-key");
  });
});
