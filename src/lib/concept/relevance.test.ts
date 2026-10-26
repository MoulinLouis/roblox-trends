import { describe, expect, it } from "vitest";
import { isRelevant, relevanceWords } from "./relevance";

describe("relevanceWords", () => {
  it("folds plurals and keeps every phrase's words", () => {
    expect(relevanceWords(["stone skipping", "skip stones"])).toEqual(new Set(["stone", "skipping", "skip"]));
  });

  it("ignores +N tokens, which every +1 game shares", () => {
    expect(relevanceWords(["+1 stone skipping"])).toEqual(new Set(["stone", "skipping"]));
  });
});

describe("isRelevant", () => {
  it.each([
    [{ name: "Skip A Stone", description: "" }, true],
    [{ name: "Rock Toss", description: "Skip stones on the lake" }, true],
    [{ name: "Egg Tycoon", description: "Hatch eggs" }, false],
  ])("matches the title or the description: %o", (text, expected) => {
    expect(isRelevant(text, relevanceWords(["stone skipping", "skip stones"]))).toBe(expected);
  });
});

// Scripts without spaces between words, and two-letter Korean or Chinese words, which titleWords drops.
describe("relevance in Chinese, Japanese and Korean", () => {
  it("keeps short words of these scripts", () => {
    expect(relevanceWords(["타일"])).toEqual(new Set(["타일"]));
  });

  it.each([
    [["타일"], "시퀀스 타일", true],
    [["打水漂"], "打水漂模拟器", true],
    [["水切り"], "水切りシミュレーター", true],
    [["打水漂"], "Egg Tycoon", false],
  ])("matches %o inside the title %s", (phrases, name, expected) => {
    expect(isRelevant({ name, description: "" }, relevanceWords(phrases))).toBe(expected);
  });
});

