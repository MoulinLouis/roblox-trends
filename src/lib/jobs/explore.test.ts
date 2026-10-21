import { describe, expect, it } from "vitest";
import { selectSearchTerms } from "./explore";

describe("selectSearchTerms", () => {
  it("returns the most shared meaningful title words", () => {
    expect(selectSearchTerms(["Steal An Egg", "Break and Steal an Egg", "[🎃] +1 Stone Skipping", "Egg Obby"], 2, 2)).toEqual([
      "egg",
      "steal",
    ]);
  });

  it("requires a term to be shared by the minimum number of titles", () => {
    expect(selectSearchTerms(["Steal An Egg", "Break and Steal an Egg", "[🎃] +1 Stone Skipping", "Egg Obby"], 5, 3)).toEqual(["egg"]);
  });

  it("accepts a word of one title when fewer titles than the minimum are available", () => {
    expect(selectSearchTerms(["Steal An Egg", "Egg Farm"], 5, 3)).toEqual(["egg", "farm", "steal"]);
    expect(selectSearchTerms(["[UPDATE] Grow a Garden"], 5, 3)).toEqual(["garden", "grow"]);
  });

  it("ignores generic format words and numbers", () => {
    expect(selectSearchTerms(["Tycoon Simulator 2", "Obby 99", "New Games"], 5, 3)).toEqual([]);
  });

  it("counts a word once per title", () => {
    expect(selectSearchTerms(["Egg Egg Hunt", "Bunny Hunt"], 5, 2)).toEqual(["hunt"]);
  });

  it("splits words joined by hyphens", () => {
    expect(selectSearchTerms(["Steal-a-Brainrot", "Steal a Brainrot Simulator", "Brainrot Evolution"], 5, 2)).toEqual([
      "brainrot",
      "steal",
    ]);
  });

  it("folds plurals and possessives into one word", () => {
    // "boss" ends in a double s: it is not a plural.
    expect(selectSearchTerms(["Eggs vs Boss", "EGG Boss", "Egg's Boss"], 5, 3)).toEqual(["boss", "egg"]);
  });

  it("searches the most common form of a word, so a folded word that is not a plural keeps its spelling", () => {
    expect(selectSearchTerms(["Chaos Tower", "Tower of Chaos", "Chaos Obby"], 5, 3)).toEqual(["chaos"]);
    expect(selectSearchTerms(["Brainrots Merge", "Brainrot Evolution", "Steal a Brainrot"], 5, 3)).toEqual(["brainrot"]);
  });
});
