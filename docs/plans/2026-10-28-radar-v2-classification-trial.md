# Classification trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run classify:trial` classifies a stratified sample of tracked games with one or two Claude models through the Message Batches API, on the owner's machine. It gives the owner the 200-game model comparison and the 100-game review that must pass before the full classification runs.

**Architecture:** `src/lib/classify/` holds what the production `classify` job will reuse later: the vocabulary, the output schema, the prompt, the request builder, result parsing and cost. It also holds the trial runner, which is resumable and keeps its state in a directory under `.data/`, so no batch is paid twice. `src/db/classification-sample.ts` draws the sample in a read-only session through the analysis tunnel. `scripts/classify-trial.ts` wires the Anthropic client, the database and the files. Nothing is written to the database. The comparison and the review are shown to the owner as Artifact pages that Claude builds in the session from the JSON files.

**Tech Stack:** TypeScript, Node, Vitest, zod 4, drizzle-orm with PostgreSQL 18 and TimescaleDB, `@anthropic-ai/sdk` (Message Batches, structured outputs, vision), `sharp` (thumbnail re-encoding).

**Spec:** `docs/plans/2026-10-26-radar-v2-phase-2-design.md`, section 5 ("Model comparison", "Owner review, before the full run"), and `docs/plans/2026-10-20-radar-v2-design.md`, section 4.

**Out of scope (next plan):** the `classifications` table and its migration, the `classify` systemd job, reclassification on fingerprint change, vocabulary merges, `format_stats`.

## Global Constraints

- Source code, identifiers, comments, tests, docs and output are in English (`AGENTS.md`).
- Domain logic goes in `src/lib`, persistence in `src/db`, the entry point in `scripts`. Every limit, price, quota and
  pattern lives in `CLASSIFICATION_CONFIG` in `src/lib/config.ts`.
- The command never writes to the database. Its session sets `default_transaction_read_only=on`, like `scripts/concept.ts`.
- It runs on the owner's machine. The Anthropic key lives in `~/.config/radar/anthropic.env` (mode 600, one line
  `ANTHROPIC_API_KEY=...`), loaded only into the command's process by Node's `--env-file-if-exists`; a variable already
  set in the shell wins. It is never exported globally: Claude Code would offer to bill its own sessions to it. Nobody
  but the owner reads or writes the file.
- A batch is submitted once per model and trial directory: its id is saved before any polling, and a rerun resumes
  polling instead of submitting again.
- No `fallbacks` parameter: the Batches API rejects it. A refusal becomes a failed classification, reported as such.
- Thumbnails are re-encoded to JPEG. Two hundred 768×432 PNGs in base64 can exceed the 256 MB batch limit.
- Database suites run only in CI (no local PostgreSQL). Before handing off, run `npm run lint`, `npm run typecheck`,
  `npm run test` and `npm run build`.

## Review Focus

- **A rerun after a crash or a timeout.** It must not submit a second batch for a model that already has one (Task 6).
- **A game without a thumbnail, or whose download fails.** It is classified from text alone, and the user content says
  so (Tasks 2 and 6).
- **A refused, truncated or schema-breaking answer.** It becomes `{ ok: false, error }` and is counted, never thrown
  (Task 2).
- **The review sample overlaps the comparison sample.** `--exclude` keeps it apart (Tasks 5 and 7).
- **Cost.** Each run's input is capped by the trial preset (200 or 100 games). The printed cost uses batch prices from
  the config (Task 3).

## Decisions taken in this plan (open to the owner's correction)

- Both models run at `effort: "low"`, the level classification needs; thinking stays adaptive (Opus 5.5 cannot disable it).
- The output schema puts `reason` first, so the answer explains itself before it commits to values.
- The 100-game review uses a fresh sample, excluding the 200 compared games: if the prompt changes after the
  comparison, the review would otherwise measure games the prompt was tuned on.
- The sample is drawn by strata that overweight the waves the design names, so the 90% gate is measured on the hardest
  cases, not only on easy established games.
- The review happens on an Artifact page with saved answers, which Claude reads back. Corrections then go to
  `src/lib/classify/overrides.ts`.

---

### Task 1: SDK, configuration, vocabulary and output schema

**Files:**
- Modify: `package.json` (dependencies `@anthropic-ai/sdk` at the latest 1.x, `sharp` at `^0.35.3`, the version Next already installs)
- Modify: `src/lib/config.ts` (append `CLASSIFICATION_CONFIG`)
- Create: `src/lib/classify/types.ts`, `src/lib/classify/vocabulary.ts`, `src/lib/classify/schema.ts`
- Test: `src/lib/classify/vocabulary.test.ts`, `src/lib/classify/schema.test.ts`

**Interfaces:**

```ts
// src/lib/classify/types.ts
export const CLASSIFICATION_MODELS = ["claude-opus-5-5", "claude-haiku-5-5"] as const;
export type ClassificationModel = (typeof CLASSIFICATION_MODELS)[number];

export interface ClassificationInput {
  universeId: number;
  name: string;
  description: string;
  genre: string | null;
  thumbnailUrl: string | null;
  robloxCreatedAt: string; // ISO 8601
  peakCcu: number; // all-time daily peak in game_daily_all, 0 when the radar has none
  stratum: string; // the sample stratum that selected the game
}

export interface ThumbnailImage {
  mediaType: "image/jpeg";
  data: string; // base64
}

export interface ClassificationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ClassificationOutcome =
  | { ok: true; classification: GameClassification; usage: ClassificationUsage }
  | { ok: false; error: string; usage: ClassificationUsage | null };

export interface TrialResult {
  universeId: number;
  model: ClassificationModel;
  hadThumbnail: boolean;
  outcome: ClassificationOutcome;
}

export interface VocabularyEntry {
  value: string;
  meaning: string;
  examples: string[];
}

export interface ClassificationVocabulary {
  families: VocabularyEntry[];
  templates: VocabularyEntry[];
  rewardLoops: VocabularyEntry[];
}
```

`GameClassification` is imported from `schema.ts`.

```ts
// src/lib/classify/schema.ts
import { z } from "zod";

export const PROGRESSIONS = ["stat growth", "collection", "upgrades", "rebirths", "stages", "levels", "skill", "none"] as const;
export const SOCIAL_STRUCTURES = ["solo", "co-op", "pvp", "theft", "hangout"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

// Property order is output order: the reason comes first, so the answer explains itself before it commits to values.
export const gameClassificationSchema = z.strictObject({
  reason: z.string(),
  family: z.string(),
  template: z.string(),
  rewardLoop: z.string(),
  coreAction: z.string(),
  theme: z.string(),
  setting: z.string(),
  progression: z.enum(PROGRESSIONS),
  social: z.enum(SOCIAL_STRUCTURES),
  confidence: z.enum(CONFIDENCES),
});
export type GameClassification = z.infer<typeof gameClassificationSchema>;

// The JSON schema sent as output_config.format.schema, without the "$schema" key.
export const classificationJsonSchema: Record<string, unknown>;
```

`CLASSIFICATION_CONFIG` (append to `src/lib/config.ts`, with these comments):

```ts
// The classification trial (docs/plans/2026-10-28-radar-v2-classification-trial.md); the production job reuses the
// request settings, prices and description length.
export const CLASSIFICATION_CONFIG = {
  effort: "low",
  // Thinking counts against it; a classification answer is a few hundred tokens.
  maxTokens: 8_000,
  // Descriptions are keyword-stuffed: the start carries the pitch, the rest is codes and update notes.
  descriptionMaxCharacters: 1_000,
  thumbnailJpegQuality: 80,
  thumbnailDownloadConcurrency: 8,
  batchPollIntervalMs: 30_000,
  // Most batches end within an hour; a rerun of the command resumes polling after this.
  batchMaximumWaitMs: 2 * 60 * 60_000,
  // USD per million tokens, Anthropic list prices on 2026-10-28. A 5-minute cache write costs 1.25 times the input
  // price. Batches bill half of every price.
  pricing: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  },
  cacheWriteMultiplier: 1.25,
  batchDiscount: 0.5,
  sample: {
    youngDays: 60,
    // Postgres regular expressions on the title, tried in this order; the first match sets the game's stratum.
    waves: [
      { stratum: "plus-one", pattern: "(^|[^0-9a-z])\\+1([^0-9]|$)" },
      { stratum: "verb-for-reward", pattern: "\\mfor\\M.*\\m(eggs?|animals?|pets?|dinos?|brainrots?)\\M" },
      { stratum: "steal", pattern: "\\msteal\\M" },
      { stratum: "eggs", pattern: "\\meggs?\\M" },
      { stratum: "fart", pattern: "\\mfart" },
    ],
    // Young games that match no wave, by all-time peak CCU.
    youngPeakBuckets: [
      { stratum: "young-under-100", below: 100 },
      { stratum: "young-100-1k", below: 1_000 },
      { stratum: "young-1k-10k", below: 10_000 },
      { stratum: "young-10k-plus", below: null },
    ],
  },
  trials: {
    // The owner's +1 Stone Skipping is always in the comparison.
    comparison: {
      seed: "comparison-2026-10-28",
      requiredUniverseIds: [10765298801],
      quotas: {
        "plus-one": 20, "verb-for-reward": 12, steal: 12, eggs: 16, fart: 5,
        "young-under-100": 25, "young-100-1k": 30, "young-1k-10k": 30, "young-10k-plus": 25, established: 24,
      },
    },
    review: {
      seed: "review-2026-10-28",
      requiredUniverseIds: [],
      quotas: {
        "plus-one": 10, "verb-for-reward": 6, steal: 6, eggs: 8, fart: 2,
        "young-under-100": 13, "young-100-1k": 15, "young-1k-10k": 15, "young-10k-plus": 13, established: 12,
      },
    },
  },
} as const;
```

The comparison quotas plus the required game sum to 200; the review quotas sum to 100.

- [ ] **Step 1: Install the dependencies.** `npm install @anthropic-ai/sdk sharp@^0.35.3`. Check that `package.json` lists both under `dependencies` and that `npx tsc --noEmit` still passes.

- [ ] **Step 2: Write the failing tests.**
  - `vocabulary.test.ts`:
    - every value is unique within its list, ignoring case;
    - every entry has a meaning and at least one example;
    - each list contains its fallback: families `other`, templates `none`, reward loops `none`;
    - the families contain `+1`, `Steal a` and `{verb} for {reward}`, and the reward loops contain both `eggs` and `pets`.
  - `schema.test.ts`:
    - a complete answer parses;
    - an answer with an extra key, or a progression outside the list, fails;
    - `classificationJsonSchema` has `additionalProperties: false`, lists all ten properties as required in schema
      order with `reason` first, and has no `$schema` key.

- [ ] **Step 3: Run them to see them fail**: `npx vitest run src/lib/classify`, FAIL (modules missing).

- [ ] **Step 4: Implement** `types.ts`, `schema.ts` (`z.toJSONSchema(gameClassificationSchema)` without `$schema`), `CLASSIFICATION_CONFIG`, and `vocabulary.ts` with exactly this content:

```ts
import type { ClassificationVocabulary } from "./types";

// The starting vocabulary, seeded from production titles on 2026-10-26 and 2026-10-28 (phase 2 design, section 2).
// The model reuses a value when one fits and proposes a new one otherwise; the production job will add the values it
// learns, and merges will fold near-duplicates.
export const CLASSIFICATION_VOCABULARY: ClassificationVocabulary = {
  families: [
    { value: "+1", meaning: "A stat grows by one for every second, step or action, and the bigger stat takes the player further. The title starts with or contains +1.", examples: ["+1 Speed Keyboard Escape", "+1 Stone Skipping", "+1 Karate Evolution"] },
    { value: "Steal a", meaning: "Players own a base of units that earn money, buy or win more units, and steal other players' units.", examples: ["Steal a Brainrot", "Steal An Egg", "Break and Steal an Egg"] },
    { value: "{verb} for {reward}", meaning: "One repeated action earns the reward the title names, usually eggs or animals.", examples: ["Bike For Egg!", "Climb For Animals Eggs", "Backflip for Animals!"] },
    { value: "{verb} a {thing}", meaning: "One simple action on one object named in the title, upgraded over time.", examples: ["Ride A Pet", "Kick a Lucky Block", "Chop A Forest"] },
    { value: "simulator", meaning: "A clicker or training loop: click or train, rebirth, unlock areas, often with pets.", examples: ["Tap Simulator REBORN", "Pet Simulator 99!"] },
    { value: "tycoon", meaning: "Build and expand a business or base that makes money on its own.", examples: ["Prince's Pizza Tycoon", "Halloween Tycoon"] },
    { value: "obby", meaning: "An obstacle course or a tower to climb, stage by stage.", examples: ["Tower of Hell"] },
    { value: "escape", meaning: "Run from a disaster, a chaser or a rising danger to a safe zone.", examples: ["Escape the Tsunami", "100 Players Escape Lava"] },
    { value: "RNG", meaning: "Roll for random auras, items or characters ranked by rarity.", examples: ["Sol's RNG", "Underground Artist RNG"] },
    { value: "tower defense", meaning: "Place units along a path to stop waves of enemies.", examples: ["Tower Defense Simulator", "Cameraman Tower Defense"] },
    { value: "battlegrounds", meaning: "Fight other players with characters and special moves.", examples: ["The Strongest Battlegrounds", "Jujutsu Shenanigans"] },
    { value: "anomaly", meaning: "Work a shift in a shop or a post and spot strange changes or dangers.", examples: ["Sell Fries! [Anomaly]", "Scary Shawarma Kiosk: the ANOMALY"] },
    { value: "horror", meaning: "Explore, hide from and survive monsters, alone or together.", examples: ["DOORS", "Piggy", "Dandy's World"] },
    { value: "killers vs survivors", meaning: "In rounds, one side hunts and the other hides, escapes or fights back.", examples: ["Murder Mystery 2", "Forsaken", "Flee the Facility"] },
    { value: "survival", meaning: "Gather, craft and survive nights or a journey.", examples: ["99 Nights in the Forest", "Dead Rails"] },
    { value: "roleplay", meaning: "Live a life in a town or a home with others, with no imposed goal.", examples: ["Brookhaven RP", "Berry Avenue RP", "Adopt Me!"] },
    { value: "dress up", meaning: "Style an avatar or a face for a theme and get voted on.", examples: ["Dress To Impress", "Facecard: Makeup Showdown"] },
    { value: "shooter", meaning: "Shoot other players in rounds or arenas.", examples: ["RIVALS"] },
    { value: "sports", meaning: "Play a sport, alone or in teams.", examples: ["Volleyball Legends", "Blue Lock: Rivals"] },
    { value: "driving", meaning: "Drive, race or tune vehicles.", examples: ["DRIVE: Highway", "Drag Drive Simulator"] },
    { value: "fishing", meaning: "Cast, catch, sell and index fish.", examples: ["Fisch", "Fish It!"] },
    { value: "gardening", meaning: "Plant, grow and sell crops.", examples: ["Grow a Garden"] },
    { value: "anime RPG", meaning: "Quest, level up and gain powers in an anime-inspired world.", examples: ["Blox Fruits", "Anime Zero"] },
    { value: "physics sandbox", meaning: "Throw, fling or ragdoll players and objects for fun.", examples: ["Fling Things and People", "Ragdoll Reality"] },
    { value: "modded copy", meaning: "An unofficial copy of a hit with boosted multipliers or an admin panel.", examples: ["SAE X9999 + MODDED ADMIN PANEL", "EGG but X9999999 [MODDED]"] },
    { value: "other", meaning: "None of the above, and no new family stands out.", examples: ["Catalog Avatar Creator"] },
  ],
  templates: [
    { value: "+1 {stat} per {action}", meaning: "+1 with the stat and the action that raises it.", examples: ["+1 Gaming Per Click"] },
    { value: "+1 {thing}", meaning: "+1 followed by the activity or the object, without Escape or Evolution.", examples: ["+1 Stone Skipping", "+1 Anime Eyes"] },
    { value: "+1 {thing} Escape", meaning: "+1 where the growing stat carries the player along an escape course.", examples: ["+1 Speed Keyboard Escape", "+1 Tongue Escape", "+1 Car Escape"] },
    { value: "+1 {thing} Evolution", meaning: "+1 where the growing stat evolves a character or a creature.", examples: ["+1 Karate Evolution", "+1 Hulk Evolution"] },
    { value: "+1 {action} for {reward}", meaning: "+1 where the action also earns a named reward.", examples: ["+1 Pickaxe Swing for Eggs", "+1 Melt Ice for Dinos!"] },
    { value: "Steal a {thing}", meaning: "Steal a, with the stolen unit in the title.", examples: ["Steal a Brainrot", "Steal An Egg", "Steal an Clown Egg"] },
    { value: "{verb} to Steal a {thing}", meaning: "Steal a, with an action that opens the way to steal.", examples: ["Break and Steal an Egg", "Slash to Steal an Egg"] },
    { value: "{verb} for {reward}", meaning: "The action, then for and the reward.", examples: ["Bike For Egg!", "Climb For Animals Eggs", "Break Tape For Eggs!"] },
    { value: "{verb} a {thing}", meaning: "The action and its object.", examples: ["Ride A Pet", "Kick a Lucky Block", "Chop A Forest"] },
    { value: "{thing} Simulator", meaning: "A theme followed by Simulator.", examples: ["Tap Simulator", "Drag Drive Simulator"] },
    { value: "{thing} Tycoon", meaning: "A theme followed by Tycoon.", examples: ["Prince's Pizza Tycoon"] },
    { value: "{thing} RNG", meaning: "A theme followed by RNG.", examples: ["Sol's RNG", "HyperGamy RNG"] },
    { value: "{thing} Tower Defense", meaning: "A theme followed by Tower Defense.", examples: ["Cameraman Tower Defense"] },
    { value: "{thing} Battlegrounds", meaning: "A theme followed by Battlegrounds.", examples: ["The Strongest Battlegrounds"] },
    { value: "Escape {danger}", meaning: "Escape and the danger.", examples: ["Escape the Tsunami", "100 Players Escape Lava"] },
    { value: "{thing} RP", meaning: "A place or a theme followed by RP.", examples: ["Brookhaven RP", "Berry Avenue RP"] },
    { value: "{hit} X{multiplier} MODDED", meaning: "A hit's name or initials with a multiplier and a modded or admin marker.", examples: ["SAE X9999 + MODDED ADMIN PANEL"] },
    { value: "none", meaning: "The title is a name, not a reusable pattern.", examples: ["DOORS", "Murder Mystery 2", "The Hollow"] },
  ],
  rewardLoops: [
    { value: "eggs", meaning: "Eggs are what the player collects, steals, buys or hatches. This is the egg wave; it stays apart from pets even when eggs hatch pets.", examples: ["Steal An Egg", "Bike For Egg!", "Climb For Animals Eggs"] },
    { value: "pets", meaning: "Pets, animals or creatures collected as companions or boosters, without eggs as the hook.", examples: ["Ride A Pet", "Pet Simulator 99!", "Backflip for Animals!"] },
    { value: "brainrots", meaning: "Brainrot meme characters collected or stolen.", examples: ["Steal a Brainrot"] },
    { value: "stats", meaning: "A growing number such as speed, strength, size or jump.", examples: ["+1 Speed Keyboard Escape"] },
    { value: "money", meaning: "Cash that buys upgrades or expands a base.", examples: ["Prince's Pizza Tycoon", "Paint to Get Rich"] },
    { value: "rarity rolls", meaning: "Random auras, items or characters ranked by rarity.", examples: ["Sol's RNG"] },
    { value: "units", meaning: "Units, towers or fighters to deploy.", examples: ["Tower Defense Simulator", "Command An Army"] },
    { value: "loot", meaning: "Weapons, tools or gear found, forged or upgraded.", examples: ["+1 Loot To Forge"] },
    { value: "powers", meaning: "Fruits, abilities or characters with moves.", examples: ["Blox Fruits", "The Strongest Battlegrounds"] },
    { value: "cosmetics", meaning: "Outfits, skins or avatar items.", examples: ["Dress To Impress"] },
    { value: "catches", meaning: "Fish or creatures caught, sold or indexed.", examples: ["Fisch"] },
    { value: "plants", meaning: "Seeds and crops.", examples: ["Grow a Garden"] },
    { value: "progress", meaning: "Getting further, by stages, distance or wins, with nothing to collect.", examples: ["Tower of Hell", "Escape the Tsunami"] },
    { value: "none", meaning: "No lasting reward: rounds, hangouts or stories.", examples: ["RIVALS", "Brookhaven RP", "DOORS"] },
  ],
};
```

- [ ] **Step 5: Run them to see them pass**, then commit `chore(deps): add the Anthropic SDK and sharp` (package files only) and `feat(classify): seed the format vocabulary and the output schema`.

### Task 2: Prompt, request and result parsing

**Files:**
- Create: `src/lib/classify/prompt.ts`, `src/lib/classify/request.ts`
- Test: `src/lib/classify/prompt.test.ts`, `src/lib/classify/request.test.ts`

**Interfaces:**

```ts
// prompt.ts
export const CLASSIFICATION_PROMPT_VERSION = 1;
export function classificationSystemPrompt(vocabulary?: ClassificationVocabulary): string; // default CLASSIFICATION_VOCABULARY
export function classificationUserContent(input: ClassificationInput, image: ThumbnailImage | null): Anthropic.ContentBlockParam[];

// request.ts
export function classificationCustomId(universeId: number): string; // "u<universeId>"
export function universeIdFromCustomId(customId: string): number | null;
export function classificationRequest(
  model: ClassificationModel,
  input: ClassificationInput,
  image: ThumbnailImage | null,
  system?: string, // default classificationSystemPrompt(); callers building many requests pass it once
): Anthropic.Messages.MessageCreateParamsNonStreaming;
export function readClassification(message: Anthropic.Message): ClassificationOutcome;
export function readBatchResult(result: Anthropic.Messages.MessageBatchIndividualResponse): { universeId: number; outcome: ClassificationOutcome } | null;
```

The system prompt, exactly (the three lists are rendered from the vocabulary as
``- `value`: meaning Examples: "a", "b".``):

```text
You classify Roblox games for a trend radar. A Roblox developer uses it to see which game formats are rising and who already tried an idea. You receive a game's thumbnail when it has one, its title, its Roblox genre and the start of its description. Answer in the given JSON schema.

How to read a game:
- Trust the title and the thumbnail first. Descriptions are often stuffed with keywords, codes and update notes; use them only to settle a doubt.
- Ignore event and update markers: bracketed text such as [🎃], [UPD 3] or [WORLD 2], countdowns, emojis, "NEW", "UPDATE" and "BETA".
- Titles can be in any language. Classify the game, not the language.
- A copy of a hit keeps the hit's family and template even when its theme differs: "Steal an Clown Egg" is a `Steal a` game.

Fields:
- reason: one sentence on what decided the family, the template and the reward loop.
- family: the genre the developer would name for the game, such as `+1`, `Steal a` or `obby`.
- template: the reusable title pattern within the family, with the variable parts in braces, such as `+1 {thing} Escape` or `{verb} for {reward}`. Use `none` when the title is a name rather than a pattern.
- rewardLoop: what the player collects or grows in the core loop. `eggs` is its own value, apart from `pets`.
- coreAction: what the player does most of the time, as a lowercase base-form verb and its object, one to three words: `skip stones`, `ride pets`, `steal eggs`.
- theme: the main object or theme, one to three lowercase words.
- setting: where the game takes place, one to three lowercase words.
- progression and social: one of the listed values. `theft` is for games where stealing from other players is the core loop.
- confidence: `high` when the title and the thumbnail leave no doubt about the family, the template and the reward loop; `low` when you mostly guessed.

Known values. Reuse a known value whenever one fits, written exactly as listed. When none fits and the game belongs to a format other games could share, write a new short value in the same style: a new format must appear as a new value, not be forced into an old one. Use `other` as a family only when no format stands out.

Families:
{families}

Templates:
{templates}

Reward loops:
{rewardLoops}
```

The user content: the image block first when there is one (`{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }`), then one text block:

```text
Thumbnail: none            <- only when image is null
Title: {name}
Roblox genre: {genre, or "none"}
Description (first 1000 characters): {description cut at CLASSIFICATION_CONFIG.descriptionMaxCharacters, followed by "…" when cut}
```

When the description is empty after trimming, the last line is `Description: (empty)`; when it is not cut, the label is
`Description:`.

The request: `model`, `max_tokens: CLASSIFICATION_CONFIG.maxTokens`, `system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]`, `messages: [{ role: "user", content }]`, `output_config: { effort: CLASSIFICATION_CONFIG.effort, format: { type: "json_schema", schema: classificationJsonSchema } }`. No `thinking` (adaptive by default on both models), no `temperature`, no `fallbacks`.

`readClassification` order: usage first (null cache fields read as 0); then `stop_reason` `"refusal"` gives
`refused (<stop_details.category or "no category">)`; `"max_tokens"` gives `ran out of tokens`; no text block gives
`no text in the answer`; a JSON parse error gives `invalid JSON`; a zod failure gives
`schema mismatch: <first issue path and message>`. A success trims every string field.

`readBatchResult`: `null` for a custom id that is not `u<digits>`. `succeeded` gives `readClassification(result.message)`; `errored` gives `{ ok: false, error: "batch error: <type>: <message>", usage: null }`; `canceled` and `expired` give `{ ok: false, error: "canceled" | "expired", usage: null }`.

- [ ] **Step 1: Write the failing tests.**
  - `prompt.test.ts`:
    - the system prompt names every vocabulary value in backticks, under its heading;
    - it is identical across calls, so it can be cached;
    - the user content of a game with an image is the image block, then the text;
    - without an image, it is the text alone, starting `Thumbnail: none`;
    - a 1,500-character description is cut at 1,000 and ends with `…`;
    - an empty description reads `Description: (empty)`;
    - a null genre reads `Roblox genre: none`.
  - `request.test.ts`:
    - the request carries the model, effort `low`, the JSON schema, the cached system block and no `thinking` key;
    - `classificationCustomId(10765298801)` round-trips;
    - `universeIdFromCustomId("x1")` is null;
    - `readClassification` covers a success with trimmed strings and usage, a refusal with category `cyber`,
      `max_tokens`, invalid JSON and an answer missing `family`;
    - `readBatchResult` covers `succeeded`, `errored`, `expired` and a foreign custom id.

    Build the messages as plain objects cast to `Anthropic.Message`.

- [ ] **Step 2: Run them to see them fail**: `npx vitest run src/lib/classify/prompt.test.ts src/lib/classify/request.test.ts`, FAIL.

- [ ] **Step 3: Implement** `prompt.ts` and `request.ts`. Use the SDK's types; let `npm run typecheck` name the exact
  ones (`Anthropic.Messages.MessageBatchIndividualResponse` and the `output_config` shape) if they differ from the
  names above.

- [ ] **Step 4: Run them to see them pass**, then commit `feat(classify): build classification requests and read their answers`.

### Task 3: Cost and model comparison

**Files:**
- Create: `src/lib/classify/cost.ts`, `src/lib/classify/compare.ts`
- Test: `src/lib/classify/cost.test.ts`, `src/lib/classify/compare.test.ts`

**Interfaces:**

```ts
// cost.ts
export function classificationCostUsd(model: ClassificationModel, usage: ClassificationUsage, options: { batch: boolean }): number;

// compare.ts
export const COMPARED_FIELDS = ["family", "template", "rewardLoop", "coreAction"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number] | "format"; // format: family, template and reward loop together

export interface FieldAgreement { field: ComparedField; compared: number; agreed: number; share: number | null }
export interface ModelRunSummary {
  model: ClassificationModel;
  games: number;
  classified: number;
  failures: { universeId: number; error: string }[];
  withoutThumbnail: number;
  costUsd: number; // batch prices
  costPerGameUsd: number | null;
  // Values outside the vocabulary, compared ignoring case, with how many games used each, most used first.
  newValues: Record<"family" | "template" | "rewardLoop", { value: string; games: number }[]>;
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
export function normalizeValue(value: string): string; // lowercase, trimmed, inner whitespace collapsed
export function summarizeRun(model: ClassificationModel, inputs: ClassificationInput[], results: TrialResult[], vocabulary?: ClassificationVocabulary): ModelRunSummary;
export function compareModels(inputs: ClassificationInput[], results: TrialResult[], models: [ClassificationModel, ClassificationModel], vocabulary?: ClassificationVocabulary): ModelComparison;
```

Cost per million tokens: `input × inputTokens + output × outputTokens + cacheRead × cacheReadInputTokens + input × cacheWriteMultiplier × cacheCreationInputTokens`, times `batchDiscount` when `batch`. A failed outcome with usage still costs its usage.

- [ ] **Step 1: Write the failing tests.**
  - `cost.test.ts`: Opus, 3,000 input, 500 output, 2,000 cache read and 1,000 cache write tokens cost
    (3,000×4 + 500×20 + 2,000×0.2 + 1,000×5) / 1,000,000 = $0.0274 at full price and $0.0137 in a batch; the same usage on Haiku costs
    (300 + 250 + 20 + 125) / 1,000,000 = $0.000695, and $0.0003475 in a batch.
  - `compare.test.ts`, three games and two models:
    - game 1 agrees, with `Steal a` against `steal a ` (agreement ignores case and spaces);
    - game 2 differs on template and reward loop;
    - game 3 failed for the second model.

    Expect the family agreement to be 2 of 2, the template and format agreement 1 of 2, one disagreement listing
    `template`, `rewardLoop` and `format`, and the second run's `failures` holding game 3. A family `fishing RNG`
    is a new value used by one game; `steal a` is not new. Cost per game is null when nothing was classified.

- [ ] **Step 2: Run them to see them fail**, implement, run them to see them pass.

- [ ] **Step 3: Commit** `feat(classify): price a classification run and compare two models`.

### Task 4: Thumbnails

**Files:**
- Create: `src/lib/classify/thumbnails.ts`
- Test: `src/lib/classify/thumbnails.test.ts`

**Interface:**

```ts
// Downloads a stored 16:9 thumbnail and re-encodes it as JPEG; null when the URL is null, the response is not 2xx or
// the body is not an image. Never throws.
export async function downloadThumbnailJpeg(url: string | null, fetchImage?: typeof fetch): Promise<Buffer | null>;
```

Use `sharp(body).jpeg({ quality: CLASSIFICATION_CONFIG.thumbnailJpegQuality }).toBuffer()`, with a timeout of
`EXTERNAL_REQUEST_CONFIG.defaultTimeoutMs` (`AbortSignal.timeout`). Roblox CDN images are not rate-limited like the
APIs, so this does not go through `fetchJson`.

- [ ] **Step 1: Write the failing tests** with a fake fetch: a 768×432 PNG made with `sharp({ create: ... }).png().toBuffer()` returns a JPEG (first bytes `ff d8`) of the same size (`sharp(buffer).metadata()`); a 404, a text body and a null URL return null; a rejected fetch returns null.
- [ ] **Step 2: Run them to see them fail**, implement, run them to see them pass.
- [ ] **Step 3: Commit** `feat(classify): download thumbnails as JPEG`.

### Task 5: The stratified sample

**Files:**
- Create: `src/db/classification-sample.ts`
- Test: `src/db/classification-sample.db.test.ts` (runs in CI only)

**Interface:**

```ts
export interface SampleOptions {
  now: Date;
  seed: string;
  requiredUniverseIds: readonly number[];
  quotas: Readonly<Record<string, number>>;
  excludeUniverseIds: readonly number[];
}
// Inputs ordered by stratum (in CLASSIFICATION_CONFIG.sample order: required, the waves, the young buckets,
// established), then by the seeded hash.
export async function readClassificationSample(db: Database, options: SampleOptions): Promise<ClassificationInput[]>;
```

One statement:
- **Peaks:** `max(ccu_peak)` per universe from `game_daily_all`.
- **Stratum of each game:** the first that applies.
  1. `required` when the id is in `requiredUniverseIds`;
  2. the first wave whose pattern matches the name (`~*`);
  3. a young bucket when `roblox_created_at > now - youngDays`, by peak (`below` null catches the rest);
  4. `established` otherwise.
- **Draw:** `row_number() over (partition by stratum order by md5(universe_id::text || seed), universe_id)`. Keep the
  rows whose rank is within the stratum's quota (`unnest` of names and quotas); `required` takes every row.
- **Excluded:** games in `excludeUniverseIds`.
- **Returned:** `peakCcu` 0 for games without a peak, and `robloxCreatedAt` as ISO 8601.

The waves and buckets come from `CLASSIFICATION_CONFIG.sample`; build the `case` with `sql.join`.

- [ ] **Step 1: Write the failing database test**, built like `src/db/concept.db.test.ts`, with `gameDetail` and `writeGameObservations`.
  - **Data:**
    - `+1 Stone Skipping`, required, created 2026-09-05;
    - three `+1` games;
    - `Bike For Egg!` and `Steal An Egg`;
    - a young game with a peak of 50 and another with a peak of 5,000;
    - one established game.
  - **Quotas:** `plus-one` 2, `verb-for-reward` 1, `steal` 1, every other stratum 1. Expect:
    - the required game is present even though it matches the `+1` pattern;
    - exactly 2 of the 3 other `+1` games, the same 2 on a second call with the same seed;
    - `Bike For Egg!` is `verb-for-reward`, not `eggs`;
    - `Steal An Egg` is `steal`;
    - the young games are in their peak buckets, and the old game is `established`.
  - **Exclusion:** excluding one of the drawn `+1` games brings in the third.
- [ ] **Step 2: Run it**: `npx vitest run src/db/classification-sample.db.test.ts` is skipped locally; `npm run typecheck` FAILS (module missing).
- [ ] **Step 3: Implement `readClassificationSample`.**
- [ ] **Step 4: Typecheck passes; commit** `feat(db): draw a stratified sample of games to classify`. The suite runs in CI on the pull request.

### Task 6: The resumable trial runner

**Files:**
- Create: `src/lib/classify/trial.ts`
- Test: `src/lib/classify/trial.test.ts`

**Interfaces:**

```ts
export interface TrialState {
  promptVersion: number;
  batches: Partial<Record<ClassificationModel, { id: string; submittedAt: string; requests: number }>>;
}
// The trial directory, abstracted for tests. scripts/classify-trial.ts implements it on the file system.
export interface TrialStore {
  readState(): Promise<TrialState | null>;
  writeState(state: TrialState): Promise<void>;
  readThumbnail(universeId: number): Promise<Buffer | null>;
  writeThumbnail(universeId: number, jpeg: Buffer): Promise<void>;
  readResults(model: ClassificationModel): Promise<TrialResult[] | null>;
  writeResults(model: ClassificationModel, results: TrialResult[]): Promise<void>;
}
// The subset of client.messages.batches the runner uses.
export interface BatchApi {
  create(params: { requests: { custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming }[] }): Promise<{ id: string }>;
  retrieve(id: string): Promise<{ processing_status: string; request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number } }>;
  results(id: string): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
}
export interface TrialDependencies {
  store: TrialStore;
  batches: BatchApi;
  downloadThumbnail: (url: string | null) => Promise<Buffer | null>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}
export async function runClassificationTrial(
  inputs: ClassificationInput[],
  models: readonly ClassificationModel[],
  dependencies: TrialDependencies,
  options?: { pollIntervalMs?: number; maximumWaitMs?: number }, // CLASSIFICATION_CONFIG defaults
): Promise<{ results: TrialResult[]; pending: ClassificationModel[] }>;
```

Order:
1. **Prompt version.** A stored state of another `CLASSIFICATION_PROMPT_VERSION` throws
   `Trial directory holds prompt version N; use a new directory`.
2. **Thumbnails.** Fetch the missing ones, `thumbnailDownloadConcurrency` at a time, and store each JPEG.
3. **Submission.** Each model without a stored result file or batch gets one batch of every input, with the system
   prompt built once. The state is written right after each `create`.
4. **Polling.** Poll every pending batch until it ends or `maximumWaitMs` passes, logging the request counts.
5. **Collection.** An ended batch's results are read once and stored. A stored result file is reused on later runs.
6. **Return.** The results of the finished models, sorted by universe id then model, and the models still pending.

`hadThumbnail` records whether an image went with the request.

- [ ] **Step 1: Write the failing tests** with an in-memory store and a fake `BatchApi` that ends a batch after N `retrieve` calls and answers each custom id.
  - `"submits one batch per model and saves its id before polling"`: the state holds both ids when the first
    `retrieve` is called.
  - `"resumes a stored batch instead of submitting again"`: a state with an Opus batch and no results leads to one
    `create` (Haiku) and to the stored Opus id being polled.
  - `"reuses stored results"`: a stored result file means no `create` and no `retrieve` for that model.
  - `"returns pending models after the maximum wait"`: a batch that never ends is in `pending`, its state is kept, and
    nothing is stored for it.
  - `"classifies without an image when the thumbnail is missing"`: the request of a game whose download returned null
    has no image block, and its result has `hadThumbnail: false`.
  - `"refuses a directory of another prompt version"`.
- [ ] **Step 2: Run them to see them fail**, implement, run them to see them pass.
- [ ] **Step 3: Commit** `feat(classify): run a resumable classification trial through the Batches API`.

### Task 7: The command and its documentation

**Files:**
- Create: `scripts/classify-trial.ts`
- Modify: `package.json` (script `"classify:trial": "tsx --env-file-if-exists=$HOME/.config/radar/anthropic.env scripts/classify-trial.ts"`), `README.md` (commands table, after `npm run concept`), `docs/operations.md` ("Analysis sessions")

**Usage:**

```text
npm run classify:trial -- --trial comparison|review --dir <directory> [--models <model>[,<model>]] [--exclude <directory>]...
```

- `--trial` picks the preset in `CLASSIFICATION_CONFIG.trials`; `--models` defaults to both `CLASSIFICATION_MODELS` and
  accepts only them.
- **Sample.** When `<dir>/sample.json` is missing, the command draws the sample through `DATABASE_URL`. It opens the
  read-only session of `scripts/concept.ts`, runs `assertNotLegacyDatabase`, excludes the universe ids of each
  `--exclude` directory's `sample.json`, and writes `sample.json`. A stored `sample.json` is reused, so a rerun needs
  no tunnel.
- **Files** under `<dir>`: `state.json`, `thumbnails/<universeId>.jpg`, `results-<model>.json`, then `comparison.json`
  with two models or `summary.json` with one.
- **Anthropic client.** `new Anthropic()`. A missing key fails before the sample is drawn or any request is sent,
  with a message that names `ANTHROPIC_API_KEY` and `~/.config/radar/anthropic.env`.
- **Output.** Lines like these:

```text
Comparison of claude-opus-5-5 and claude-haiku-5-5 on 200 games (prompt v1)
Classified: claude-opus-5-5 200, claude-haiku-5-5 199 (1 failed); 3 without thumbnail
Agreement: family 88% (176/199), template 80% (159/199), reward loop 85% (169/199), core action 41% (82/199), format 72% (143/199)
Cost at batch prices: claude-opus-5-5 $2.91 ($0.0146 a game), claude-haiku-5-5 $0.07 ($0.0004 a game)
New values: claude-opus-5-5 4 families, 9 templates, 2 reward loops; claude-haiku-5-5 6 families, 12 templates, 3 reward loops
57 disagreements in <dir>/comparison.json
```

  With models still pending, it prints `Still processing: <models>. Run the same command again to resume.` and exits 0.
- **Exit codes.** 1 on a usage error or an exception (logged with `logger.error`). Always close the database with
  `closeDatabaseWithin`.

- [ ] **Step 1: Write `scripts/classify-trial.ts`** and its file-system `TrialStore` (`fs/promises`, JSON with two-space indentation, directories created on write).
- [ ] **Step 2: Document the command.**
  - **README.** One row: the command classifies a sample of tracked games with Claude through the Batches API, on the
    owner's machine, with the key in `~/.config/radar/anthropic.env` and, for a new trial, the analysis tunnel. It costs a few dollars and
    never writes to the database.
  - **`docs/operations.md`, "Analysis sessions".** Add after the concept check:

    ```bash
    DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npm run classify:trial -- --trial comparison --dir .data/classification/comparison-1
    ```

    Add the review with `--exclude`, and say that a rerun of the same command resumes without paying twice.
- [ ] **Step 3: Validate**: `npm run validate`, where lint, typecheck, test and build all pass.
- [ ] **Step 4: Commit** `feat(classify): run a classification trial from the command line`, push the branch and open a pull request. CI runs `src/db/classification-sample.db.test.ts`.

---

## Session tasks (Claude with the owner, after Task 7)

These steps spend money and need the owner. Claude runs the commands from the worktree; the owner provides the key.

- [ ] **S1: Prerequisites.**
  - **Key.** The owner writes `~/.config/radar/anthropic.env` (mode 600) from their own terminal and sets a spend
    limit in the Anthropic console. Done on 2026-10-28; a free `models.retrieve` call reached both models.
  - **Tunnel.** Claude opens it: `ssh -f -N -L 15432:/var/run/postgresql/.s.PGSQL.5432 radar-analysis`.
- [ ] **S2: Comparison run.**
  - **Command.**
    `DATABASE_URL=postgresql://radar_analysis@localhost:15432/radar npm run classify:trial -- --trial comparison --dir .data/classification/comparison-1`.
    Rerun it until nothing is pending.
  - **Cost.** Expected under $5: about $3 for Opus and under $0.10 for Haiku at batch prices.
  - **Notes.** Record the printed summary, the measured cost per game, and the extrapolations below in the execution
    notes:
    - the full run, about 13,650 games on 2026-10-28;
    - a month of 200–500 new games a day.
- [ ] **S3: Model choice.**
  - **Page.** Claude reads `comparison.json` and every disagreement, with each thumbnail, and builds an Artifact page:
    the agreement figures and costs, then each disagreement with its thumbnail, the two answers side by side, and
    Claude's opinion of which is right and why.
  - **Decision.** The owner chooses the model. The choice and its reason go in the execution notes.
  - **Vocabulary.** Values that both models invented go into the vocabulary when the owner agrees; that bumps
    `CLASSIFICATION_PROMPT_VERSION`.
- [ ] **S4: Review run.**
  - **Command.**
    `npm run classify:trial -- --trial review --dir .data/classification/review-1 --models <chosen> --exclude .data/classification/comparison-1`,
    with the tunnel for the sample.
- [ ] **S5: Owner review.**
  - **Preparation.** Claude checks each of the 100 answers against its title and thumbnail, and flags its doubts.
  - **Page.** An Artifact page, using the `artifact-capabilities` skill for saved answers. For each game it shows the
    thumbnail, the title, the four format fields (family, template, reward loop, core action) and Claude's doubt. The
    owner confirms each row, or corrects a field. About 30–45 minutes.
  - **Accuracy.** Claude reads the saved answers back. A row counts as correct when the owner confirms the three
    format fields (family, template, reward loop). Core action corrections are counted apart, since the design does not
    put core action in the format.
  - **Overrides.** Corrections go to `src/lib/classify/overrides.ts`: a typed list of
    `{ universeId, field, value, reason, decidedAt }` with a test for unique `universeId` + `field`. Commit
    `feat(classify): record the owner's review corrections`.
  - **Gate.** At 90% or more, the full classification may run (next plan). Below 90%, revise the prompt or the
    vocabulary, bump `CLASSIFICATION_PROMPT_VERSION` and repeat S4–S5 in `review-2`, excluding both earlier
    directories.
- [ ] **S6: Merge.**
  - **Notes.** The execution notes record the numbers and decisions.
  - **Merge.** Merging to `main` deploys to production. The command does not run there and the change adds no
    migration or unit. It happens with the owner's approval once CI is green.

---

## Execution notes

(Record decisions and surprises here as tasks complete; committed code is authoritative over the code blocks above.)

- **Task 1** (`a7b1e12`, `d96c419`):
  - `sharp` is at `^0.35.5`, not `^0.35.3`. `npm audit` flags 0.35.3 for libheif and librsvg advisories in image
    decoding, which the trial does; Next's `^0.35.3` range accepts 0.35.5, so both share one copy.
  - The lockfile also lost the nested optional esbuild entries that a plain `npm install` drops on the unchanged tree.
- **Task 2** (`76f22b0`):
  - The description is trimmed before it is cut, and cut by code points, so an emoji at the 1,000th character is not
    split into a lone surrogate.
  - Schema mismatches use `describeIssue`.
- **Task 3** (`c1fa78f`):
  - A run's numbers cover its inputs only.
  - A missing result counts as a failure (`no result`).
  - New values tie-break with `compareText`.
- **Task 4** (`a1a8554`): a non-2xx response's body is cancelled.
- **Task 5** (`4cd48e2`):
  - Quotas naming an unknown stratum throw.
  - The query ran read-only on production on 2026-10-28 through the tunnel: 200 games in 0.5 s, 5 without thumbnail,
    every stratum filled to its quota.
  - The `verb-for-reward` stratum also holds `{verb} for Brainrots` games (`Rope Bridge for Brainrots`, `Claw for
    Brainrots!`).
- **Task 6** (`1c1bd00`):
  - `batches.create` runs with `maxRetries: 0`: the SDK retries timeouts, 408/409/429 and 5xx by default, and a batch
    has no idempotency key, so a retry after a lost response would pay for a second batch with an unsaved id.
  - Thumbnails are downloaded only when a model still needs submitting.
  - A batch is collected as soon as it ends, so a later timeout keeps its results.
- **Task 7** (`6a5129b`):
  - Argument parsing and the printed report live in `src/lib/classify/arguments.ts` and `report.ts`, with tests.
  - Files are written to a temporary name and renamed.
  - A reused sample is checked against the `--exclude` samples.
  - The command was run end to end against a local fake of the Batches API, never against the real one.
- **Final review**, fixed in `e548fe7` to `e871d16`:
  - **Submission record:** an entry with `id: null` is written before each `create`. A 4xx from the API removes it;
    any other failure keeps it, and every later run refuses until the owner finds the batch in the Console or deletes
    the entry.
  - **Lock:** `<dir>/run.lock` holds the pid, so a second run on the same directory refuses.
  - **`withoutImage`:** the state records which requests went without a thumbnail, instead of inferring it on resume.
  - **`promptHash`:** SHA-256 of the system prompt and the JSON schema, stored in the state. A directory built with
    another prompt is refused even if nobody bumped `CLASSIFICATION_PROMPT_VERSION`.
  - **Cache:** the system prompt is cached for one hour (`cacheTtl: "1h"`). Batch requests sharing the prefix can run
    more than 5 minutes apart. A one-hour write costs twice the input price (`cacheWriteMultiplier: 2`).
  - **Cost per game:** `costPerGameUsd` divides by every input game, the way a full run attempts every game.
  - **Raw answers:** every batch answer is kept in `raw-<model>.jsonl` before parsing, so paid output survives a
    parsing bug.
  - **Smaller fixes:**
    - `summary.json` carries `promptVersion`;
    - a missing required game is warned about;
    - an unknown batch result type is a failed game, not a crash.
  - **Not done:** moving the script's sample guards into a tested module, since they were checked by hand and serve
    only this trial.
- **S2–S3, comparison on 2026-10-29** (`.data/classification/comparison-1`, prompt v1, 200 games, 4 without thumbnail):
  - **Smoke test:** a direct request per model on `+1 Stone Skipping` and `Bike For Egg!` parsed cleanly ($0.05 at
    full price). The system prompt is 4,463 tokens.
  - **Opus and Haiku batches:** both ended within 7 minutes, with no failures.
  - **Cost and cache:** Opus cost $2.75 at batch prices: it read the one-hour cache in only 80 of 200 requests, and the
    120 writes at twice the input price made $2.1. Haiku cost $0.02, with 199 of 200 reads. The cache went back to
    5 minutes (`9f2249f`).
  - **Agreement between Opus and Haiku:** family 66%, template 68%, reward loop 80%, core action 53%, format 42%. They
    differ on 157 games, 40 of them on core action only.
  - **Judging:** eight Sonnet 5.5 judges (the owner wants subagents on Sonnet) settled each differing field blind, with
    A and B randomized, reasons removed and the thumbnail opened. A first round that judged from titles alone was
    discarded. 45 of 157 verdicts are low confidence.
  - **Who was right on differing fields:**
    - family: Opus 52, Haiku 10, both 5, neither 1;
    - template: Opus 41, Haiku 11, both 9, neither 3;
    - reward loop: Opus 23, Haiku 11, both 6, neither 1.
  - **Estimated accuracy over 200 games** (fields both models agree on count as right): Opus family 94%, template 93%,
    reward loop 94%, format 84%; Haiku 74%, 78%, 88%, format 54%.
  - **Sonnet 5.5** (`fb697e6`, same 200 games and prompt v1):
    - cost $0.40, or $0.0020 a game, with 199 cache reads at 5 minutes;
    - answers equal to a judged value inherit its verdict, and its 77 unseen format values were judged blind against
      the reference answer;
    - estimated family 87%, template 87%, reward loop 91%, format 72.5%;
    - it won 12 of those duels, some debatable, so a Sonnet judge's possible self-preference favours it.
  - **Vocabulary:** both models invent about 30 single-use families each (quiz, party, job simulator, io, wave
    survival, social deduction, and so on). Prompt v2 needs the broad missing genres and a rule that a new family is a
    shared genre.
  - **Volume:** 146–246 new games a day since 2026-10-26.
  - **Comparison page:** https://claude.ai/artifact/4BvzHUpJ5aKbYanYATQFDY.
  - **The owner's call:** $55–60 a month for Opus is too much (2026-10-29). Proposed next: prompt v2, then the
    100-game review sample classified by both Opus (to measure its cache at 5 minutes) and Sonnet.
- **Prompt v2** (`839dd90`): the shared genres both models had invented (puzzle, party, job simulator, evolution, board
  game, drawing, wave survival, creature collecting, destruction), seven templates, the cards and vehicles reward loops,
  and a rule that a new value names a shared genre or pattern, never a single game.
- **S4, review run on 2026-10-29** (`.data/classification/review-1`, prompt v2, 100 games excluding comparison-1, 1
  without thumbnail), classified by both Opus and Sonnet:
  - **Cost and cache:** Opus $0.35 ($0.0035 a game) and Sonnet $0.21 ($0.0021), each with 99 of 100 cache reads at
    5 minutes. The Opus cache works at 5 minutes, so Opus costs about $21 a month and $48 for the backfill; Sonnet about
    $13 and $29.
  - **Agreement:** family 75%, template 91%, reward loop 83%, core action 60%, format 61%.
  - **New values:** 5 families each, instead of about 30 with prompt v1.
- **S5, owner review on 2026-10-29** (https://claude.ai/artifact/TqqENcc5hC5C4CR2mpyoDA):
  - **Page:** fields both models agreed on were confirmed or corrected; differing fields were chosen blind between A
    and B, in random order, or rewritten. Answers were saved in the page's database and read back.
  - **Claude's doubts:** four Sonnet agents checked the 309 agreed values against the thumbnails and raised 2 doubts;
    Claude added 1 from the titles. The owner took all three, so the checkers miss errors.
  - **Agreed values are reliable:** the owner corrected 5 of 309.
  - **Accuracy:**

    | Field | Opus | Sonnet |
    |---|---|---|
    | Family | 89% | 87% |
    | Template | 97% | 94% |
    | Reward loop | 90% | 86% |
    | **Format** | **77%** | **70%** |
    | Core action | 76% | 83% |

  - **Opus against Sonnet on the format:** Opus alone right on 20 games, Sonnet alone on 13, both wrong on 10. Alone,
    this sample does not separate them (exact McNemar p ≈ 0.3), but it points the same way as the comparison.
  - **Decision:** the owner chose Opus (2026-10-29).
  - **Gate:** neither model reaches 90%, so the plan's revision loop applies.
  - **Noise:** part of the gap is boundary calls the reference itself does not settle consistently, such as `none`
    for DONT SPLASH but `progress` for It Hears The Water [DONT SPLASH].
  - **Overrides** (`ef47a01`): 92 entries, one for every field where the owner chose between differing answers or
    wrote a value; core action choices are often wording.
  - **The owner's per-game values:** for three `Steal a` games whose stolen units are not brainrots, the owner wrote
    per-game values (`peru`, `badr`, `verities`). At the owner's call they are recorded as the shared value
    `characters`.
- **Prompt v3** (`3cc7bc4`), from the errors of review-1:
  - **New values:** `hidden object`, `Find the {thing}`, `characters` and `collectibles`.
  - **Boundaries:**
    - `brainrots` only for the brainrot meme cast;
    - creature collecting under `catches`;
    - the markers of a `modded copy`;
    - `{verb} a {thing}` (one object) against `simulator` (many objects, a counter);
    - a title starting with Steal a makes a `Steal a` game.
  - **Templates:** a theme before a genre word is a template.
  - **New families:** a new genre beats `other`, and a known family beats a narrower new one.
  - **Examples:** they come from review-1, which review-2 excludes.
