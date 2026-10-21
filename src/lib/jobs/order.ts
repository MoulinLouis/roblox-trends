import type { JobDefinition } from "./runner";
import type { JobName } from "./types";

// Resolves the registered jobs in the given order before any of them runs. An order that leaves out a registered
// job is refused, so a job added to the registry cannot be silently skipped by a pass.
export function orderJobs(jobs: readonly JobDefinition[], order: readonly JobName[]): JobDefinition[] {
  const listed = new Set(order);
  const unlisted = jobs.filter((job) => !listed.has(job.name)).map((job) => job.name);
  if (unlisted.length > 0) throw new Error(`The job order leaves out ${unlisted.join(", ")}`);
  return order.map((name) => {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`Job ${name} is not registered`);
    return job;
  });
}
