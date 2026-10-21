import { describe, expect, it } from "vitest";
import { orderJobs } from "./order";
import type { JobDefinition } from "./runner";
import type { JobName } from "./types";

function job(name: JobName): JobDefinition {
  return { name, intervalMinutes: 5, timeoutMs: 1_000, run: async () => ({ status: "success", stats: {} }) };
}

describe("orderJobs", () => {
  it("returns the registered jobs in the given order", () => {
    const ordered = orderJobs([job("poll"), job("thumbnails"), job("census")], ["census", "poll", "thumbnails"]);
    expect(ordered.map((definition) => definition.name)).toEqual(["census", "poll", "thumbnails"]);
  });

  it("refuses an order that names a job the registry lacks", () => {
    expect(() => orderJobs([job("census")], ["census", "poll"])).toThrow("Job poll is not registered");
  });

  it("refuses an order that leaves out a registered job", () => {
    expect(() => orderJobs([job("census"), job("votes"), job("charts")], ["census"])).toThrow(
      "The job order leaves out votes, charts",
    );
  });
});
