import { describe, expect, it } from "vitest";
import { CLASSIFICATION_OVERRIDES } from "./overrides";

describe("CLASSIFICATION_OVERRIDES", () => {
  // Two entries for one field would leave the applied value to the order of the list.
  it("has one entry per game and field", () => {
    const keys = CLASSIFICATION_OVERRIDES.map(({ universeId, field }) => `${universeId}:${field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("holds trimmed values with a reason and a date", () => {
    for (const override of CLASSIFICATION_OVERRIDES) {
      const label = `${override.universeId}:${override.field}`;
      expect(override.value, label).not.toBe("");
      expect(override.value, label).toBe(override.value.trim());
      expect(override.reason.trim(), label).not.toBe("");
      expect(override.decidedAt, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
