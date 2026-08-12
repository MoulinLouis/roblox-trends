import { SCHEDULER_CONFIG } from "./config";

export interface DataFreshness {
  latestCollectionAt: Date | null;
  latestAnalysisAt: Date | null;
  latestSchedulerCollectionAt: Date | null;
}

export interface DataHealth {
  status: "healthy" | "critical";
  checkedAt: string;
  checks: {
    collection: HealthCheck;
    analysis: HealthCheck;
  };
  scheduler: {
    latestCollectionJobAt: string | null;
  };
}

interface HealthCheck {
  healthy: boolean;
  latestAt: string | null;
  ageMinutes: number | null;
  maximumAgeMinutes: number;
}

export function evaluateDataHealth(freshness: DataFreshness, now = new Date()): DataHealth {
  const collection = evaluateCheck(
    freshness.latestCollectionAt,
    SCHEDULER_CONFIG.maximumCollectionAgeMinutes,
    now,
  );
  const analysis = evaluateCheck(
    freshness.latestAnalysisAt,
    SCHEDULER_CONFIG.maximumAnalysisAgeMinutes,
    now,
  );
  return {
    status: collection.healthy && analysis.healthy ? "healthy" : "critical",
    checkedAt: now.toISOString(),
    checks: { collection, analysis },
    scheduler: {
      latestCollectionJobAt: freshness.latestSchedulerCollectionAt?.toISOString() ?? null,
    },
  };
}

function evaluateCheck(latestAt: Date | null, maximumAgeMinutes: number, now: Date): HealthCheck {
  const ageMinutes = latestAt
    ? Math.max(0, Math.round(((now.getTime() - latestAt.getTime()) / 60_000) * 10) / 10)
    : null;
  return {
    healthy: ageMinutes !== null && ageMinutes <= maximumAgeMinutes,
    latestAt: latestAt?.toISOString() ?? null,
    ageMinutes,
    maximumAgeMinutes,
  };
}
