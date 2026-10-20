export const JOB_NAMES = ["census", "poll", "votes", "charts", "explore", "thumbnails"] as const;

export type JobName = (typeof JOB_NAMES)[number];
export type JobStatus = "running" | "success" | "degraded" | "failed";
export type DiscoverySource = "rolimons" | "chart" | "search" | "recommendation";
