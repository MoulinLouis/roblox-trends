import type { JobStatus } from "@/lib/jobs/types";

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}
