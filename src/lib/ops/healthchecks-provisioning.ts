import { HEALTHCHECKS_CONFIG, JOB_CONFIG } from "@/lib/config";
import { jobSlug, qualitySlug } from "@/lib/jobs/healthchecks";
import { JOB_NAMES } from "@/lib/jobs/types";

export const HEALTHCHECKS_API_URL = "https://healthchecks.io/api/v3/checks/";

// The fields of a Healthchecks check this repository manages; timeout (the expected period) and grace are in seconds.
export interface CheckSpec {
  slug: string;
  name: string;
  tags: string;
  desc: string;
  timeout: number;
  grace: number;
}

export function desiredChecks(): CheckSpec[] {
  const jobs = JOB_NAMES.flatMap((name): CheckSpec[] => {
    const { intervalMinutes, timeoutMs } = JOB_CONFIG[name];
    return [
      {
        slug: jobSlug(name),
        name: `${name} job`,
        tags: "radar job",
        desc: `Pinged by every ${name} run that completes, degraded or not; a failed run pings /fail.`,
        timeout: intervalMinutes * 60,
        grace: Math.ceil(timeoutMs / 1_000) + HEALTHCHECKS_CONFIG.heartbeatGraceMarginMinutes * 60,
      },
      {
        slug: qualitySlug(name),
        name: `${name} quality`,
        tags: "radar quality",
        desc: `Pinged only by fully successful ${name} runs, so a lasting degradation alerts.`,
        timeout: intervalMinutes * 60,
        grace: HEALTHCHECKS_CONFIG.qualityGraceMinutes * 60,
      },
    ];
  });
  const operations = Object.values(HEALTHCHECKS_CONFIG.operations).map(
    (check): CheckSpec => ({
      slug: check.slug,
      name: check.name,
      tags: "radar operations",
      desc: check.description,
      timeout: check.periodMinutes * 60,
      grace: check.graceMinutes * 60,
    }),
  );
  return [...jobs, ...operations];
}

// Creates the check, or updates the one with the same slug, and attaches every notification channel of the project.
// The key travels only in the header; it is redacted from the response quoted in an error, which ends up in the logs.
export async function upsertCheck(
  apiKey: string,
  check: CheckSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slug: string; created: boolean }> {
  const response = await fetchImpl(HEALTHCHECKS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ ...check, channels: "*", unique: ["slug"] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 && response.status !== 201) {
    const body = (await response.text()).replaceAll(apiKey, "[redacted]").slice(0, 500);
    throw new Error(`Healthchecks rejected ${check.slug}: HTTP ${response.status} ${body}`);
  }
  return { slug: check.slug, created: response.status === 201 };
}
