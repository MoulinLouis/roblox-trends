import { CONCEPT_CHECK_CONFIG } from "@/lib/config";
import { formatCount, formatPercent, formatUtc } from "@/lib/format";
import type { ConceptAttempt, ConceptReport } from "./types";

const dash = "—";

type DiagnosisRules = typeof CONCEPT_CHECK_CONFIG.diagnosis;

// The terminal view of a concept check, read in analysis sessions: the summary, one row per attempt oldest first,
// and the rule behind each label.
export function formatConceptReport(report: ConceptReport, rules: DiagnosisRules = CONCEPT_CHECK_CONFIG.diagnosis): string {
  const { summary } = report;
  const lines = [`Concept check: ${report.phrases.map((phrase) => `"${phrase}"`).join(", ")} at ${formatUtc(report.checkedAt)}`];
  const counts = `(${plural(summary.hidden, "unrelated result")} hidden, ${formatCount(summary.unavailable)} unavailable)`;
  if (!summary.attempts) {
    lines.push(`No attempt found ${counts}`);
  } else {
    lines.push(`${plural(summary.attempts, "attempt")} ${counts}`);
    if (summary.firstAttempt) lines.push(`First attempt: ${summary.firstAttempt.name} (${isoDay(summary.firstAttempt.created)})`);
    if (summary.leader) {
      const { name, playing, visits, fading } = summary.leader;
      lines.push(`Leader: ${name}, ${formatCount(playing)} playing, ${formatCount(visits)} visits${fading ? ", fading" : ""}`);
    }
    const recent = summary.recent.map((attempt) => attempt.name).join(", ");
    lines.push(`Started in the last ${CONCEPT_CHECK_CONFIG.recentDays} days: ${summary.recent.length ? `${summary.recent.length} (${recent})` : "none"}`);
  }
  lines.push(historyLine(report.history));
  for (const failure of report.failures) lines.push(`Search failed for "${failure.phrase}": ${failure.error}`);
  if (summary.attempts) {
    lines.push("", ...table(report.attempts), "", "Labels:", ...legend(rules).map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

function historyLine(history: ConceptReport["history"]): string {
  if (history.status === "read") return "History: read from the radar";
  if (history.status === "skipped") return `History: not read (${history.reason})`;
  return `History: failed (${history.error})`;
}

const columns = ["created", "title", "creator", "visits", "playing", "favorites", "likes", "updated", "first seen", "peak", "labels"];
// Numbers are right-aligned.
const numeric = new Set(["visits", "playing", "favorites", "likes", "peak"]);

function table(attempts: ConceptAttempt[]): string[] {
  const rows = attempts.map((attempt) => [
    isoDay(attempt.created),
    attempt.name.trim(),
    attempt.creatorName,
    formatCount(attempt.visits),
    formatCount(attempt.playing),
    formatCount(attempt.favorites),
    attempt.likeRatio === null ? dash : `${formatPercent(attempt.likeRatio, 0)} (${formatCount(attempt.upVotes + attempt.downVotes)})`,
    isoDay(attempt.updated),
    attempt.history ? isoDay(attempt.history.firstObservedAt) : dash,
    formatCount(attempt.history?.peakCcu),
    attempt.labels.length ? attempt.labels.join(", ") : dash,
  ]);
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
  const render = (cells: string[]) =>
    cells
      .map((cell, index) => (numeric.has(columns[index]) ? cell.padStart(widths[index]) : cell.padEnd(widths[index])))
      .join("  ")
      .trimEnd();
  return [render(columns), ...rows.map(render)];
}

function legend(rules: DiagnosisRules): string[] {
  return [
    "leader: most playing, or most visits when none plays",
    `fading: playing at most ${formatPercent(rules.fadingMaximumShareOfPeak, 0)} of a tracked peak of ${formatCount(rules.fadingMinimumPeakCcu)} or more`,
    `liked but stuck: at least ${formatPercent(rules.likedMinimumRatio, 0)} likes on ${formatCount(rules.likedMinimumVotes)} or more votes, under ${formatCount(rules.stuckMaximumPlayers)} playing and ${formatCount(rules.stuckMaximumVisits)} visits`,
    `no audience: under ${formatCount(rules.noAudienceMaximumVisits)} visits`,
  ];
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
