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
