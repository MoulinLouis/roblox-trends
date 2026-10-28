import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { classificationJsonSchema } from "./schema";
import type { ClassificationInput, ClassificationVocabulary, ThumbnailImage, VocabularyEntry } from "./types";
import { CLASSIFICATION_VOCABULARY } from "./vocabulary";

// Bump it with every change to the prompt or to the user content: answers are comparable only within one version.
export const CLASSIFICATION_PROMPT_VERSION = 2;

// Every request of a batch shares this text as its cached prefix, so it holds nothing that varies between calls.
export function classificationSystemPrompt(vocabulary: ClassificationVocabulary = CLASSIFICATION_VOCABULARY): string {
  return `You classify Roblox games for a trend radar. A Roblox developer uses it to see which game formats are rising and who already tried an idea. You receive a game's thumbnail when it has one, its title, its Roblox genre and the start of its description. Answer in the given JSON schema.

How to read a game:
- Trust the title and the thumbnail first. Descriptions are often stuffed with keywords, codes and update notes; use them only to settle a doubt.
- Ignore event and update markers: bracketed text such as [🎃], [UPD 3] or [WORLD 2], countdowns, emojis, "NEW", "UPDATE" and "BETA".
- Titles can be in any language. Classify the game, not the language.
- A copy of a hit keeps the hit's family and template even when its theme differs: "Steal an Clown Egg" is a \`Steal a\` game.

Fields:
- reason: one sentence on what decided the family, the template and the reward loop.
- family: the genre the developer would name for the game, such as \`+1\`, \`Steal a\` or \`obby\`. The family follows the gameplay and the template follows the title, so a title can match a template of another family: a drawing game titled "Draw a Cat" is a \`drawing\` game with the template \`{verb} a {thing}\`.
- template: the title pattern several games share, with the variable parts in braces, such as \`+1 {thing} Escape\` or \`{verb} for {reward}\`. Use a known template when the title follows it with small variations (capitals, "an" for "a", an extra word). Use \`none\` when the title is a name rather than a pattern.
- rewardLoop: what the player collects or grows in the core loop. \`eggs\` is its own value, apart from \`pets\`.
- coreAction: what the player does most of the time, as a lowercase base-form verb and its object, one to three words: \`skip stones\`, \`ride pets\`, \`steal eggs\`.
- theme: the main object or theme, one to three lowercase words.
- setting: where the game takes place, one to three lowercase words.
- progression and social: one of the listed values. \`theft\` is for games where stealing from other players is the core loop.
- confidence: \`high\` when the title and the thumbnail leave no doubt about the family, the template and the reward loop; \`low\` when you mostly guessed.

Known values. Reuse a known value whenever one fits, written exactly as listed. When none fits, write a new value only for a genre or a title pattern that many games share, in one to three words and in the same style: a new format must appear as a new value, not be forced into an old one. Never describe a single game; that is what coreAction and theme are for. Use \`other\` as a family only when no genre stands out, and \`none\` as a template when the title follows no shared pattern.

Families:
${vocabularyLines(vocabulary.families)}

Templates:
${vocabularyLines(vocabulary.templates)}

Reward loops:
${vocabularyLines(vocabulary.rewardLoops)}`;
}

// Catches an edit of the system prompt or of the output schema made without bumping CLASSIFICATION_PROMPT_VERSION.
export function classificationPromptHash(
  system: string = classificationSystemPrompt(),
  schema: Record<string, unknown> = classificationJsonSchema,
): string {
  return createHash("sha256").update(system).update("\u0000").update(JSON.stringify(schema)).digest("hex");
}

export function classificationUserContent(input: ClassificationInput, image: ThumbnailImage | null): Anthropic.ContentBlockParam[] {
  const lines = [
    ...(image ? [] : ["Thumbnail: none"]),
    `Title: ${input.name}`,
    `Roblox genre: ${input.genre ?? "none"}`,
    descriptionLine(input.description),
  ];
  const text: Anthropic.TextBlockParam = { type: "text", text: lines.join("\n") };
  if (!image) return [text];
  return [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, text];
}

function vocabularyLines(entries: readonly VocabularyEntry[]): string {
  return entries
    .map((entry) => `- \`${entry.value}\`: ${entry.meaning} Examples: ${entry.examples.map((example) => `"${example}"`).join(", ")}.`)
    .join("\n");
}

// Cut by code points, not UTF-16 units: half an emoji is a lone surrogate, which is not valid Unicode and can get the
// request rejected.
function descriptionLine(description: string): string {
  const characters = Array.from(description.trim());
  const limit = CLASSIFICATION_CONFIG.descriptionMaxCharacters;
  if (!characters.length) return "Description: (empty)";
  if (characters.length <= limit) return `Description: ${characters.join("")}`;
  return `Description (first ${limit} characters): ${characters.slice(0, limit).join("")}…`;
}
