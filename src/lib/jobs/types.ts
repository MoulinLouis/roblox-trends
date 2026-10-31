export const JOB_NAMES = ["census", "poll", "votes", "charts", "explore", "thumbnails", "classify"] as const;

export type JobName = (typeof JOB_NAMES)[number];
export type JobStatus = "running" | "success" | "degraded" | "failed";
// "recommendation": rows explore recorded until 2026-10-27, and the v1 import; no job writes it any more.
export type DiscoverySource = "rolimons" | "chart" | "search" | "recommendation";
