import { describe, expect, it } from "vitest";
import { selectSearchTerms } from "./explore";

describe("selectSearchTerms", () => {
  it("returns the most shared meaningful title words", () => {
    expect(selectSearchTerms(["Steal An Egg", "Break and Steal an Egg", "[🎃] +1 Stone Skipping", "Egg Obby"], 2)).toEqual([
      "egg",
      "steal",
    ]);
  });

  it("ignores generic format words and numbers", () => {
    expect(selectSearchTerms(["Tycoon Simulator 2", "Obby 99"], 5)).toEqual([]);
  });

  it("counts a word once per title", () => {
    expect(selectSearchTerms(["Egg Egg Hunt", "Bunny Hunt"], 5)).toEqual(["hunt"]);
  });

  it("keeps every meaningful word of a single title, ties in alphabetical order", () => {
    expect(selectSearchTerms(["[UPDATE] Grow a Garden"], 5)).toEqual(["garden", "grow"]);
  });
});
