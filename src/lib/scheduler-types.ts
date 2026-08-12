export type ScheduledJobName = "frontier" | "collect" | "analyze" | "brief" | "report" | "maintenance";
export type ScheduledJobStatus = "running" | "success" | "failed";

export interface ScheduledJobSlot {
  jobName: ScheduledJobName;
  scheduledFor: Date;
}
