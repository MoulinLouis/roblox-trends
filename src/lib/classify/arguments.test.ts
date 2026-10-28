import { describe, expect, it } from "vitest";
import { CLASSIFICATION_TRIAL_USAGE, parseTrialArguments } from "./arguments";

describe("parseTrialArguments", () => {
  it("reads two models to compare", () => {
    expect(
      parseTrialArguments(["--trial", "comparison", "--dir", ".data/classification/comparison-1", "--models", "claude-opus-5-5,claude-sonnet-5-5"]),
    ).toEqual({
      trial: "comparison",
      dir: ".data/classification/comparison-1",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      exclude: [],
    });
  });

  it("reads one model and repeated exclusions", () => {
    expect(
      parseTrialArguments([
        "--trial=review",
        "--dir=review-2",
        "--models",
        "claude-haiku-5-5",
        "--exclude",
        "comparison-1",
        "--exclude",
        "review-1",
      ]),
    ).toEqual({ trial: "review", dir: "review-2", models: ["claude-haiku-5-5"], exclude: ["comparison-1", "review-1"] });
  });

  it("keeps the models in the order given", () => {
    expect(parseTrialArguments(["--trial", "comparison", "--dir", "d", "--models", "claude-haiku-5-5,claude-opus-5-5"]).models).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
  });

  it.each([
    [[], /--trial is required/],
    [["--trial", "comparison", "--dir", "d"], /--models is required/],
    [["--trial", "comparison", "--dir", "d", "--models", "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5"], /--models takes one model, or two to compare/],
    [["--dir", "d"], /--trial is required/],
    [["--trial", "comparison"], /--dir is required/],
    [["--trial", "comparison", "--dir", ""], /--dir is required/],
    [["--trial", "full", "--dir", "d"], /Unknown trial: full \(comparison or review\)/],
    [["--trial", "toString", "--dir", "d"], /Unknown trial: toString/],
    [["--trial", "comparison", "--dir", "d", "--models", "claude-sonnet-4-6"], /Unknown model: claude-sonnet-4-6 \(claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5\)/],
    [["--trial", "comparison", "--dir", "d", "--models", "claude-opus-5-5,"], /Unknown model: /],
    [["--trial", "comparison", "--dir", "d", "--models", "claude-opus-5-5,claude-opus-5-5"], /claude-opus-5-5 is given more than once/],
    [["--trial", "comparison", "--dir", "d", "--exclude", ""], /--exclude needs a directory/],
    [["--trial", "comparison", "--trial", "review", "--dir", "d"], /--trial is given more than once/],
    [["--trial", "comparison", "--dir", "d", "--dir", "e"], /--dir is given more than once/],
    [["--trial", "comparison", "--dir", "d", "--models", "claude-opus-5-5", "--models", "claude-haiku-5-5"], /--models is given more than once/],
    [["--trial", "comparison", "--dir", "d", "--dry-run"], /Unknown option '--dry-run'/],
    [["--trial", "comparison", "--dir"], /--dir <value>' argument missing/],
    [["--trial", "comparison", "--dir", "d", "extra"], /Unexpected argument 'extra'/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseTrialArguments(argv)).toThrow(message);
  });
});

describe("CLASSIFICATION_TRIAL_USAGE", () => {
  it("names the trials and the models", () => {
    expect(CLASSIFICATION_TRIAL_USAGE).toBe(
      [
        "Usage: npm run classify:trial -- --trial comparison|review --dir <directory> --models <model>[,<model>] [--exclude <directory>]...",
        "Models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 (one, or two compared in the order given)",
      ].join("\n"),
    );
  });
});
