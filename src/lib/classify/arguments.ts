import { parseArgs } from "node:util";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { CLASSIFICATION_MODELS, type ClassificationModel } from "./types";

export type TrialName = keyof typeof CLASSIFICATION_CONFIG.trials;

export interface TrialArguments {
  trial: TrialName;
  dir: string;
  // Compared in this order.
  models: ClassificationModel[];
  // Trial directories whose sample games a new sample leaves out.
  exclude: string[];
}

const trialNames = Object.keys(CLASSIFICATION_CONFIG.trials) as TrialName[];

export const CLASSIFICATION_TRIAL_USAGE = [
  `Usage: npm run classify:trial -- --trial ${trialNames.join("|")} --dir <directory> [--models <model>[,<model>]] [--exclude <directory>]...`,
  `Models: ${CLASSIFICATION_MODELS.join(", ")} (all by default, compared in the order given)`,
].join("\n");

// The command line of `npm run classify:trial`. A run spends money, so anything unexpected is rejected rather than
// guessed: an unknown option, a missing value, or an option given twice.
export function parseTrialArguments(argv: readonly string[]): TrialArguments {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      trial: { type: "string", multiple: true },
      dir: { type: "string", multiple: true },
      models: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });
  const trial = single(values.trial, "trial");
  if (trial === undefined) throw new Error("--trial is required");
  if (!Object.hasOwn(CLASSIFICATION_CONFIG.trials, trial)) {
    throw new Error(`Unknown trial: ${trial} (${trialNames.join(" or ")})`);
  }
  const dir = single(values.dir, "dir");
  if (!dir?.trim()) throw new Error("--dir is required");
  const exclude = values.exclude ?? [];
  if (exclude.some((directory) => !directory.trim())) throw new Error("--exclude needs a directory");
  const models = single(values.models, "models");
  return { trial: trial as TrialName, dir, models: models === undefined ? [...CLASSIFICATION_MODELS] : parseModels(models), exclude };
}

function single(values: string[] | undefined, name: string): string | undefined {
  if (values && values.length > 1) throw new Error(`--${name} is given more than once`);
  return values?.[0];
}

function parseModels(list: string): ClassificationModel[] {
  const models: ClassificationModel[] = [];
  for (const name of list.split(",").map((part) => part.trim())) {
    if (!(CLASSIFICATION_MODELS as readonly string[]).includes(name)) {
      throw new Error(`Unknown model: ${name} (${CLASSIFICATION_MODELS.join(", ")})`);
    }
    const model = name as ClassificationModel;
    if (models.includes(model)) throw new Error(`${model} is given more than once`);
    models.push(model);
  }
  return models;
}
