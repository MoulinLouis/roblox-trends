import { describe, expect, it } from "vitest";
import { createClassifyJob } from "./classify";

describe("createClassifyJob", () => {
  // The SDK client throws without ANTHROPIC_API_KEY, which only the classify unit loads.
  it("does not build the batch client until the job runs", () => {
    let built = 0;
    const job = createClassifyJob({
      batches: () => {
        built += 1;
        throw new Error("No key");
      },
      downloadThumbnail: async () => null,
    });
    expect(job.name).toBe("classify");
    expect(built).toBe(0);
  });
});
