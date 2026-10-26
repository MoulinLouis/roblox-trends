import { describe, expect, it } from "vitest";
import { contentFingerprint, rawFingerprint, urlFingerprint } from "./fingerprint";

describe("fingerprints", () => {
  it("changes the raw fingerprint when only a promotional marker changes", () => {
    expect(rawFingerprint("[🎃] +1 Stone Skipping", "Skip stones")).not.toBe(rawFingerprint("+1 Stone Skipping", "Skip stones"));
  });

  it("separates the name from the description in the raw fingerprint", () => {
    expect(rawFingerprint("ab", "c")).not.toBe(rawFingerprint("a", "bc"));
  });

  it("keeps the content fingerprint when only markers, case or spacing change", () => {
    expect(contentFingerprint("[🎃 UPD] +1 Stone Skipping", "Skip  stones\n")).toBe(
      contentFingerprint("+1 Stone Skipping", "skip stones"),
    );
  });

  it("ignores the case of the name in the content fingerprint", () => {
    expect(contentFingerprint("+1 STONE SKIPPING", "")).toBe(contentFingerprint("+1 Stone Skipping", ""));
  });

  it("lowercases a capital I the same way with or without a stripped marker", () => {
    expect(contentFingerprint("[🎃] ISLAND Tycoon", "")).toBe(contentFingerprint("ISLAND Tycoon", ""));
  });

  it("changes the content fingerprint when the concept text changes", () => {
    expect(contentFingerprint("+1 Stone Skipping", "")).not.toBe(contentFingerprint("+1 Rock Throwing", ""));
  });

  it("hashes URLs deterministically", () => {
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toBe(urlFingerprint("https://tr.rbxcdn.com/a"));
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toHaveLength(40);
  });

  it("hashes different URLs differently", () => {
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).not.toBe(urlFingerprint("https://tr.rbxcdn.com/b"));
  });

  // Stored fingerprints never change across hosts, and content fingerprints change only with
  // CONTENT_FINGERPRINT_VERSION. Version 2 ignores bracketed text in titles.
  it("keeps stored fingerprint values stable", () => {
    expect(rawFingerprint("+1 Stone Skipping", "Skip stones")).toBe("8a5794c48ac7989708062a262843068792207752");
    expect(contentFingerprint("+1 Stone Skipping", "Skip stones")).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
    expect(contentFingerprint("[⏳ 2H] +1 Stone Skipping", "Skip stones")).toBe("f52b742d46d5d0fdd4da1893313c9c03a6210d47");
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toBe("fbfe1d0b88393007bea8c86d66dd83499d9b98ea");
  });
});
