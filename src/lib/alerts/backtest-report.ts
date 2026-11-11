import type { ReplayResult } from "./backtest";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const TRACKED_KEYS = ["word:ragdoll", "template:{verb} for {reward}"];

export interface BacktestReportInput {
  result: ReplayResult;
  from: Date;
  to: Date;
  wordsOnly: boolean;
  coverageFrom: Date;
  trackedGames: number;
  breakouts: number;
  // Names and peak CCUs by universe id, and each breakout's crossing, for the games the report mentions.
  names: ReadonlyMap<number, string>;
  peaks: ReadonlyMap<number, number>;
  crossedAt: ReadonlyMap<number, Date>;
}

const date = (instant: Date): string => instant.toISOString().slice(0, 10);
const stamp = (instant: Date): string => instant.toISOString().slice(0, 16).replace("T", " ");

function average(total: number, count: number): string {
  return count > 0 ? (total / count).toFixed(2) : "n/a";
}

// Plain text for a terminal. Digest games are ranked by peak CCU (readCardFacts), best first.
export function formatBacktestReport(input: BacktestReportInput): string {
  const { result, names } = input;
  const nameOf = (id: number): string => names.get(id) ?? `#${id}`;
  const lines: string[] = [];

  lines.push(
    "Alerts backtest",
    `from ${date(input.from)} to ${stamp(input.to)} UTC, words only: ${input.wordsOnly ? "yes" : "no"}`,
    `tracked games: ${input.trackedGames}, breakouts read: ${input.breakouts}`,
    "",
    "Week (Monday)  Pushes  First breakouts",
  );
  for (const row of result.weekly) lines.push(`${row.week}     ${String(row.pushes).padStart(6)}  ${String(row.firstBreakouts).padStart(15)}`);

  const days = (input.to.getTime() - input.from.getTime()) / DAY_MS;
  const weeks = days / 7;
  lines.push(
    "",
    "Summary",
    `total pushes: ${result.pushes.length}`,
    `total first breakouts: ${result.firstBreakouts.length}`,
    `pushes per week: ${average(result.pushes.length, weeks)}`,
    `digest games per day: ${average(result.firstBreakouts.length, days)}`,
  );
  const first = input.coverageFrom.getTime() + ((8 - input.coverageFrom.getUTCDay()) % 7) * DAY_MS;
  const full = result.weekly.filter((row) => {
    const start = Date.parse(row.week);
    return start >= first && start >= input.from.getTime() && start + WEEK_MS <= input.to.getTime();
  });
  const fullPushes = full.reduce((sum, row) => sum + row.pushes, 0);
  const fullFirst = full.reduce((sum, row) => sum + row.firstBreakouts, 0);
  lines.push(
    `full weeks from ${date(new Date(first))} (${full.length}): pushes per week ${average(fullPushes, full.length)}, digest games per day ${average(fullFirst, full.length * 7)}`,
    "",
    `Pushes (${result.pushes.length})`,
  );
  for (const push of result.pushes) {
    const { decision } = push;
    lines.push(`${stamp(push.at)}  ${nameOf(decision.universeId)} (${decision.universeId})`);
    for (const key of decision.keys) {
      const priors = (decision.priors[key] ?? []).map((id) => {
        const crossed = input.crossedAt.get(id);
        return `${nameOf(id)}${crossed ? ` (${date(crossed)})` : ""}`;
      });
      lines.push(`    ${key}: ${priors.join(", ") || "none"}`);
    }
  }

  lines.push("", `Digests (${result.digests.length} days)`);
  for (const digest of result.digests) {
    const top = [...digest.decisions]
      .sort((a, b) => (input.peaks.get(b.universeId) ?? 0) - (input.peaks.get(a.universeId) ?? 0))
      .slice(0, 3)
      .map((decision) => nameOf(decision.universeId));
    lines.push(`${digest.day}  ${digest.decisions.length} games  top: ${top.join(", ")}`);
  }

  lines.push("", "Tracked patterns");
  const firstPush = (match: (key: string) => boolean, list: ReplayResult["pushes"]): Map<string, Date> => {
    const found = new Map<string, Date>();
    for (const entry of list) for (const key of entry.decision.keys) if (match(key) && !found.has(key)) found.set(key, entry.at);
    return found;
  };
  for (const key of TRACKED_KEYS) {
    const push = firstPush((candidate) => candidate === key, result.pushes).get(key);
    const firstBreakout = firstPush((candidate) => candidate === key, result.firstBreakouts).get(key);
    lines.push(`${key}: first push ${push ? date(push) : "none"}, first first breakout ${firstBreakout ? date(firstBreakout) : "none"}`);
  }
  const others = firstPush((key) => key.includes("ragdoll") && key !== "word:ragdoll", result.pushes);
  lines.push(
    others.size === 0
      ? "other keys with ragdoll pushed: none"
      : `other keys with ragdoll pushed: ${[...others].map(([key, at]) => `${key} (${date(at)})`).join(", ")}`,
  );
  return lines.join("\n");
}
