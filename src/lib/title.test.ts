import { describe, expect, it } from "vitest";
import { normalizeTitle, titleText } from "./title";

describe("normalizeTitle", () => {
  it("removes emoji and promotional markers without losing the concept", () => {
    expect(normalizeTitle("[🔥 UPDATE 2] 🐒 +1 Speed Monkey Escape!")).toBe("+1 Speed Monkey Escape");
  });

  it("drops an emoji-only seasonal marker", () => {
    expect(normalizeTitle("[🎃] +1 Stone Skipping")).toBe("+1 Stone Skipping");
  });

  // Titles seen in production between 2026-10-22 and 2026-10-26: brackets carry countdowns, versions and update names.
  it.each([
    ["[⏳ 3H] [UPD] Create Pottery!", "Create Pottery"],
    ["[UPD2 🍄] Depth Incremental", "Depth Incremental"],
    ["[WORLD 4] [NOW 🎃] +1 Anime Evolution", "+1 Anime Evolution"],
    ["[LUFFY👒] Sailor Piece", "Sailor Piece"],
    ["Build a Base and Steal [30 MIN]", "Build a Base and Steal"],
    ["(4 HOURS!) Quad Life!", "Quad Life"],
    ["Toolbox Model Sandbox {👀}", "Toolbox Model Sandbox"],
    ["[Horror] Kitty House", "Kitty House"],
    ["[CH2] Chop A Forest", "Chop A Forest"],
  ])("drops bracketed text, where titles carry their announcements: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["[Alphabet Lore]", "Alphabet Lore"],
    ["[UPD] [Eventide]", "Eventide"],
  ])("keeps the brackets that are not markers when the title has nothing else: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
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
    ["UPDATE! Swing For Eggs", "Swing For Eggs"],
    ["NEW: Pet Sim", "Pet Sim"],
    ["UPD Build a PC", "Build a PC"],
    ["🔥UPDATE! Swing For Eggs", "Swing For Eggs"],
    ["[UPD] NEW: Pet Sim", "Pet Sim"],
    ["UPDATE - Swing For Eggs", "Swing For Eggs"],
    ["✨UPDATE ✨ | 🦑 SQUID PROJECT 🦑", "SQUID PROJECT"],
  ])("strips a leading marker followed by punctuation or written in capitals: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["UPDATE 2! Swing For Eggs", "Swing For Eggs"],
    ["UPD 2.5 Build a PC", "Build a PC"],
    ["UPD3: Pet Sim", "Pet Sim"],
    ["UPD v2 Pet Sim", "Pet Sim"],
    ["UPDATE 2 - Swing For Eggs", "Swing For Eggs"],
  ])("strips the version that follows a leading update marker: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["NEW 2 Player Obby", "2 Player Obby"],
    ["UPD 2 Player Obby", "2 Player Obby"],
    ["UPDATE 99 Nights in the Forest", "99 Nights in the Forest"],
  ])("keeps a number that starts the name after a leading marker: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["UPDATE! NEW: Pet Sim", "Pet Sim"],
    ["NEW! UPD 3! BETA: Pet Sim", "Pet Sim"],
  ])("strips several leading markers: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["Iron Skies - Beta", "Iron Skies"],
    ["Swing For Eggs | UPDATE 2", "Swing For Eggs"],
    ["Pet Sim | NEW UPD!", "Pet Sim"],
    ["Pet Sim | UPD - Beta", "Pet Sim"],
  ])("strips trailing markers after a bar or a spaced dash: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["كيبورد العرب | Arabian Keyboard +1", "كيبورد العرب Arabian Keyboard +1"],
    ["Mafia - The Code", "Mafia - The Code"],
  ])("keeps a trailing segment that is not only markers: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });

  it.each([
    ["UPDATE!", "UPDATE"],
    ["[NEW]", "NEW"],
  ])("falls back to the emoji-free title when markers leave nothing: %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });
});

describe("titleText", () => {
  it.each([
    ["[Sprunki] Morphs", "Sprunki Morphs"],
    ["[UPD 3] [Sprunki] Morphs | BETA", "Sprunki Morphs"],
    ["[🎃] +1 Stone Skipping", "+1 Stone Skipping"],
  ])("keeps the bracketed words that are not markers: %s", (title, expected) => {
    expect(titleText(title)).toBe(expected);
  });
});
