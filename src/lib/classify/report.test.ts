import { describe, expect, it } from "vitest";
import type { ModelComparison, ModelRunSummary } from "./compare";
import { formatComparison, formatPending, formatRunSummary } from "./report";
import type { GameClassification } from "./schema";

function values(count: number): { value: string; games: number }[] {
  return Array.from({ length: count }, (_, index) => ({ value: `value ${index}`, games: 1 }));
}

function summary(overrides: Partial<ModelRunSummary>): ModelRunSummary {
  return {
    model: "claude-opus-5-5",
    games: 200,
    classified: 200,
    failures: [],
    withoutThumbnail: 3,
    costUsd: 0,
    costPerGameUsd: null,
    newValues: { family: [], template: [], rewardLoop: [] },
    ...overrides,
  };
}

const answer: GameClassification = {
  reason: "The title names the format.",
  family: "+1",
  template: "+1 {thing}",
  rewardLoop: "stats",
  coreAction: "skip stones",
  theme: "stones",
  setting: "lake",
  progression: "stat growth",
  social: "solo",
  confidence: "high",
};

function disagreements(count: number): ModelComparison["disagreements"] {
  return Array.from({ length: count }, (_, index) => ({
    universeId: index + 1,
    name: `Game ${index + 1}`,
    stratum: "plus-one",
    fields: ["coreAction"],
    answers: [answer, { ...answer, coreAction: "throw stones" }],
  }));
}

function agreement(agreed: Record<string, number>, compared: number): ModelComparison["agreement"] {
  return (["family", "template", "rewardLoop", "coreAction", "format"] as const).map((field) => ({
    field,
    compared,
    agreed: agreed[field],
    share: compared ? agreed[field] / compared : null,
  }));
}

describe("formatComparison", () => {
  it("prints the counts, agreement, costs, new values and disagreements", () => {
    const comparison: ModelComparison = {
      promptVersion: 1,
      models: [
        summary({
          costUsd: 2.91,
          costPerGameUsd: 0.0146,
          newValues: { family: values(4), template: values(9), rewardLoop: values(2) },
        }),
        summary({
          model: "claude-haiku-5-5",
          classified: 199,
          failures: [{ universeId: 7, error: "refusal" }],
          costUsd: 0.07,
          costPerGameUsd: 0.07 / 200,
          newValues: { family: values(6), template: values(12), rewardLoop: values(3) },
        }),
      ],
      agreement: agreement({ family: 176, template: 159, rewardLoop: 169, coreAction: 82, format: 143 }, 199),
      disagreements: disagreements(57),
    };

    expect(formatComparison(comparison, ".data/classification/comparison-1/comparison.json")).toBe(
      [
        "Comparison of claude-opus-5-5 and claude-haiku-5-5 on 200 games (prompt v1)",
        "Classified: claude-opus-5-5 200, claude-haiku-5-5 199 (1 failed); 3 without thumbnail",
        "Agreement: family 88% (176/199), template 80% (159/199), reward loop 85% (169/199), core action 41% (82/199), format 72% (143/199)",
        "Cost at batch prices: claude-opus-5-5 $2.91 ($0.0146 a game), claude-haiku-5-5 $0.07 ($0.0004 a game)",
        "New values: claude-opus-5-5 4 families, 9 templates, 2 reward loops; claude-haiku-5-5 6 families, 12 templates, 3 reward loops",
        "57 disagreements in .data/classification/comparison-1/comparison.json",
      ].join("\n"),
    );
  });

  it("uses the singular, names each model's games without thumbnail when they differ, and survives an empty run", () => {
    const comparison: ModelComparison = {
      promptVersion: 2,
      models: [
        summary({
          games: 1,
          classified: 1,
          withoutThumbnail: 1,
          costUsd: 0.004,
          costPerGameUsd: 0.004,
          newValues: { family: values(1), template: values(1), rewardLoop: values(1) },
        }),
        summary({ model: "claude-haiku-5-5", games: 1, classified: 0, failures: [{ universeId: 1, error: "no result" }], withoutThumbnail: 0 }),
      ],
      agreement: agreement({ family: 0, template: 0, rewardLoop: 0, coreAction: 0, format: 0 }, 0),
      disagreements: disagreements(1),
    };

    expect(formatComparison(comparison, "comparison.json")).toBe(
      [
        "Comparison of claude-opus-5-5 and claude-haiku-5-5 on 1 game (prompt v2)",
        "Classified: claude-opus-5-5 1, claude-haiku-5-5 0 (1 failed); claude-opus-5-5 1, claude-haiku-5-5 0 without thumbnail",
        "Agreement: family — (0/0), template — (0/0), reward loop — (0/0), core action — (0/0), format — (0/0)",
        "Cost at batch prices: claude-opus-5-5 $0.00 ($0.0040 a game), claude-haiku-5-5 $0.00",
        "New values: claude-opus-5-5 1 family, 1 template, 1 reward loop; claude-haiku-5-5 0 families, 0 templates, 0 reward loops",
        "1 disagreement in comparison.json",
      ].join("\n"),
    );
  });
});

describe("formatRunSummary", () => {
  it("prints one model's counts, cost and new values", () => {
    const run = summary({
      model: "claude-haiku-5-5",
      games: 100,
      classified: 98,
      failures: [
        { universeId: 1, error: "refusal" },
        { universeId: 2, error: "max_tokens" },
      ],
      withoutThumbnail: 2,
      costUsd: 0.041,
      costPerGameUsd: 0.041 / 100,
      newValues: { family: values(2), template: values(5), rewardLoop: values(0) },
    });

    expect(formatRunSummary(run, 1, ".data/classification/review-1/summary.json")).toBe(
      [
        "Run of claude-haiku-5-5 on 100 games (prompt v1)",
        "Classified: claude-haiku-5-5 98 (2 failed); 2 without thumbnail",
        "Cost at batch prices: claude-haiku-5-5 $0.04 ($0.0004 a game)",
        "New values: claude-haiku-5-5 2 families, 5 templates, 0 reward loops",
        "Summary in .data/classification/review-1/summary.json",
      ].join("\n"),
    );
  });
});

describe("formatPending", () => {
  it("names the models still processing", () => {
    expect(formatPending(["claude-opus-5-5", "claude-haiku-5-5"])).toBe(
      "Still processing: claude-opus-5-5, claude-haiku-5-5. Run the same command again to resume.",
    );
  });
});
