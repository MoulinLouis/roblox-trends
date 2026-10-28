import { formatCount, formatPercent } from "@/lib/format";
import type { ComparedField, ModelComparison, ModelRunSummary } from "./compare";
import type { ClassificationModel } from "./types";

const fieldLabels: Record<ComparedField, string> = {
  family: "family",
  template: "template",
  rewardLoop: "reward loop",
  coreAction: "core action",
  format: "format",
};

// The terminal view of `npm run classify:trial` with two models; the whole comparison is in `file`.
export function formatComparison(comparison: ModelComparison, file: string): string {
  const [first, second] = comparison.models;
  return [
    `Comparison of ${first.model} and ${second.model} on ${plural(first.games, "game")} (prompt v${comparison.promptVersion})`,
    `Classified: ${comparison.models.map(classified).join(", ")}; ${withoutThumbnail(comparison.models)}`,
    `Agreement: ${comparison.agreement
      .map(({ field, agreed, compared, share }) => `${fieldLabels[field]} ${formatPercent(share, 0)} (${agreed}/${compared})`)
      .join(", ")}`,
    `Cost at batch prices: ${comparison.models.map(cost).join(", ")}`,
    `New values: ${comparison.models.map(newValues).join("; ")}`,
    `${plural(comparison.disagreements.length, "disagreement")} in ${file}`,
  ].join("\n");
}

// The terminal view with one model; the summary is in `file`.
export function formatRunSummary(summary: ModelRunSummary, promptVersion: number, file: string): string {
  return [
    `Run of ${summary.model} on ${plural(summary.games, "game")} (prompt v${promptVersion})`,
    `Classified: ${classified(summary)}; ${withoutThumbnail([summary])}`,
    `Cost at batch prices: ${cost(summary)}`,
    `New values: ${newValues(summary)}`,
    `Summary in ${file}`,
  ].join("\n");
}

export function formatPending(models: readonly ClassificationModel[]): string {
  return `Still processing: ${models.join(", ")}. Run the same command again to resume.`;
}

function classified({ model, classified, failures }: ModelRunSummary): string {
  return `${model} ${formatCount(classified)}${failures.length ? ` (${formatCount(failures.length)} failed)` : ""}`;
}

// Models submitted in one run share their thumbnails; a model resumed from an earlier run may not.
function withoutThumbnail(summaries: readonly ModelRunSummary[]): string {
  const counts = new Set(summaries.map((summary) => summary.withoutThumbnail));
  const which =
    counts.size === 1
      ? formatCount(summaries[0].withoutThumbnail)
      : summaries.map((summary) => `${summary.model} ${formatCount(summary.withoutThumbnail)}`).join(", ");
  return `${which} without thumbnail`;
}

function cost({ model, costUsd, costPerGameUsd }: ModelRunSummary): string {
  const perGame = costPerGameUsd === null ? "" : ` (${dollars(costPerGameUsd, 4)} a game)`;
  return `${model} ${dollars(costUsd, 2)}${perGame}`;
}

function newValues({ model, newValues: values }: ModelRunSummary): string {
  return `${model} ${plural(values.family.length, "family", "families")}, ${plural(values.template.length, "template")}, ${plural(values.rewardLoop.length, "reward loop")}`;
}

function dollars(value: number, digits: number): string {
  return `$${value.toFixed(digits)}`;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${formatCount(count)} ${count === 1 ? noun : nouns}`;
}
