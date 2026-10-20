import { describe, expect, it } from "vitest";
import { normalizeTitle } from "./title";

describe("normalizeTitle", () => {
  it("removes emoji and promotional markers without losing the concept", () => {
    expect(normalizeTitle("[🔥 UPDATE 2] 🐒 +1 Speed Monkey Escape!")).toBe("+1 Speed Monkey Escape");
  });

  it("keeps meaningful bracketed text", () => {
    expect(normalizeTitle("[Horror] Kitty House")).toBe("Horror Kitty House");
  });

  it("drops an emoji-only seasonal marker", () => {
    expect(normalizeTitle("[🎃] +1 Stone Skipping")).toBe("+1 Stone Skipping");
  });
});
