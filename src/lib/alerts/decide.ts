import { ALERT_CONFIG } from "../config";
import type { AlertDecision, Breakout, PastAlert } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type DecideConfig = Pick<
  typeof ALERT_CONFIG,
  "candidateWindowHours" | "unclassifiedWaitHours" | "lookbackDays" | "waveWindowDays" | "waveCooldownDays"
> & { waveRanks: readonly number[] };

function byCrossing(a: Breakout, b: Breakout): number {
  return a.crossedAt.getTime() - b.crossedAt.getTime() || a.universeId - b.universeId;
}

// Decides which breakouts alert now. Pure: it depends only on its input and config. Candidates are processed in
// crossing order, and what an earlier decision of the call pushes counts like a past alert created at `now`.
export function decideAlerts(
  input: { breakouts: Breakout[]; pastAlerts: PastAlert[]; now: Date },
  config: DecideConfig = ALERT_CONFIG,
): AlertDecision[] {
  const { pastAlerts, now } = input;
  const nowMs = now.getTime();
  const sorted = [...input.breakouts].sort(byCrossing);

  // Every key's breakouts in crossing order.
  const byKey = new Map<string, Breakout[]>();
  for (const breakout of sorted) {
    for (const key of breakout.keys) {
      const list = byKey.get(key);
      if (list) list.push(breakout);
      else byKey.set(key, [breakout]);
    }
  }

  const firstGames = new Set<number>();
  const waveGames = new Set<number>();
  const silencedKeys = new Set<string>();
  for (const alert of pastAlerts) {
    if (alert.kind === "first_breakout") firstGames.add(alert.universeId);
    else {
      waveGames.add(alert.universeId);
      if (nowMs - alert.createdAt.getTime() < config.waveCooldownDays * DAY_MS) {
        for (const key of alert.keys) silencedKeys.add(key);
      }
    }
  }

  const windowStart = nowMs - config.candidateWindowHours * HOUR_MS;
  const lookbackMs = config.lookbackDays * DAY_MS;
  const waveWindowMs = config.waveWindowDays * DAY_MS;
  const decisions: AlertDecision[] = [];

  for (const candidate of sorted) {
    const crossedMs = candidate.crossedAt.getTime();
    if (crossedMs <= windowStart || crossedMs > nowMs) continue;

    let keys = candidate.keys;
    if (!candidate.classified) {
      if (nowMs - crossedMs < config.unclassifiedWaitHours * HOUR_MS) continue;
      keys = keys.filter((key) => key.startsWith("word:"));
    }

    const firstKeys: string[] = [];
    const waveKeys: string[] = [];
    const priors: Record<string, number[]> = {};
    for (const key of [...keys].sort()) {
      const list = byKey.get(key) ?? [];
      const position = list.indexOf(candidate);
      let start = position;
      while (start > 0 && crossedMs - list[start - 1].crossedAt.getTime() <= lookbackMs) start -= 1;
      const earlier = list.slice(start, position);
      priors[key] = earlier.map((prior) => prior.universeId);

      if (earlier.length === 0) firstKeys.push(key);
      else if (
        config.waveRanks.includes(earlier.length + 1) &&
        crossedMs - earlier[0].crossedAt.getTime() <= waveWindowMs &&
        !silencedKeys.has(key)
      ) {
        waveKeys.push(key);
      }
    }

    if (waveKeys.length > 0 && !waveGames.has(candidate.universeId)) {
      decisions.push({
        kind: "wave",
        universeId: candidate.universeId,
        keys: waveKeys,
        priors: Object.fromEntries(waveKeys.map((key) => [key, priors[key]])),
      });
      waveGames.add(candidate.universeId);
      for (const key of waveKeys) silencedKeys.add(key);
    }
    if (firstKeys.length > 0 && !firstGames.has(candidate.universeId)) {
      decisions.push({
        kind: "first_breakout",
        universeId: candidate.universeId,
        keys: firstKeys,
        priors: Object.fromEntries(firstKeys.map((key) => [key, priors[key]])),
      });
      firstGames.add(candidate.universeId);
    }
  }

  return decisions;
}
