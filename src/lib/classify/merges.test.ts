import { describe, expect, it } from "vitest";
import { CLASSIFICATION_MERGES, mergeKey, mergeProblems, type ClassificationMerge } from "./merges";

function merge(overrides: Partial<ClassificationMerge> = {}): ClassificationMerge {
  return {
    field: "family",
    from: "rhythm game",
    to: "rhythm",
    reason: "Near-duplicate.",
    decidedAt: "2026-11-11",
    ...overrides,
  };
}

describe("CLASSIFICATION_MERGES", () => {
  // Guards every later edit of the file.
  it("is valid", () => {
    expect(mergeProblems(CLASSIFICATION_MERGES)).toEqual([]);
  });
});

describe("mergeKey", () => {
  it("trims, collapses whitespace runs and lower-cases", () => {
    expect(mergeKey("  Rhythm \t Game ")).toBe("rhythm game");
    expect(mergeKey("{thing} RP")).toBe("{thing} rp");
  });
});

describe("mergeProblems", () => {
  it("accepts a valid list", () => {
    expect(mergeProblems([merge()])).toEqual([]);
  });

  it("reports a merge onto itself, whatever the case", () => {
    expect(mergeProblems([merge({ from: "Rhythm", to: "rhythm" })])).toHaveLength(1);
  });

  it("reports two merges of one field whose from differ only in case or spaces", () => {
    const problems = mergeProblems([
      merge({ from: "Rhythm Game", to: "rhythm" }),
      merge({ from: "rhythm  game", to: "music" }),
    ]);
    expect(problems).toHaveLength(1);
  });

  it("reports a chain", () => {
    const problems = mergeProblems([merge({ from: "a", to: "b" }), merge({ from: "b", to: "c" })]);
    expect(problems).toHaveLength(1);
  });

  it("reports a loop", () => {
    const problems = mergeProblems([merge({ from: "a", to: "b" }), merge({ from: "b", to: "a" })]);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("allows the same from in two fields", () => {
    expect(mergeProblems([merge({ field: "family" }), merge({ field: "template" })])).toEqual([]);
  });

  it("does not see a chain across fields", () => {
    expect(
      mergeProblems([merge({ field: "family", from: "a", to: "b" }), merge({ field: "template", from: "b", to: "c" })]),
    ).toEqual([]);
  });

  it("reports an empty from, to or reason", () => {
    expect(mergeProblems([merge({ from: " " })])).toHaveLength(1);
    expect(mergeProblems([merge({ to: "" })])).toHaveLength(1);
    expect(mergeProblems([merge({ reason: "  " })])).toHaveLength(1);
  });

  it("reports a decidedAt that is not YYYY-MM-DD", () => {
    expect(mergeProblems([merge({ decidedAt: "11/11/2026" })])).toHaveLength(1);
  });
});
