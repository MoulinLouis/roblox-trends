import { describe, expect, it } from "vitest";
import { digestDue } from "./digest-time";

const at = (value: string) => new Date(value);

describe("digestDue", () => {
  it("waits for 08:00 Paris time in winter (UTC+1)", () => {
    expect(digestDue(at("2026-01-15T05:56:00Z"), null)).toBe(false); // 06:56
    expect(digestDue(at("2026-01-15T06:56:00Z"), null)).toBe(false); // 07:56
    expect(digestDue(at("2026-01-15T07:00:00Z"), null)).toBe(true); // 08:00
    expect(digestDue(at("2026-01-15T07:56:00Z"), null)).toBe(true); // 08:56
  });

  it("waits for 08:00 Paris time in summer (UTC+2)", () => {
    expect(digestDue(at("2026-07-15T05:56:00Z"), null)).toBe(false); // 07:56
    expect(digestDue(at("2026-07-15T06:56:00Z"), null)).toBe(true); // 08:56
  });

  it("is not due again once sent after the hour on the same local day", () => {
    expect(digestDue(at("2026-07-15T07:56:00Z"), at("2026-07-15T06:56:00Z"))).toBe(false);
    expect(digestDue(at("2026-07-15T21:56:00Z"), at("2026-07-15T06:56:00Z"))).toBe(false);
  });

  it("is due the next local day", () => {
    expect(digestDue(at("2026-07-16T06:56:00Z"), at("2026-07-15T06:56:00Z"))).toBe(true);
  });

  it("does not count a send made before the hour of the same local day", () => {
    expect(digestDue(at("2026-07-15T07:56:00Z"), at("2026-07-15T04:00:00Z"))).toBe(true); // sent 06:00 Paris
  });

  it("uses the local day, not the UTC day, around midnight", () => {
    // 23:56 Paris on Jul 15 is 21:56 UTC; 00:56 Paris on Jul 16 is 22:56 UTC.
    expect(digestDue(at("2026-07-15T21:56:00Z"), null)).toBe(true);
    expect(digestDue(at("2026-07-15T22:56:00Z"), null)).toBe(false);
    expect(digestDue(at("2026-07-15T22:56:00Z"), at("2026-07-15T21:56:00Z"))).toBe(false);
    // The send at 23:56 Paris is the same local day as 21:56 UTC, not the next UTC day.
    expect(digestDue(at("2026-07-16T06:56:00Z"), at("2026-07-15T21:56:00Z"))).toBe(true);
  });
});
