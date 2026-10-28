import { describe, expect, it } from "vitest";
import { classificationJsonSchema, gameClassificationSchema } from "./schema";

const answer = {
  reason: "The title starts with +1 and the stone skips further as the throw stat grows.",
  family: "+1",
  template: "+1 {thing}",
  rewardLoop: "stats",
  coreAction: "skip stones",
  theme: "stone skipping",
  setting: "lake",
  progression: "stat growth",
  social: "solo",
  confidence: "high",
};

describe("gameClassificationSchema", () => {
  it("parses a complete answer", () => {
    expect(gameClassificationSchema.parse(answer)).toEqual(answer);
  });

  it("rejects an extra key", () => {
    expect(gameClassificationSchema.safeParse({ ...answer, genre: "Simulation" }).success).toBe(false);
  });

  it("rejects a progression outside the list", () => {
    expect(gameClassificationSchema.safeParse({ ...answer, progression: "prestige" }).success).toBe(false);
  });
});

describe("classificationJsonSchema", () => {
  const order = ["reason", "family", "template", "rewardLoop", "coreAction", "theme", "setting", "progression", "social", "confidence"];

  it("allows no other key", () => {
    expect(classificationJsonSchema.additionalProperties).toBe(false);
  });

  // Structured outputs write the properties in schema order: the reason comes before the values it explains.
  it("requires every property, the reason first", () => {
    expect(classificationJsonSchema.required).toEqual(order);
    expect(Object.keys(classificationJsonSchema.properties as Record<string, unknown>)).toEqual(order);
  });

  it("has no $schema key", () => {
    expect(classificationJsonSchema).not.toHaveProperty("$schema");
  });
});
