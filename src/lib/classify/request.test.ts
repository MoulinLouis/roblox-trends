import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { classificationSystemPrompt, classificationUserContent } from "./prompt";
import {
  classificationCustomId,
  classificationRequest,
  readBatchResult,
  readClassification,
  universeIdFromCustomId,
} from "./request";
import { classificationJsonSchema } from "./schema";
import type { ClassificationInput, ThumbnailImage } from "./types";

const input: ClassificationInput = {
  universeId: 10765298801,
  name: "+1 Stone Skipping",
  description: "Skip stones across the lake.",
  genre: "Simulation",
  thumbnailUrl: "https://tr.rbxcdn.com/thumbnail.png",
  robloxCreatedAt: "2026-10-01T00:00:00.000Z",
  peakCcu: 160_000,
  stratum: "plus-one",
};

const image: ThumbnailImage = { mediaType: "image/jpeg", data: "/9j/4AAQ" };

const answer = {
  reason: "The title starts with +1 and the stone skips further as the throw stat grows.",
  family: "+1",
  template: "+1 {thing}",
  rewardLoop: "stats",
  coreAction: "skip stones",
  theme: "stone skipping",
  setting: "lake",
  progression: "stat growth",
  social: "solo",
  confidence: "high",
};

const usage = { inputTokens: 1_200, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 2_400 };

function message(values: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1_200, output_tokens: 300, cache_creation_input_tokens: null, cache_read_input_tokens: 2_400 },
    ...values,
  } as Anthropic.Message;
}

// Adaptive thinking puts a thinking block before the answer.
function answered(text: string, values: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return message({
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ] as Anthropic.ContentBlock[],
    ...values,
  });
}

describe("classificationRequest", () => {
  const request = classificationRequest("claude-opus-5-5", input, image);

  // Requests of a batch can run more than 5 minutes apart, the default lifetime of a cache entry.
  it("asks the model for the schema at low effort, with the system prompt cached for an hour", () => {
    expect(request).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 8_000,
      system: [{ type: "text", text: classificationSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: classificationUserContent(input, image) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: classificationJsonSchema } },
    });
  });

  // Thinking stays adaptive by default on both models; sampling parameters are rejected.
  it("sends no thinking or temperature setting", () => {
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("temperature");
  });

  it("uses the system prompt it is given", () => {
    expect(classificationRequest("claude-haiku-5-5", input, null, "Classify.").system).toEqual([
      { type: "text", text: "Classify.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });
});

describe("classification custom ids", () => {
  it("round-trips a universe id", () => {
    expect(classificationCustomId(10765298801)).toBe("u10765298801");
    expect(universeIdFromCustomId(classificationCustomId(10765298801))).toBe(10765298801);
  });

  it.each(["x1", "u", "u12a", "10765298801"])("rejects %s", (customId) => {
    expect(universeIdFromCustomId(customId)).toBeNull();
  });
});

describe("readClassification", () => {
  it("reads an answer, trims its strings and keeps the usage", () => {
    const padded = { ...answer, family: " +1 ", theme: "stone skipping\n", reason: `  ${answer.reason}` };
    expect(readClassification(answered(JSON.stringify(padded)))).toEqual({ ok: true, classification: answer, usage });
  });

  it("reports a refusal with its category", () => {
    const refusal = message({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Declined." },
    });
    expect(readClassification(refusal)).toEqual({ ok: false, error: "refused (cyber)", usage });
  });

  it("reports a refusal without a category", () => {
    const refusal = message({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } });
    expect(readClassification(refusal)).toEqual({ ok: false, error: "refused (no category)", usage });
  });

  it("reports an answer cut by the token limit", () => {
    expect(readClassification(answered('{"reason": "The ti', { stop_reason: "max_tokens" }))).toEqual({
      ok: false,
      error: "ran out of tokens",
      usage,
    });
  });

  it("reports an answer without text", () => {
    expect(readClassification(message({}))).toEqual({ ok: false, error: "no text in the answer", usage });
  });

  it("reports invalid JSON", () => {
    expect(readClassification(answered("family: +1"))).toEqual({ ok: false, error: "invalid JSON", usage });
  });

  it("reports the first schema mismatch", () => {
    const withoutFamily: Partial<typeof answer> = { ...answer };
    delete withoutFamily.family;
    expect(readClassification(answered(JSON.stringify(withoutFamily)))).toEqual({
      ok: false,
      error: expect.stringMatching(/^schema mismatch: family: \S/),
      usage,
    });
  });

  it("reads missing cache counts as zero", () => {
    const outcome = readClassification(
      answered(JSON.stringify(answer), {
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      } as Partial<Anthropic.Message>),
    );
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  });
});

describe("readBatchResult", () => {
  function response(result: Anthropic.Messages.MessageBatchResult, customId = "u10765298801") {
    return { custom_id: customId, result } as Anthropic.Messages.MessageBatchIndividualResponse;
  }

  it("reads a succeeded request's answer", () => {
    expect(readBatchResult(response({ type: "succeeded", message: answered(JSON.stringify(answer)) }))).toEqual({
      universeId: 10765298801,
      outcome: { ok: true, classification: answer, usage },
    });
  });

  it("reports an errored request", () => {
    const error = { type: "error", request_id: null, error: { type: "invalid_request_error", message: "Image too large." } } as const;
    expect(readBatchResult(response({ type: "errored", error }))).toEqual({
      universeId: 10765298801,
      outcome: { ok: false, error: "batch error: invalid_request_error: Image too large.", usage: null },
    });
  });

  it.each(["canceled", "expired"] as const)("reports a %s request", (type) => {
    expect(readBatchResult(response({ type }))).toEqual({
      universeId: 10765298801,
      outcome: { ok: false, error: type, usage: null },
    });
  });

  it("ignores a request this module did not name", () => {
    expect(readBatchResult(response({ type: "expired" }, "game-1"))).toBeNull();
  });
});
