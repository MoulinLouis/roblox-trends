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

  it.each([
    ["New York Roleplay", "New York Roleplay"],
    ["Alpha Strike", "Alpha Strike"],
    ["Code Breakers", "Code Breakers"],
    ["Release the Kraken", "Release the Kraken"],
    ["New-Gen Tycoon", "New-Gen Tycoon"],
    ["NEW YORK ROLEPLAY", "NEW YORK ROLEPLAY"],
    ["CODE BREAKERS", "CODE BREAKERS"],
  ])("keeps a leading marker word that belongs to the name: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["[Alphabet Lore] Morphs", "Alphabet Lore Morphs"],
    ["(Renewal) Fish Simulator", "Renewal Fish Simulator"],
    ["[Eventide] Survival", "Eventide Survival"],
    ["[CH2] Chop A Forest", "CH2 Chop A Forest"],
  ])("keeps bracketed text that only contains a marker inside a word: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["[UPDATE] Swing For Eggs", "Swing For Eggs"],
    ["[🎃 UPD] +1 Stone Skipping", "+1 Stone Skipping"],
    ["[HALLOWEEN🎃] Monopoly", "Monopoly"],
  ])("removes a bracketed promotional or seasonal marker: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["UPDATE! Swing For Eggs", "Swing For Eggs"],
    ["NEW: Pet Sim", "Pet Sim"],
    ["UPD Build a PC", "Build a PC"],
    ["🔥UPDATE! Swing For Eggs", "Swing For Eggs"],
    ["[UPD] NEW: Pet Sim", "Pet Sim"],
    ["UPDATE - Swing For Eggs", "Swing For Eggs"],
  ])("strips a leading marker followed by punctuation or written in capitals: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });
});
