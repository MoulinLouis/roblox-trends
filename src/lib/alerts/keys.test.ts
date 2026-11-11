import { describe, expect, it } from "vitest";
import { patternKeys, wordFrequencies } from "./keys";
import type { GameFormat } from "./types";

const game = (overrides: Partial<GameFormat> = {}): GameFormat => ({
  name: "Ragdoll Physics 🩸",
  family: null,
  template: null,
  coreAction: null,
  ...overrides,
});

const frequencies = new Map([
  ["ragdoll", 115],
  ["physic", 42],
]);

describe("patternKeys", () => {
  it("names the folded words of the title", () => {
    expect(patternKeys(game(), frequencies, 16_000)).toEqual(["word:physic", "word:ragdoll"]);
  });

  it("drops a word carried by a single title and one carried by more than 1% of titles", () => {
    const counts = new Map([
      ["ragdoll", 1],
      ["physic", 160],
    ]);
    expect(patternKeys(game(), counts, 16_000)).toEqual(["word:physic"]);
    expect(patternKeys(game(), new Map([["ragdoll", 161], ["physic", 2]]), 16_000)).toEqual(["word:physic"]);
  });

  it("drops a word with no known frequency", () => {
    expect(patternKeys(game(), new Map(), 16_000)).toEqual([]);
  });

  it("names the gameplay of a classified game", () => {
    const keys = patternKeys(game({ family: "physics sandbox", coreAction: " Test  Ragdoll Physics" }), frequencies, 16_000);
    expect(keys).toContain("action:physics sandbox|test ragdoll physics");
  });

  it("names the template, except none", () => {
    expect(patternKeys(game({ template: "{thing} Battles" }), frequencies, 16_000)).toContain("template:{thing} battles");
    expect(patternKeys(game({ template: "none" }), frequencies, 16_000).some((k) => k.startsWith("template:"))).toBe(false);
    expect(patternKeys(game({ template: " None " }), frequencies, 16_000).some((k) => k.startsWith("template:"))).toBe(false);
    expect(patternKeys(game({ template: null }), frequencies, 16_000).some((k) => k.startsWith("template:"))).toBe(false);
  });

  it("gives only word keys with wordsOnly", () => {
    const keys = patternKeys(
      game({ family: "physics sandbox", coreAction: "test", template: "{thing} Battles" }),
      frequencies,
      16_000,
      { wordsOnly: true },
    );
    expect(keys).toEqual(["word:physic", "word:ragdoll"]);
  });

  it("gives only word keys to a game with no classification", () => {
    expect(patternKeys(game({ coreAction: "test" }), frequencies, 16_000).every((k) => k.startsWith("word:"))).toBe(true);
    expect(patternKeys(game({ family: "  ", coreAction: "test" }), frequencies, 16_000).every((k) => k.startsWith("word:"))).toBe(true);
  });

  it("returns sorted, unique keys", () => {
    const keys = patternKeys(game({ family: "a", coreAction: "b", template: "c" }), frequencies, 16_000);
    expect(keys).toEqual([...new Set(keys)].sort());
  });
});

describe("wordFrequencies", () => {
  it("counts the titles carrying each folded word, once per title", () => {
    const counts = wordFrequencies(["Ragdoll Soccer", "RAGDOLL physics", "Steal a Brainrot", "Ragdoll Ragdoll"]);
    expect(counts.get("ragdoll")).toBe(3);
    expect(counts.get("soccer")).toBe(1);
    expect(counts.get("physic")).toBe(1);
  });
});
