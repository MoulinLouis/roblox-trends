import { randomUUID } from "node:crypto";
import {
  acquireScheduledJob,
  acquireSchedulerLock,
  finishScheduledJob,
  releaseSchedulerLock,
  renewSchedulerLock,
} from "@/db/repository";
import { SCHEDULER_CONFIG } from "./config";
import { errorMessage } from "./logger";
import type { ScheduledJobName, ScheduledJobSlot } from "./scheduler-types";

const SCHEDULER_LOCK_NAME = "roblox-trend-scheduler";

export type ScheduledJobAction = () => Promise<Record<string, unknown> | void>;

export interface SchedulerTickResult {
  acquired: boolean;
  slots: ScheduledJobSlot[];
  completed: Array<{ jobName: ScheduledJobName; scheduledFor: Date; attempt: number }>;
  skipped: ScheduledJobSlot[];
  failures: Array<{ jobName: ScheduledJobName; scheduledFor: Date; attempt: number; error: string }>;
}

export function buildScheduledJobSlots(now: Date, collectionIntervalMinutes: number): ScheduledJobSlot[] {
  const dailySlot = latestDailySlot(now, SCHEDULER_CONFIG.dailyHourUtc);
  return [
    { jobName: "collect", scheduledFor: floorToInterval(now, collectionIntervalMinutes) },
    { jobName: "analyze", scheduledFor: floorToInterval(now, SCHEDULER_CONFIG.analysisIntervalMinutes) },
    { jobName: "brief", scheduledFor: dailySlot },
    { jobName: "report", scheduledFor: dailySlot },
    { jobName: "maintenance", scheduledFor: dailySlot },
  ];
}

export function floorToInterval(date: Date, intervalMinutes: number): Date {
  const intervalMilliseconds = intervalMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / intervalMilliseconds) * intervalMilliseconds);
}

export function latestDailySlot(date: Date, hourUtc: number): Date {
  const slot = new Date(date);
  slot.setUTCHours(hourUtc, 0, 0, 0);
  if (slot.getTime() > date.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

export async function runSchedulerTick(input: {
  owner: string;
  now: Date;
  collectionIntervalMinutes: number;
  actions: Record<ScheduledJobName, ScheduledJobAction>;
  clock?: () => Date;
}): Promise<SchedulerTickResult> {
  const clock = input.clock ?? (() => new Date());
  const lockStartedAt = clock();
  const acquired = await acquireSchedulerLock({
    name: SCHEDULER_LOCK_NAME,
    owner: input.owner,
    now: lockStartedAt,
    leaseUntil: leaseUntil(lockStartedAt),
  });
  const slots = buildScheduledJobSlots(input.now, input.collectionIntervalMinutes);
  const result: SchedulerTickResult = { acquired, slots, completed: [], skipped: [], failures: [] };
  if (!acquired) return result;

  try {
    for (const slot of slots) {
      const startedAt = clock();
      const renewed = await renewSchedulerLock({
        name: SCHEDULER_LOCK_NAME,
        owner: input.owner,
        leaseUntil: leaseUntil(startedAt),
      });
      if (!renewed) throw new Error("Scheduler lease was lost before all due jobs completed.");

      const execution = await acquireScheduledJob({
        id: randomUUID(),
        jobName: slot.jobName,
        scheduledFor: slot.scheduledFor,
        owner: input.owner,
        now: startedAt,
        leaseUntil: leaseUntil(startedAt),
      });
      if (!execution) {
        result.skipped.push(slot);
        continue;
      }

      try {
        const details = await input.actions[slot.jobName]();
        await finishScheduledJob({
          id: execution.id,
          owner: input.owner,
          status: "success",
          now: clock(),
          details: details ?? {},
        });
        result.completed.push({ ...slot, attempt: execution.attempt });
      } catch (error) {
        const message = errorMessage(error);
        await finishScheduledJob({
          id: execution.id,
          owner: input.owner,
          status: "failed",
          now: clock(),
          error: message,
        });
        result.failures.push({ ...slot, attempt: execution.attempt, error: message });
      }
    }
    return result;
  } finally {
    await releaseSchedulerLock(SCHEDULER_LOCK_NAME, input.owner);
  }
}

function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + SCHEDULER_CONFIG.leaseDurationMinutes * 60_000);
}
