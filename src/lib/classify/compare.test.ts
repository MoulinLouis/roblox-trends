import { describe, expect, it } from "vitest";
import { compareModels, normalizeValue, summarizeRun } from "./compare";
import { CLASSIFICATION_PROMPT_VERSION } from "./prompt";
import type { GameClassification } from "./schema";
import type { ClassificationInput, ClassificationModel, ClassificationUsage, ClassificationVocabulary, TrialResult } from "./types";

function input(universeId: number, name: string, stratum: string): ClassificationInput {
  return {
    universeId,
    name,
    description: "",
    genre: null,
    thumbnailUrl: null,
    robloxCreatedAt: "2026-10-01T00:00:00.000Z",
    peakCcu: 0,
    stratum,
  };
}

function classification(values: Partial<GameClassification>): GameClassification {
  return {
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
    ...values,
  };
}

// Opus: (1,000×4 + 200×20) / 1,000,000 / 2 = $0.004 a call in a batch; Haiku: (1,000×0.1 + 200×0.5) / 1,000,000 / 2 = $0.0001.
const usage: ClassificationUsage = { inputTokens: 1_000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function classified(model: ClassificationModel, universeId: number, values: Partial<GameClassification>, hadThumbnail = true): TrialResult {
  return { universeId, model, hadThumbnail, outcome: { ok: true, classification: classification(values), usage } };
}

function failed(model: ClassificationModel, universeId: number, error: string, withUsage = true): TrialResult {
  return { universeId, model, hadThumbnail: true, outcome: { ok: false, error, usage: withUsage ? usage : null } };
}

const opus = "claude-opus-5-5";
const haiku = "claude-haiku-5-5";

const inputs = [
  input(1, "Steal a Clown Egg", "steal"),
  input(2, "Bike For Egg!", "verb-for-reward"),
  input(3, "Fishing Luck", "young-100-1k"),
];

const opusAnswers = {
  1: { family: "Steal a", template: "Steal a {thing}", rewardLoop: "eggs", coreAction: "steal eggs" },
  2: { family: "{verb} for {reward}", template: "{verb} for {reward}", rewardLoop: "eggs", coreAction: "ride bikes" },
  3: { family: "fishing RNG", template: "{thing} RNG", rewardLoop: "catches", coreAction: "catch fish" },
};

const haikuAnswers = {
  1: { family: "steal a ", template: "Steal a {thing}", rewardLoop: "Eggs", coreAction: "steal  eggs" },
  2: { family: "{verb} for {reward}", template: "+1 {action} for {reward}", rewardLoop: "pets", coreAction: "ride bikes" },
};

const results: TrialResult[] = [
  classified(opus, 1, opusAnswers[1]),
  classified(opus, 2, opusAnswers[2]),
  classified(opus, 3, opusAnswers[3], false),
  classified(haiku, 1, haikuAnswers[1]),
  classified(haiku, 2, haikuAnswers[2]),
  failed(haiku, 3, "refused (cyber)"),
];

describe("normalizeValue", () => {
  it("ignores case, outer spaces and repeated inner spaces", () => {
    expect(normalizeValue("  Steal \t A\n{thing} ")).toBe("steal a {thing}");
  });
});

describe("compareModels", () => {
  const comparison = compareModels(inputs, results, [opus, haiku]);

  it("records the prompt version", () => {
    expect(comparison.promptVersion).toBe(CLASSIFICATION_PROMPT_VERSION);
  });

  // Game 3 failed for Haiku, so two games are compared.
  it("measures agreement over the games both models classified", () => {
    expect(comparison.agreement).toEqual([
      { field: "family", compared: 2, agreed: 2, share: 1 },
      { field: "template", compared: 2, agreed: 1, share: 0.5 },
      { field: "rewardLoop", compared: 2, agreed: 1, share: 0.5 },
      { field: "coreAction", compared: 2, agreed: 2, share: 1 },
      { field: "format", compared: 2, agreed: 1, share: 0.5 },
    ]);
  });

  it("lists each disagreement with the fields that differ and both answers", () => {
    expect(comparison.disagreements).toEqual([
      {
        universeId: 2,
        name: "Bike For Egg!",
        stratum: "verb-for-reward",
        fields: ["template", "rewardLoop", "format"],
        answers: [classification(opusAnswers[2]), classification(haikuAnswers[2])],
      },
    ]);
  });

  it("summarizes each model's run", () => {
    const [first, second] = comparison.models;
    const { costUsd: firstCost, costPerGameUsd: firstCostPerGame, ...firstRest } = first;
    expect(firstRest).toEqual({
      model: opus,
      games: 3,
      classified: 3,
      failures: [],
      withoutThumbnail: 1,
      newValues: { family: [{ value: "fishing RNG", games: 1 }], template: [], rewardLoop: [] },
    });
    expect(firstCost).toBeCloseTo(0.012, 10);
    expect(firstCostPerGame).toBeCloseTo(0.004, 10);

    // The refused game is billed and counts in the cost, not in the games classified. The cost per game divides by
    // every game, as a full run attempts every game.
    const { costUsd: secondCost, costPerGameUsd: secondCostPerGame, ...secondRest } = second;
    expect(secondRest).toEqual({
      model: haiku,
      games: 3,
      classified: 2,
      failures: [{ universeId: 3, error: "refused (cyber)" }],
      withoutThumbnail: 0,
      newValues: { family: [], template: [], rewardLoop: [] },
    });
    expect(secondCost).toBeCloseTo(0.0003, 12);
    expect(secondCostPerGame).toBeCloseTo(0.0001, 12);
  });

  it("follows the order of the models it is given", () => {
    const swapped = compareModels(inputs, results, [haiku, opus]);
    expect(swapped.models.map((summary) => summary.model)).toEqual([haiku, opus]);
    expect(swapped.disagreements[0].answers).toEqual([classification(haikuAnswers[2]), classification(opusAnswers[2])]);
  });

  it("orders disagreements by universe id, and keeps format out when only the core action differs", () => {
    const later = input(20, "Skip Stones", "plus-one");
    const earlier = input(10, "+1 Stone Skipping", "plus-one");
    const comparison = compareModels(
      [later, earlier],
      [
        classified(opus, 20, { coreAction: "skip stones" }),
        classified(opus, 10, { coreAction: "skip stones" }),
        classified(haiku, 20, { coreAction: "throw stones" }),
        classified(haiku, 10, { coreAction: "throw stones" }),
      ],
      [opus, haiku],
    );
    expect(comparison.disagreements.map((row) => [row.universeId, row.fields])).toEqual([
      [10, ["coreAction"]],
      [20, ["coreAction"]],
    ]);
  });

  it("has no agreement share when no game was classified by both models", () => {
    const comparison = compareModels(inputs, [classified(opus, 1, {}), failed(haiku, 1, "expired", false)], [opus, haiku]);
    expect(comparison.agreement.map((row) => [row.field, row.compared, row.agreed, row.share])).toEqual([
      ["family", 0, 0, null],
      ["template", 0, 0, null],
      ["rewardLoop", 0, 0, null],
      ["coreAction", 0, 0, null],
      ["format", 0, 0, null],
    ]);
    expect(comparison.disagreements).toEqual([]);
  });
});

describe("summarizeRun", () => {
  it("counts a game without a result as failed", () => {
    const summary = summarizeRun(haiku, inputs, [classified(haiku, 1, {}), classified(opus, 2, {})]);
    expect(summary.classified).toBe(1);
    expect(summary.failures).toEqual([
      { universeId: 2, error: "no result" },
      { universeId: 3, error: "no result" },
    ]);
  });

  it("divides the cost by every game, even when nothing was classified", () => {
    const summary = summarizeRun(opus, inputs, [failed(opus, 1, "ran out of tokens"), failed(opus, 2, "expired", false)]);
    expect(summary.classified).toBe(0);
    expect(summary.costUsd).toBeCloseTo(0.004, 10);
    expect(summary.costPerGameUsd).toBeCloseTo(0.004 / 3, 10);
  });

  it("has no cost per game without games", () => {
    const summary = summarizeRun(opus, [], []);
    expect(summary.costUsd).toBe(0);
    expect(summary.costPerGameUsd).toBeNull();
  });

  it("counts each new value once per game, as first written, most used first", () => {
    const games = [1, 2, 3, 4, 5].map((universeId) => input(universeId, `Game ${universeId}`, "young-under-100"));
    const summary = summarizeRun(opus, games, [
      classified(opus, 1, { family: "Zoo keeper", rewardLoop: "animals" }),
      classified(opus, 2, { family: "Fishing RNG", rewardLoop: "animals" }),
      classified(opus, 3, { family: "fishing  rng", template: "{thing} Fishing" }),
      classified(opus, 4, { family: "anime fighter" }),
      classified(opus, 5, { family: "OBBY", template: "+1 {THING}", rewardLoop: " Pets" }),
    ]);
    expect(summary.newValues).toEqual({
      family: [
        { value: "Fishing RNG", games: 2 },
        { value: "anime fighter", games: 1 },
        { value: "Zoo keeper", games: 1 },
      ],
      template: [{ value: "{thing} Fishing", games: 1 }],
      rewardLoop: [{ value: "animals", games: 2 }],
    });
  });

  it("checks new values against the vocabulary it is given", () => {
    const vocabulary: ClassificationVocabulary = {
      families: [{ value: "Fishing RNG", meaning: "Fish for rarities.", examples: ["Fisch"] }],
      templates: [],
      rewardLoops: [],
    };
    const summary = summarizeRun(opus, inputs.slice(0, 1), [classified(opus, 1, { family: "fishing rng" })], vocabulary);
    expect(summary.newValues).toEqual({
      family: [],
      template: [{ value: "+1 {thing}", games: 1 }],
      rewardLoop: [{ value: "stats", games: 1 }],
    });
  });
});
