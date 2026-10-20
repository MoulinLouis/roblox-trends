import { describe, expect, it } from "vitest";
import { buildPingUrl, jobSlug, qualitySlug } from "./healthchecks";

describe("buildPingUrl", () => {
  const base = "https://hc-ping.com/ping-key/";

  it("builds start, success and fail URLs with auto-provisioning and a run id", () => {
    expect(buildPingUrl(base, "radar-poll", "start", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll/start?create=1&rid=run-1");
    expect(buildPingUrl(base, "radar-poll", "success", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll?create=1&rid=run-1");
    expect(buildPingUrl(base, "radar-poll", "fail", "run-1")).toBe("https://hc-ping.com/ping-key/radar-poll/fail?create=1&rid=run-1");
  });
});

describe("check slugs", () => {
  it("names the heartbeat check and the data quality check of a job", () => {
    expect(jobSlug("poll")).toBe("radar-poll");
    expect(qualitySlug("poll")).toBe("radar-poll-quality");
  });
});
