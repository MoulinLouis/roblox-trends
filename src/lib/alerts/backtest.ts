import { ALERT_CONFIG } from "../config";
import { decideAlerts } from "./decide";
import { digestDue, localTime } from "./digest-time";
import type { AlertDecision, Breakout, PastAlert } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// The alerts timer fires at HH:56:30 UTC each hour; the replay steps through those same run times.
const RUN_OFFSET_MS = 56 * 60_000 + 30_000;

export interface ReplayResult {
  // Waves, at the run that pushed them.
  pushes: Array<{ at: Date; decision: AlertDecision }>;
  // First breakouts, at the run that decided them.
  firstBreakouts: Array<{ at: Date; decision: AlertDecision }>;
  // `day` is the Paris-local date of the digest's run.
  digests: Array<{ day: string; sentAt: Date; decisions: AlertDecision[] }>;
  // Every week from `from` to `to`, zero rows included; `week` is its Monday (UTC).
  weekly: Array<{ week: string; pushes: number; firstBreakouts: number }>;
}

const isoDay = (instant: Date): string => instant.toISOString().slice(0, 10);

function mondayOf(instant: Date): number {
  const midnight = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  return midnight - ((instant.getUTCDay() + 6) % 7) * DAY_MS;
}

// Replays the alerts job over a history, read-only and pure: at each run time from `from` to `to` it decides with the
// breakouts crossed by then and the alerts of the replay so far, then applies the job's digest rule. Every breakout
// counts as classified. Decisions about a game that crossed before `from` shape the cooldowns but are not reported.
export function replayAlerts(
  input: { breakouts: Breakout[]; from: Date; to: Date },
  config = ALERT_CONFIG,
): ReplayResult {
  const { from, to } = input;
  const sorted = input.breakouts
    .map((breakout) => ({ ...breakout, classified: true }))
    .sort((a, b) => a.crossedAt.getTime() - b.crossedAt.getTime() || a.universeId - b.universeId);
  const crossedAt = new Map(sorted.map((breakout) => [breakout.universeId, breakout.crossedAt.getTime()]));

  const pushes: ReplayResult["pushes"] = [];
  const firstBreakouts: ReplayResult["firstBreakouts"] = [];
  const digests: ReplayResult["digests"] = [];
  const pastAlerts: PastAlert[] = [];
  let unsent: AlertDecision[] = [];
  let lastDigestAt: Date | null = null;
  let included = 0;

  const firstRun = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + RUN_OFFSET_MS;
  for (let run = firstRun < from.getTime() ? firstRun + HOUR_MS : firstRun; run <= to.getTime(); run += HOUR_MS) {
    const now = new Date(run);
    while (included < sorted.length && sorted[included].crossedAt.getTime() <= run) included += 1;
    const decisions = decideAlerts({ breakouts: sorted.slice(0, included), pastAlerts, now }, config);
    for (const decision of decisions) {
      pastAlerts.push({ kind: decision.kind, universeId: decision.universeId, keys: decision.keys, createdAt: now });
      const reported = (crossedAt.get(decision.universeId) ?? 0) >= from.getTime();
      if (decision.kind === "wave") {
        if (reported) pushes.push({ at: now, decision });
      } else {
        // An unreported first breakout still waits for the digest so that the digest timing stays the job's.
        unsent.push(decision);
        if (reported) firstBreakouts.push({ at: now, decision });
      }
    }
    if (unsent.length > 0 && digestDue(now, lastDigestAt, config)) {
      const reportedDecisions = unsent.filter((decision) => (crossedAt.get(decision.universeId) ?? 0) >= from.getTime());
      if (reportedDecisions.length > 0) {
        digests.push({ day: localTime(now, config.digestTimeZone).day, sentAt: now, decisions: reportedDecisions });
      }
      unsent = [];
      lastDigestAt = now;
    }
  }

  const weekly: ReplayResult["weekly"] = [];
  const rows = new Map<string, { week: string; pushes: number; firstBreakouts: number }>();
  for (let week = mondayOf(from); week <= to.getTime(); week += 7 * DAY_MS) {
    const row = { week: isoDay(new Date(week)), pushes: 0, firstBreakouts: 0 };
    rows.set(row.week, row);
    weekly.push(row);
  }
  for (const push of pushes) {
    const row = rows.get(isoDay(new Date(mondayOf(push.at))));
    if (row) row.pushes += 1;
  }
  for (const entry of firstBreakouts) {
    const row = rows.get(isoDay(new Date(mondayOf(entry.at))));
    if (row) row.firstBreakouts += 1;
  }
  return { pushes, firstBreakouts, digests, weekly };
}
