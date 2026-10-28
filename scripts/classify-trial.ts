import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { readClassificationSample } from "@/db/classification-sample";
import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { CLASSIFICATION_TRIAL_USAGE, parseTrialArguments, type TrialArguments, type TrialName } from "@/lib/classify/arguments";
import { compareModels, summarizeRun } from "@/lib/classify/compare";
import { CLASSIFICATION_PROMPT_VERSION } from "@/lib/classify/prompt";
import { formatComparison, formatPending, formatRunSummary } from "@/lib/classify/report";
import { downloadThumbnailJpeg } from "@/lib/classify/thumbnails";
import { runClassificationTrial, type TrialState, type TrialStore } from "@/lib/classify/trial";
import type { ClassificationInput, TrialResult } from "@/lib/classify/types";
import { CLASSIFICATION_CONFIG, DATABASE_SESSION_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

// Classifies a sample of tracked games with Claude through the Message Batches API, for the model comparison and the
// owner's review (docs/operations.md, "Analysis sessions"). It runs on the owner's machine, with the key that the npm
// script loads from ~/.config/radar/anthropic.env. Everything it keeps is under --dir. It reads the radar only to draw
// a new sample, through the analysis tunnel in a read-only session, and never writes to it.
const SAMPLE_FILE = "sample.json";
const STATE_FILE = "state.json";

let exitCode = 1;
let parsed: TrialArguments | null = null;
try {
  parsed = parseTrialArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${errorMessage(error)}\n${CLASSIFICATION_TRIAL_USAGE}`);
}
if (parsed) {
  // Checked before the sample is drawn, so a missing key costs no tunnel and no download.
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    logger.error("ANTHROPIC_API_KEY is not set: npm run classify:trial loads it from ~/.config/radar/anthropic.env (one line ANTHROPIC_API_KEY=...)");
  } else {
    try {
      exitCode = await runTrial(parsed);
    } catch (error) {
      logger.error("Classification trial failed", { error: errorMessage(error) });
    }
  }
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "classify:trial" });
process.exit(exitCode);

async function runTrial({ trial, dir, models, exclude }: TrialArguments): Promise<number> {
  const inputs = await loadSample(trial, dir, exclude);
  const client = new Anthropic();
  let run: Awaited<ReturnType<typeof runClassificationTrial>>;
  try {
    run = await runClassificationTrial(inputs, models, {
      store: fileTrialStore(dir),
      batches: client.messages.batches,
      downloadThumbnail: (url) => downloadThumbnailJpeg(url),
      now: () => new Date(),
      sleep: (ms) => delay(ms),
      log: (message) => logger.info(message),
    });
  } catch (error) {
    logger.error("Classification trial failed", { error: errorMessage(error) });
    // A submission that timed out or lost its connection may still have been accepted, and paid for, by Anthropic.
    console.error(
      "If a batch submission failed, check the batch list in the Anthropic Console before running again: a batch may " +
        `have been created without its id being saved in ${path.join(dir, STATE_FILE)}.`,
    );
    return 1;
  }

  if (run.pending.length) {
    console.log(formatPending(run.pending));
  } else if (models.length === 2) {
    const file = path.join(dir, "comparison.json");
    const comparison = compareModels(inputs, run.results, [models[0], models[1]]);
    await writeJson(file, comparison);
    console.log(formatComparison(comparison, file));
  } else {
    const file = path.join(dir, "summary.json");
    const summary = summarizeRun(models[0], inputs, run.results);
    await writeJson(file, summary);
    console.log(formatRunSummary(summary, CLASSIFICATION_PROMPT_VERSION, file));
  }
  return 0;
}

// A trial directory keeps one sample: its batches were built from it, so it is never redrawn.
async function loadSample(trial: TrialName, dir: string, exclude: readonly string[]): Promise<ClassificationInput[]> {
  const excluded = new Set<number>();
  for (const directory of exclude) {
    const file = path.join(directory, SAMPLE_FILE);
    const sample = await readJson<ClassificationInput[]>(file);
    if (sample === null) throw new Error(`${file} does not exist: --exclude takes a trial directory that holds a sample`);
    for (const input of sample) excluded.add(input.universeId);
  }

  const file = path.join(dir, SAMPLE_FILE);
  const stored = await readJson<ClassificationInput[]>(file);
  if (stored === null && (await readJson<TrialState>(path.join(dir, STATE_FILE))) !== null) {
    throw new Error(`${path.join(dir, STATE_FILE)} exists without ${file}: its batches were built from a sample that is gone; use a new directory`);
  }
  const sample = stored ?? (await drawSample(trial, [...excluded]));
  if (!sample.length) throw new Error(`The sample of ${dir} is empty`);
  // A stored sample was drawn by an earlier run, perhaps without these exclusions.
  const overlap = sample.filter((input) => excluded.has(input.universeId)).length;
  if (overlap) throw new Error(`${file} shares ${overlap} games with the excluded directories; use a new directory`);
  if (stored === null) {
    await writeJson(file, sample);
    logger.info(`Drew a sample of ${sample.length} games`, { file });
  } else {
    logger.info(`Reusing the stored sample of ${sample.length} games`, { file });
  }
  return sample;
}

async function drawSample(trial: TrialName, excludeUniverseIds: number[]): Promise<ClassificationInput[]> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      'Drawing a new sample needs DATABASE_URL: open the analysis tunnel (docs/operations.md, "Analysis sessions") and ' +
        "set DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar",
    );
  }
  const database = getDatabase("radar-classify-trial", {
    statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs,
    lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs,
    settings: { default_transaction_read_only: "on" },
  });
  await assertNotLegacyDatabase(database);
  const { seed, requiredUniverseIds, quotas } = CLASSIFICATION_CONFIG.trials[trial];
  return readClassificationSample(database, { now: new Date(), seed, requiredUniverseIds, quotas, excludeUniverseIds });
}

function fileTrialStore(dir: string): TrialStore {
  const stateFile = path.join(dir, STATE_FILE);
  const thumbnailFile = (universeId: number) => path.join(dir, "thumbnails", `${universeId}.jpg`);
  const resultsFile = (model: string) => path.join(dir, `results-${model}.json`);
  return {
    readState: () => readJson<TrialState>(stateFile),
    writeState: (state) => writeJson(stateFile, state),
    readThumbnail: (universeId) => readOptional(thumbnailFile(universeId)),
    writeThumbnail: (universeId, jpeg) => writeReplacing(thumbnailFile(universeId), jpeg),
    readResults: (model) => readJson<TrialResult[]>(resultsFile(model)),
    writeResults: (model, results) => writeJson(resultsFile(model), results),
  };
}

// Null when the file does not exist.
async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  const content = await readOptional(file);
  if (content === null) return null;
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch (error) {
    throw new Error(`Cannot read ${file}`, { cause: error });
  }
}

function writeJson(file: string, value: unknown): Promise<void> {
  return writeReplacing(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Written beside the file, then renamed over it: an interrupted write leaves the previous file, not a truncated one
// that would stop the next run from reading the saved batch ids.
async function writeReplacing(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}
