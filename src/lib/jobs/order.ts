import type { JobDefinition } from "./runner";
import type { JobName } from "./types";

// Resolves the registered jobs in the given order before any of them runs. A registered job that is neither in the
// order nor in the list of jobs the pass leaves out on purpose is refused, so a job added to the registry cannot be
// silently skipped by a pass.
export function orderJobs(
  jobs: readonly JobDefinition[],
  order: readonly JobName[],
  leftOut: readonly JobName[] = [],
): JobDefinition[] {
  const listed = new Set<JobName>([...order, ...leftOut]);
  const unlisted = jobs.filter((job) => !listed.has(job.name)).map((job) => job.name);
  if (unlisted.length > 0) throw new Error(`The job order leaves out ${unlisted.join(", ")}`);
  const contradictory = order.filter((name) => leftOut.includes(name));
  if (contradictory.length > 0) throw new Error(`The job order also leaves out ${contradictory.join(", ")}`);
  return order.map((name) => {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`Job ${name} is not registered`);
    return job;
  });
}
