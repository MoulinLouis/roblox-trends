import { describe, expect, it } from "vitest";
import { parseRateLimitDelayMs } from "./http";

describe("HTTP rate-limit timing", () => {
  it("uses the longest server-provided delay", () => {
    const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset": "12" });
    expect(parseRateLimitDelayMs(headers)).toBe(12_000);
  });

  it("supports an HTTP date in Retry-After", () => {
    const now = Date.parse("2026-08-10T20:00:00Z");
    const headers = new Headers({ "retry-after": "Mon, 10 Aug 2026 20:00:20 GMT" });
    expect(parseRateLimitDelayMs(headers, now)).toBe(20_000);
  });

  it("returns zero when rate-limit timing headers are absent", () => {
    expect(parseRateLimitDelayMs(new Headers())).toBe(0);
  });
});
