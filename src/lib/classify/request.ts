import type Anthropic from "@anthropic-ai/sdk";
import { describeIssue } from "@/lib/api/schema-issues";
import { CLASSIFICATION_CONFIG } from "@/lib/config";
import { classificationSystemPrompt, classificationUserContent } from "./prompt";
import { classificationJsonSchema, gameClassificationSchema, type GameClassification } from "./schema";
import type { ClassificationModel, ClassificationOutcome, ClassificationUsage, ThumbnailImage, ClassifiedGame } from "./types";

// Batch results come back in any order; the custom id names the game each one belongs to.
export function classificationCustomId(universeId: number): string {
  return `u${universeId}`;
}

export function universeIdFromCustomId(customId: string): number | null {
  const match = /^u(\d+)$/.exec(customId);
  return match ? Number(match[1]) : null;
}

// No thinking setting: both models think adaptively by default. No temperature: these models reject it. No fallbacks:
// the Batches API rejects them, so a refusal stays a refusal.
export function classificationRequest(
  model: ClassificationModel,
  input: ClassifiedGame,
  image: ThumbnailImage | null,
  system: string = classificationSystemPrompt(),
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: CLASSIFICATION_CONFIG.maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: CLASSIFICATION_CONFIG.cacheTtl } }],
    messages: [{ role: "user", content: classificationUserContent(input, image) }],
    output_config: {
      effort: CLASSIFICATION_CONFIG.effort,
      format: { type: "json_schema", schema: classificationJsonSchema },
    },
  };
}

// A bad answer is an outcome, never an exception, so one game cannot stop a batch. A refused or truncated answer is
// still billed, so it keeps its usage.
export function readClassification(message: Anthropic.Message): ClassificationOutcome {
  const usage = readUsage(message.usage);
  if (message.stop_reason === "refusal") return failure(`refused (${message.stop_details?.category ?? "no category"})`, usage);
  if (message.stop_reason === "max_tokens") return failure("ran out of tokens", usage);
  const text = message.content.find((block) => block.type === "text");
  if (!text) return failure("no text in the answer", usage);
  let answer: unknown;
  try {
    answer = JSON.parse(text.text);
  } catch {
    return failure("invalid JSON", usage);
  }
  const parsed = gameClassificationSchema.safeParse(answer);
  if (!parsed.success) return failure(`schema mismatch: ${describeIssue(parsed.error.issues[0])}`, usage);
  return { ok: true, classification: trimmed(parsed.data), usage };
}

export function readBatchResult(
  response: Anthropic.Messages.MessageBatchIndividualResponse,
): { universeId: number; outcome: ClassificationOutcome } | null {
  const universeId = universeIdFromCustomId(response.custom_id);
  if (universeId === null) return null;
  const { result } = response;
  switch (result.type) {
    case "succeeded":
      return { universeId, outcome: readClassification(result.message) };
    case "errored":
      return { universeId, outcome: failure(`batch error: ${result.error.error.type}: ${result.error.error.message}`, null) };
    case "canceled":
    case "expired":
      return { universeId, outcome: failure(result.type, null) };
    // A type added to the API after this SDK: one failed game, not a crashed collection of a paid batch.
    default:
      return { universeId, outcome: failure(`unknown result type: ${(result as { type: string }).type}`, null) };
  }
}

function readUsage(usage: Anthropic.Usage): ClassificationUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function failure(error: string, usage: ClassificationUsage | null): ClassificationOutcome {
  return { ok: false, error, usage };
}

function trimmed(classification: GameClassification): GameClassification {
  return Object.fromEntries(Object.entries(classification).map(([key, value]) => [key, value.trim()])) as GameClassification;
}
