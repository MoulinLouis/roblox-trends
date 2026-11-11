export type MergedField = "family" | "template" | "rewardLoop";

// A value the owner decided to fold into another value of the same field.
export interface ClassificationMerge {
  field: MergedField;
  from: string;
  to: string;
  reason: string;
  decidedAt: string; // YYYY-MM-DD
}

// One key for comparing values: trimmed, whitespace runs collapsed to one space, lower-cased. The format_stats view
// applies the same normalization in SQL, so keep the two equivalent.
export function mergeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// A merge maps one value of one field onto another for format_stats, so near-duplicate spellings of a format count
// as one. The classify job copies this list into classification_merges on its next run after a deploy. Targets are
// final: a `to` is never itself a `from` (no chains, no loops), and `from` is unique per field.
export const CLASSIFICATION_MERGES: readonly ClassificationMerge[] = [
  { field: "family", from: "rhythm game", to: "rhythm", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "sandbox builder", to: "building sandbox", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "grand strategy", to: "strategy", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "war strategy", to: "strategy", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "conquest strategy", to: "strategy", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "territory strategy", to: "strategy", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "RTS", to: "strategy", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "family", from: "donation hangout", to: "donation game", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
  { field: "template", from: "{thing} Roleplay", to: "{thing} RP", reason: "Near-duplicate in the classify job's new values (execution notes, 2026-11-11).", decidedAt: "2026-11-11" },
];

// One plain sentence per problem; empty when the list is valid.
export function mergeProblems(merges: readonly ClassificationMerge[]): string[] {
  const problems: string[] = [];
  merges.forEach((merge, index) => {
    const label = `${merge.field} "${merge.from}" -> "${merge.to}"`;
    if (merge.from.trim() === "") problems.push(`A ${merge.field} merge has an empty from value.`);
    if (merge.to.trim() === "") problems.push(`The ${merge.field} merge from "${merge.from}" has an empty to value.`);
    if (merge.reason.trim() === "") problems.push(`The merge ${label} has no reason.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(merge.decidedAt)) {
      problems.push(`The merge ${label} has a decidedAt that is not YYYY-MM-DD: "${merge.decidedAt}".`);
    }
    const from = mergeKey(merge.from);
    const to = mergeKey(merge.to);
    if (from === to && from !== "") problems.push(`The merge ${label} maps a value onto itself.`);
    merges.forEach((other, otherIndex) => {
      if (otherIndex === index || other.field !== merge.field) return;
      if (otherIndex > index && mergeKey(other.from) === from) {
        problems.push(`The ${merge.field} value "${merge.from}" is merged twice (also "${other.from}").`);
      }
      if (mergeKey(other.from) === to && to !== "") {
        problems.push(`The merge ${label} is a chain or loop: its target is itself merged into "${other.to}".`);
      }
    });
  });
  return problems;
}
