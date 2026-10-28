import { describe, expect, it } from "vitest";
import { classificationCostUsd } from "./cost";
import type { ClassificationUsage } from "./types";

const usage: ClassificationUsage = {
  inputTokens: 3_000,
  outputTokens: 500,
  cacheReadInputTokens: 2_000,
  cacheCreationInputTokens: 1_000,
};

describe("classificationCostUsd", () => {
  // (3,000×4 + 500×20 + 2,000×0.2 + 1,000×4×1.25) / 1,000,000
  it("prices Opus tokens, a five-minute cache write at 1.25 times the input price", () => {
    expect(classificationCostUsd("claude-opus-5-5", usage, { batch: false })).toBeCloseTo(0.0274, 10);
  });

  it("bills half in a batch", () => {
    expect(classificationCostUsd("claude-opus-5-5", usage, { batch: true })).toBeCloseTo(0.0137, 10);
  });

  // (3,000×0.1 + 500×0.5 + 2,000×0.01 + 1,000×0.1×1.25) / 1,000,000
  it("prices Haiku tokens", () => {
    expect(classificationCostUsd("claude-haiku-5-5", usage, { batch: false })).toBeCloseTo(0.000695, 12);
    expect(classificationCostUsd("claude-haiku-5-5", usage, { batch: true })).toBeCloseTo(0.0003475, 12);
  });

  it("costs nothing without tokens", () => {
    const none = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    expect(classificationCostUsd("claude-opus-5-5", none, { batch: true })).toBe(0);
  });
});
