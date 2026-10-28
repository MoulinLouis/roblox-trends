import { compareText } from "@/lib/arrays";
import { classificationCostUsd } from "./cost";
import { CLASSIFICATION_PROMPT_VERSION } from "./prompt";
import type { GameClassification } from "./schema";
import type {
  ClassificationInput,
  ClassificationModel,
  ClassificationOutcome,
  ClassificationVocabulary,
  TrialResult,
  VocabularyEntry,
} from "./types";
import { CLASSIFICATION_VOCABULARY } from "./vocabulary";

export const COMPARED_FIELDS = ["family", "template", "rewardLoop", "coreAction"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number] | "format"; // format: family, template and reward loop together

const FORMAT_FIELDS = ["family", "template", "rewardLoop"] as const;
type FormatField = (typeof FORMAT_FIELDS)[number];

export interface FieldAgreement {
  field: ComparedField;
  compared: number;
  agreed: number;
  share: number | null;
}

export interface ModelRunSummary {
  model: ClassificationModel;
  games: number;
  classified: number;
  failures: { universeId: number; error: string }[];
  withoutThumbnail: number;
  costUsd: number; // batch prices
  costPerGameUsd: number | null;
  // Values outside the vocabulary, compared ignoring case, with how many games used each, most used first.
  newValues: Record<FormatField, { value: string; games: number }[]>;
}

export interface ModelComparison {
  promptVersion: number;
  models: [ModelRunSummary, ModelRunSummary];
  agreement: FieldAgreement[]; // COMPARED_FIELDS then "format", over games both models classified
  disagreements: {
    universeId: number;
    name: string;
    stratum: string;
    fields: ComparedField[];
    answers: [GameClassification, GameClassification];
  }[];
}

interface GameOutcome {
  input: ClassificationInput;
  hadThumbnail: boolean | null;
  outcome: ClassificationOutcome;
}

const noResult: ClassificationOutcome = { ok: false, error: "no result", usage: null };

export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function summarizeRun(
  model: ClassificationModel,
  inputs: ClassificationInput[],
  results: TrialResult[],
  vocabulary: ClassificationVocabulary = CLASSIFICATION_VOCABULARY,
): ModelRunSummary {
  const games = gameOutcomes(model, inputs, results);
  const classifications = games.flatMap(({ outcome }) => (outcome.ok ? [outcome.classification] : []));
  // A refused or truncated answer is billed too.
  const costUsd = games.reduce(
    (total, { outcome }) => total + (outcome.usage ? classificationCostUsd(model, outcome.usage, { batch: true }) : 0),
    0,
  );
  return {
    model,
    games: inputs.length,
    classified: classifications.length,
    failures: games.flatMap(({ input, outcome }) => (outcome.ok ? [] : [{ universeId: input.universeId, error: outcome.error }])),
    withoutThumbnail: games.filter((game) => game.hadThumbnail === false).length,
    costUsd,
    costPerGameUsd: classifications.length ? costUsd / classifications.length : null,
    newValues: {
      family: newValues(classifications, "family", vocabulary.families),
      template: newValues(classifications, "template", vocabulary.templates),
      rewardLoop: newValues(classifications, "rewardLoop", vocabulary.rewardLoops),
    },
  };
}

export function compareModels(
  inputs: ClassificationInput[],
  results: TrialResult[],
  models: [ClassificationModel, ClassificationModel],
  vocabulary: ClassificationVocabulary = CLASSIFICATION_VOCABULARY,
): ModelComparison {
  const first = gameOutcomes(models[0], inputs, results);
  const second = gameOutcomes(models[1], inputs, results);
  // Only games both models classified are compared: a failure is reported in its run, not counted as a disagreement.
  const pairs = inputs.flatMap((input, index) => {
    const left = first[index].outcome;
    const right = second[index].outcome;
    if (!left.ok || !right.ok) return [];
    const answers: [GameClassification, GameClassification] = [left.classification, right.classification];
    return [{ input, answers, fields: differingFields(...answers) }];
  });
  return {
    promptVersion: CLASSIFICATION_PROMPT_VERSION,
    models: [summarizeRun(models[0], inputs, results, vocabulary), summarizeRun(models[1], inputs, results, vocabulary)],
    agreement: [...COMPARED_FIELDS, "format" as const].map((field) => {
      const agreed = pairs.filter((pair) => !pair.fields.includes(field)).length;
      return { field, compared: pairs.length, agreed, share: pairs.length ? agreed / pairs.length : null };
    }),
    disagreements: pairs
      .filter((pair) => pair.fields.length)
      .sort((left, right) => left.input.universeId - right.input.universeId)
      .map(({ input, answers, fields }) => ({ universeId: input.universeId, name: input.name, stratum: input.stratum, fields, answers })),
  };
}

// Aligned with the inputs. Results of other models are ignored; a game without a result counts as failed.
function gameOutcomes(model: ClassificationModel, inputs: ClassificationInput[], results: TrialResult[]): GameOutcome[] {
  const byGame = new Map(results.filter((result) => result.model === model).map((result) => [result.universeId, result]));
  return inputs.map((input) => {
    const result = byGame.get(input.universeId);
    return { input, hadThumbnail: result?.hadThumbnail ?? null, outcome: result?.outcome ?? noResult };
  });
}

function differingFields(left: GameClassification, right: GameClassification): ComparedField[] {
  const fields: ComparedField[] = COMPARED_FIELDS.filter((field) => normalizeValue(left[field]) !== normalizeValue(right[field]));
  return FORMAT_FIELDS.some((field) => fields.includes(field)) ? [...fields, "format"] : fields;
}

// Counted once per game under the normalized value and reported as first written. Ties sort by the normalized value,
// so the order does not depend on case or on the runtime locale.
function newValues(
  classifications: GameClassification[],
  field: FormatField,
  vocabulary: readonly VocabularyEntry[],
): { value: string; games: number }[] {
  const known = new Set(vocabulary.map((entry) => normalizeValue(entry.value)));
  const counts = new Map<string, { value: string; games: number }>();
  for (const classification of classifications) {
    const key = normalizeValue(classification[field]);
    if (known.has(key)) continue;
    const count = counts.get(key);
    if (count) count.games += 1;
    else counts.set(key, { value: classification[field], games: 1 });
  }
  return [...counts]
    .sort(([leftKey, left], [rightKey, right]) => right.games - left.games || compareText(leftKey, rightKey))
    .map(([, count]) => count);
}
