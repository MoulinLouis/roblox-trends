import { describe, expect, it } from "vitest";
import { contentFingerprint, rawFingerprint, urlFingerprint } from "./fingerprint";

describe("fingerprints", () => {
  it("changes the raw fingerprint when only a promotional marker changes", () => {
    expect(rawFingerprint("[🎃] +1 Stone Skipping", "Skip stones")).not.toBe(rawFingerprint("+1 Stone Skipping", "Skip stones"));
  });

  it("keeps the content fingerprint when only markers, case or spacing change", () => {
    expect(contentFingerprint("[🎃 UPD] +1 Stone Skipping", "Skip  stones\n")).toBe(
      contentFingerprint("+1 Stone Skipping", "skip stones"),
    );
  });

  it("changes the content fingerprint when the concept text changes", () => {
    expect(contentFingerprint("+1 Stone Skipping", "")).not.toBe(contentFingerprint("+1 Rock Throwing", ""));
  });

  it("hashes URLs deterministically", () => {
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toBe(urlFingerprint("https://tr.rbxcdn.com/a"));
    expect(urlFingerprint("https://tr.rbxcdn.com/a")).toHaveLength(40);
  });
});
