import { describe, expect, it } from "vitest";
import type { ClassificationVocabulary } from "./types";
import { CLASSIFICATION_VOCABULARY } from "./vocabulary";

const lists = Object.entries(CLASSIFICATION_VOCABULARY) as [keyof ClassificationVocabulary, ClassificationVocabulary[keyof ClassificationVocabulary]][];

function values(list: keyof ClassificationVocabulary): string[] {
  return CLASSIFICATION_VOCABULARY[list].map((entry) => entry.value);
}

describe("CLASSIFICATION_VOCABULARY", () => {
  it.each(lists)("has no two %s values that differ only by case", (_list, entries) => {
    const folded = entries.map((entry) => entry.value.toLowerCase());
    expect(new Set(folded).size).toBe(folded.length);
  });

  it.each(lists)("gives every %s value a meaning and an example", (_list, entries) => {
    for (const entry of entries) {
      expect(entry.meaning.trim(), entry.value).not.toBe("");
      expect(entry.examples.length, entry.value).toBeGreaterThan(0);
    }
  });

  it("has a fallback in every list", () => {
    expect(values("families")).toContain("other");
    expect(values("templates")).toContain("none");
    expect(values("rewardLoops")).toContain("none");
  });

  // The waves the radar is built to catch.
  it("names the current waves", () => {
    expect(values("families")).toEqual(expect.arrayContaining(["+1", "Steal a", "{verb} for {reward}"]));
    // Eggs stay apart from pets, so the egg wave is not folded into every pet game.
    expect(values("rewardLoops")).toEqual(expect.arrayContaining(["eggs", "pets"]));
  });
});
