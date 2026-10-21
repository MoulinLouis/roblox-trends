import { describe, expect, it } from "vitest";
import type { ArchiverHealth, TimescaleJobHealth } from "@/db/system-health";
import { evaluateSystemHealth } from "./system-check";

const now = new Date("2026-10-22T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const archiver: ArchiverHealth = { archiveMode: "on", lastArchivedAt: minutesAgo(3), lastFailedAt: null };
const refresh: TimescaleJobHealth = {
  jobId: 1001,
  procName: "policy_refresh_continuous_aggregate",
  hypertableName: "game_hourly",
  scheduleIntervalSeconds: 900,
  scheduled: true,
  lastRunStatus: "Success",
  lastSuccessfulFinish: minutesAgo(10),
  initialStart: minutesAgo(6_000),
};
const healthy = { now, diskUsedShare: 0.2, archiver, jobs: [refresh] };

describe("evaluateSystemHealth", () => {
  it("passes a healthy server and summarizes it", () => {
    const result = evaluateSystemHealth(healthy);
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.summary).toContain("disk 20%");
  });

  it("reports a disk above the limit", () => {
    expect(evaluateSystemHealth({ ...healthy, diskUsedShare: 0.75 }).problems).toEqual(["Disk 75% used (limit 70%)"]);
  });

  it("reports archiving that is off, failing or stalled", () => {
    expect(evaluateSystemHealth({ ...healthy, archiver: { ...archiver, archiveMode: "off" } }).problems).toEqual([
      "WAL archiving is off: point-in-time recovery is not possible",
    ]);
    expect(evaluateSystemHealth({ ...healthy, archiver: { ...archiver, lastFailedAt: minutesAgo(1) } }).problems).toEqual([
      `WAL archiving has failed since ${minutesAgo(1).toISOString()}`,
    ]);
    expect(evaluateSystemHealth({ ...healthy, archiver: { ...archiver, lastArchivedAt: minutesAgo(45) } }).problems).toEqual([
      "No WAL segment archived for 45 min",
    ]);
    expect(evaluateSystemHealth({ ...healthy, archiver: { ...archiver, lastArchivedAt: null } }).problems).toEqual([
      "No WAL segment archived yet",
    ]);
  });

  it("treats archive_mode always as archiving", () => {
    expect(evaluateSystemHealth({ ...healthy, archiver: { ...archiver, archiveMode: "always" } }).ok).toBe(true);
  });

  it("ignores an archive failure that a later success superseded", () => {
    const recovered = { ...archiver, lastFailedAt: minutesAgo(20), lastArchivedAt: minutesAgo(2) };
    expect(evaluateSystemHealth({ ...healthy, archiver: recovered }).ok).toBe(true);
  });

  it("reports paused and late TimescaleDB policies, from their initial start when they never succeeded", () => {
    const paused = { ...refresh, scheduled: false };
    const late = { ...refresh, lastRunStatus: "Failed", lastSuccessfulFinish: minutesAgo(61) };
    const neverRan = { ...refresh, jobId: 1002, lastRunStatus: null, lastSuccessfulFinish: null, initialStart: minutesAgo(30) };
    expect(evaluateSystemHealth({ ...healthy, jobs: [paused, late, neverRan] }).problems).toEqual([
      "policy_refresh_continuous_aggregate on game_hourly (job 1001) is paused",
      "policy_refresh_continuous_aggregate on game_hourly (job 1001) has not succeeded for 61 min (last run Failed)",
    ]);
  });

  it("reports a policy that failed from its first run, measured from its initial start", () => {
    const failing = { ...refresh, lastRunStatus: "Failed", lastSuccessfulFinish: null, initialStart: minutesAgo(120) };
    expect(evaluateSystemHealth({ ...healthy, jobs: [failing] }).problems).toEqual([
      "policy_refresh_continuous_aggregate on game_hourly (job 1001) has not succeeded for 120 min (last run Failed)",
    ]);
  });

  it("does not report a policy whose initial start is still ahead", () => {
    const fresh = { ...refresh, lastRunStatus: null, lastSuccessfulFinish: null, initialStart: minutesAgo(-5) };
    expect(evaluateSystemHealth({ ...healthy, jobs: [fresh] }).ok).toBe(true);
  });

  it("allows a daily policy three of its intervals", () => {
    const retention = { ...refresh, procName: "policy_retention", scheduleIntervalSeconds: 86_400, lastSuccessfulFinish: minutesAgo(2 * 24 * 60) };
    expect(evaluateSystemHealth({ ...healthy, jobs: [retention] }).ok).toBe(true);
    expect(evaluateSystemHealth({ ...healthy, jobs: [{ ...retention, lastSuccessfulFinish: minutesAgo(3 * 24 * 60 + 1) }] }).ok).toBe(false);
  });
});
