import { describe, expect, it } from "vitest";
import { classifyGame, normalizeTitle } from "./classification";
import { DEFAULT_SETTINGS } from "./config";
import { extractTitlePhrases } from "./analysis";

describe("normalizeTitle", () => {
  it("removes emoji and promotional markers without losing the concept", () => {
    expect(normalizeTitle("[🔥 UPDATE 2] 🐒 +1 Speed Monkey Escape!"))
      .toBe("+1 Speed Monkey Escape");
  });

  it("keeps meaningful bracketed text", () => {
    expect(normalizeTitle("[Horror] Kitty House")).toBe("Horror Kitty House");
  });
});

describe("classifyGame", () => {
  it("classifies independent concept dimensions and aliases", () => {
    const tags = classifyGame(
      "Steal a Monkey Factory",
      "Train every second, open a luck block, then raid a rival base.",
      DEFAULT_SETTINGS.taxonomy,
    );
    expect(tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "coreLoop", tag: "Steal" }),
      expect.objectContaining({ dimension: "coreLoop", tag: "Tycoon" }),
      expect.objectContaining({ dimension: "progression", tag: "+1 per second" }),
      expect.objectContaining({ dimension: "reward", tag: "Lucky Block" }),
      expect.objectContaining({ dimension: "social", tag: "Raid" }),
      expect.objectContaining({ dimension: "theme", tag: "Monkey" }),
    ]));
  });

  it("does not match aliases inside unrelated words", () => {
    const tags = classifyGame("Trainyard", "A railway management game.", DEFAULT_SETTINGS.taxonomy);
    expect(tags.some((tag) => tag.tag === "Training")).toBe(false);
  });
});

describe("title phrase extraction", () => {
  it("extracts meaningful short phrases while excluding promotional noise", () => {
    const phrases = extractTitlePhrases("[UPDATE] Dig and Clean the House");
    expect(phrases).toEqual(expect.arrayContaining(["dig", "clean", "clean house"]));
    expect(phrases).not.toContain("update");
    expect(phrases).not.toContain("the");
  });
});
