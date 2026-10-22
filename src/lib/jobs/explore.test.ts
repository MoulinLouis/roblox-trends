import { describe, expect, it } from "vitest";
import { rankSearchTerms, termSearchTimes, titleVocabulary, type VocabularyWord } from "./explore";

const terms = (vocabulary: VocabularyWord[]) => vocabulary.map((entry) => entry.term);

describe("titleVocabulary", () => {
  it("lists the meaningful title words, most shared first", () => {
    expect(titleVocabulary(["Steal An Egg", "Break and Steal an Egg", "[🎃] Stone Skipping", "Egg Obby"], 2)).toEqual([
      { word: "egg", term: "egg", titles: 3 },
      { word: "steal", term: "steal", titles: 2 },
    ]);
  });

  it("requires a word to be shared by the minimum number of titles", () => {
    expect(terms(titleVocabulary(["Steal An Egg", "Break and Steal an Egg", "[🎃] Stone Skipping", "Egg Obby"], 3))).toEqual(["egg"]);
  });

  it("lowers the minimum to the number of titles available", () => {
    expect(terms(titleVocabulary(["Steal An Egg", "Egg Farm"], 3))).toEqual(["egg"]);
    expect(terms(titleVocabulary(["[UPDATE] Grow a Garden"], 3))).toEqual(["garden", "grow"]);
  });

  it("ignores generic format words, function words and numbers", () => {
    expect(terms(titleVocabulary(["Tycoon Simulator 2", "Obby 99", "New Games", "Clean All the Leaves", "Clean all of it"], 2))).toEqual([
      "clean",
    ]);
  });

  it("keeps a plus and a number as a word: the +1 formats share it", () => {
    // On 2026-10-22, "+1" was the third most shared word of the young games, and a search for it listed +1 Slinky Escape.
    expect(terms(titleVocabulary(["+1 Slinky Escape", "[W4] +1 Paper Plane", "[🎃] +1 Speed Every Second", "+100 Jump"], 2))).toEqual([
      "+1",
    ]);
  });

  it("counts a word once per title", () => {
    expect(terms(titleVocabulary(["Egg Egg Hunt", "Bunny Hunt"], 2))).toEqual(["hunt"]);
  });

  it("splits words joined by hyphens", () => {
    expect(terms(titleVocabulary(["Steal-a-Brainrot", "Steal a Brainrot Simulator", "Brainrot Evolution"], 2))).toEqual([
      "brainrot",
      "steal",
    ]);
  });

  it("folds plurals and possessives into one word", () => {
    // "boss" ends in a double s: it is not a plural.
    expect(terms(titleVocabulary(["Eggs vs Boss", "EGG Boss", "Egg's Boss"], 3))).toEqual(["boss", "egg"]);
  });

  it("searches the most common form of a word, so a folded word that is not a plural keeps its spelling", () => {
    expect(titleVocabulary(["Chaos Tower", "Tower of Chaos", "Chaos Obby"], 3)).toEqual([
      { word: "chao", term: "chaos", titles: 3 },
    ]);
    expect(terms(titleVocabulary(["Brainrots Merge", "Brainrot Evolution", "Steal a Brainrot"], 3))).toEqual(["brainrot"]);
  });
});

describe("rankSearchTerms", () => {
  const now = new Date("2026-10-22T18:26:30Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const vocabulary: VocabularyWord[] = [
    { word: "egg", term: "egg", titles: 96 },
    { word: "steal", term: "steal", titles: 86 },
    { word: "+1", term: "+1", titles: 44 },
    { word: "chop", term: "chop", titles: 3 },
    { word: "plane", term: "plane", titles: 2 },
  ];

  it("orders terms never searched by how many titles share them", () => {
    expect(terms(rankSearchTerms(vocabulary, new Map(), now, 24))).toEqual(["egg", "steal", "+1", "chop", "plane"]);
  });

  it("puts a term just searched behind the others until its titles times the hours since catch up", () => {
    // egg: 96 × 1 = 96; steal: 86 × 2 = 172; +1 and chop never: 44 × 24 and 3 × 24; plane: 2 × 24.
    const searched = new Map([
      ["egg", hoursAgo(1)],
      ["steal", hoursAgo(2)],
    ]);
    expect(terms(rankSearchTerms(vocabulary, searched, now, 24))).toEqual(["+1", "steal", "egg", "chop", "plane"]);
  });

  it("caps the hours, so an old search counts like no search", () => {
    const searched = new Map([["chop", hoursAgo(100)]]);
    expect(rankSearchTerms(vocabulary, searched, now, 24)).toEqual(rankSearchTerms(vocabulary, new Map(), now, 24));
  });
});

describe("termSearchTimes", () => {
  it("keys searched terms by their folded word and keeps the latest search of any spelling", () => {
    const times = termSearchTimes(
      new Map([
        ["eggs", new Date("2026-10-22T03:00:00Z")],
        ["egg", new Date("2026-10-22T02:00:00Z")],
        ["+1", new Date("2026-10-22T01:00:00Z")],
      ]),
    );
    expect(times).toEqual(
      new Map([
        ["egg", new Date("2026-10-22T03:00:00Z")],
        ["+1", new Date("2026-10-22T01:00:00Z")],
      ]),
    );
  });
});
