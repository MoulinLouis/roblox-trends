import { randomUUID } from "node:crypto";
import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { getDataFreshness, getSettings, runMaintenance } from "@/db/repository";
import { generateAgentDecisionBrief } from "@/lib/agent-brief";
import { analyzeTrends } from "@/lib/analysis";
import { runCollectionJob } from "@/lib/collection-job";
import { evaluateDataHealth } from "@/lib/data-health";
import { scanDiscoveryFrontier } from "@/lib/discovery-frontier";
import { logger } from "@/lib/logger";
import { sendDailyReport } from "@/lib/report";
import { runSchedulerTick } from "@/lib/scheduler";

try {
  await migrateDatabase();
  const settings = await getSettings();
  const now = new Date();
  const owner = `${process.env.RENDER_SERVICE_NAME || "scheduler"}:${randomUUID()}`;
  const result = await runSchedulerTick({
    owner,
    now,
    collectionIntervalMinutes: settings.collection.intervalMinutes,
    actions: {
      frontier: async () => {
        try {
          return await scanDiscoveryFrontier(new Date());
        } catch (error) {
          logger.warn("Discovery frontier scan failed without blocking collection", {
            error: error instanceof Error ? error.message : String(error),
          });
          return { status: "degraded", error: error instanceof Error ? error.message : String(error) };
        }
      },
      collect: async () => {
        const outcome = await runCollectionJob({
          settings,
          now,
          trigger: "durable-scheduler",
          skipUsableBucket: true,
        });
        if (outcome.result?.health.status === "critical") {
          throw new Error(outcome.result.health.reasons.join(" | "));
        }
        return outcome.result
          ? {
              skipped: false,
              status: outcome.result.health.status,
              attemptId: outcome.result.attemptId,
              games: outcome.result.games,
              snapshots: outcome.result.snapshots,
            }
          : { skipped: true };
      },
      analyze: async () => {
        const health = evaluateDataHealth(await getDataFreshness(), new Date());
        if (!health.checks.collection.healthy) {
          throw new Error("Analysis skipped because collection data is stale.");
        }
        return analyzeTrends(settings);
      },
      brief: async () => {
        const generated = await generateAgentDecisionBrief();
        return {
          readiness: generated.brief.decisionReadiness.level,
          games: generated.brief.dataQuality.trackedGames,
          historyHours: generated.brief.dataQuality.historyHours,
        };
      },
      report: async () => sendDailyReport(settings),
      maintenance: async () => runMaintenance(settings.thresholds.hourlyRetentionDays),
    },
  });
  const health = evaluateDataHealth(await getDataFreshness(), new Date());

  if (!result.acquired) {
    logger.info("Scheduler tick skipped because another owner holds the lease", {
      owner,
      dataHealth: health.status,
    });
  } else {
    logger.info("Scheduler tick completed", {
      owner,
      completed: result.completed.map((job) => job.jobName),
      skipped: result.skipped.map((job) => job.jobName),
      failures: result.failures,
      dataHealth: health.status,
    });
  }
  if (health.status === "critical") {
    logger.error("Scheduler data freshness check failed", { checks: health.checks });
  }
  if (result.failures.length || health.status === "critical") process.exitCode = 1;
} catch (error) {
  logger.error("Scheduler tick failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
