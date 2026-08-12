import { describe, expect, it } from "vitest";
import { evaluateDataHealth } from "./data-health";

const now = new Date("2026-08-12T12:00:00Z");

describe("data health", () => {
  it("is healthy while collection and analysis are inside their freshness budgets", () => {
    const health = evaluateDataHealth({
      latestCollectionAt: new Date("2026-08-12T11:10:00Z"),
      latestAnalysisAt: new Date("2026-08-12T08:00:00Z"),
      latestSchedulerCollectionAt: new Date("2026-08-12T11:14:00Z"),
    }, now);
    expect(health.status).toBe("healthy");
    expect(health.checks.collection.ageMinutes).toBe(50);
    expect(health.scheduler.latestCollectionJobAt).toBe("2026-08-12T11:14:00.000Z");
  });

  it("becomes critical when collection is stale", () => {
    const health = evaluateDataHealth({
      latestCollectionAt: new Date("2026-08-12T10:44:00Z"),
      latestAnalysisAt: new Date("2026-08-12T11:00:00Z"),
      latestSchedulerCollectionAt: null,
    }, now);
    expect(health.status).toBe("critical");
    expect(health.checks.collection.healthy).toBe(false);
  });

  it("becomes critical when no analysis exists", () => {
    const health = evaluateDataHealth({
      latestCollectionAt: new Date("2026-08-12T11:30:00Z"),
      latestAnalysisAt: null,
      latestSchedulerCollectionAt: null,
    }, now);
    expect(health.status).toBe("critical");
    expect(health.checks.analysis.ageMinutes).toBeNull();
  });
});
