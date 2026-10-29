import type Anthropic from "@anthropic-ai/sdk";

// The subset of client.messages.batches the runner uses.
export interface BatchApi {
  create(
    params: { requests: { custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming }[] },
    options: { maxRetries: number },
  ): Promise<{ id: string }>;
  retrieve(id: string): Promise<{
    processing_status: Anthropic.Messages.MessageBatch["processing_status"];
    request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  }>;
  results(id: string): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
}

// A 4xx answer means the API refused the request, so no batch exists. A timeout, a lost connection or a 5xx answer may
// come after the batch was created.
export function rejectedByApi(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return typeof status === "number" && status >= 400 && status <= 499;
}
