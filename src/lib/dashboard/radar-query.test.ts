import { describe, expect, it } from "vitest";
import { RADAR_CONFIG } from "@/lib/config";
import { parseRadarQuery, toDateTimeInput } from "./radar-query";

const now = new Date("2026-10-22T18:00:00Z");

describe("parseRadarQuery", () => {
  it("falls back to the defaults", () => {
    expect(parseRadarQuery({}, now)).toEqual({
      maxAgeDays: RADAR_CONFIG.defaultAgeDays,
      minimumCcu: RADAR_CONFIG.defaultMinimumCcu,
      sort: "growth",
      asOf: null,
    });
  });

  it("accepts the configured options", () => {
    expect(parseRadarQuery({ age: "90", minCcu: "1000", sort: "acceleration", asOf: "2026-09-29T12:00" }, now)).toEqual({
      maxAgeDays: 90,
      minimumCcu: 1_000,
      sort: "acceleration",
      asOf: new Date("2026-09-29T12:00:00Z"),
    });
  });

  it("ignores values outside the options and takes the first of repeated parameters", () => {
    expect(parseRadarQuery({ age: "7", minCcu: "-1", sort: "score" }, now)).toMatchObject({
      maxAgeDays: RADAR_CONFIG.defaultAgeDays,
      minimumCcu: RADAR_CONFIG.defaultMinimumCcu,
      sort: "growth",
    });
    expect(parseRadarQuery({ age: ["14", "90"] }, now).maxAgeDays).toBe(14);
  });

  it("reads asOf as UTC and refuses malformed or future instants", () => {
    expect(parseRadarQuery({ asOf: "2026-10-22T19:00" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "2026-02-30T10:00" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "yesterday" }, now).asOf).toBeNull();
    expect(parseRadarQuery({ asOf: "" }, now).asOf).toBeNull();
  });

  it("formats an instant for a datetime-local input", () => {
    expect(toDateTimeInput(new Date("2026-09-29T12:05:41Z"))).toBe("2026-09-29T12:05");
  });
});
