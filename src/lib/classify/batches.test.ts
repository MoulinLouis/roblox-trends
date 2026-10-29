import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { JOB_CONFIG } from "@/lib/config";
import { rejectedByApi } from "./batches";

describe("rejectedByApi", () => {
  it("accepts a 4xx answer only", () => {
    expect(rejectedByApi(Object.assign(new Error("Bad request"), { status: 400 }))).toBe(true);
    expect(rejectedByApi(Object.assign(new Error("Too many requests"), { status: 429 }))).toBe(true);
    expect(rejectedByApi(Object.assign(new Error("Overloaded"), { status: 529 }))).toBe(false);
    expect(rejectedByApi(Object.assign(new Error("Server error"), { status: 500 }))).toBe(false);
  });

  it("does not treat a timeout or a lost connection as a refusal, since the batch may exist", () => {
    expect(rejectedByApi(new APIConnectionTimeoutError())).toBe(false);
    expect(rejectedByApi(new Error("socket hang up"))).toBe(false);
    expect(rejectedByApi(null)).toBe(false);
  });
});

describe("the classify job's timing", () => {
  it("lets the latest submission and its create call finish within the runner's timeout", () => {
    const { latestSubmissionMs, createTimeoutMs, timeoutMs } = JOB_CONFIG.classify;
    expect(latestSubmissionMs + createTimeoutMs).toBeLessThan(timeoutMs);
  });
});
