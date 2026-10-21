import { errorMessage, logger } from "@/lib/logger";
import { desiredChecks, upsertCheck } from "@/lib/ops/healthchecks-provisioning";

// Creates or updates every Healthchecks check of the radar with its real period and grace (docs/operations.md). Run
// it after a change of JOB_CONFIG or HEALTHCHECKS_CONFIG, with a read-write API key of the Healthchecks project:
// HEALTHCHECKS_API_KEY=... npm run provision:healthchecks
const apiKey = process.env.HEALTHCHECKS_API_KEY?.trim();
if (!apiKey) {
  logger.error("HEALTHCHECKS_API_KEY is required");
  process.exit(2);
}

let exitCode = 0;
for (const check of desiredChecks()) {
  try {
    const { created } = await upsertCheck(apiKey, check);
    logger.info(created ? "Check created" : "Check updated", { slug: check.slug, timeout: check.timeout, grace: check.grace });
  } catch (error) {
    exitCode = 1;
    logger.error("Check not provisioned", { slug: check.slug, error: errorMessage(error) });
  }
}
process.exit(exitCode);
