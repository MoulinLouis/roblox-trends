import { CLASSIFICATION_CONFIG } from "@/lib/config";
import type { ClassificationModel, ClassificationUsage } from "./types";

const tokensPerPrice = 1_000_000;

export function classificationCostUsd(model: ClassificationModel, usage: ClassificationUsage, options: { batch: boolean }): number {
  const price = CLASSIFICATION_CONFIG.pricing[model];
  const fullPrice =
    (price.input * usage.inputTokens +
      price.output * usage.outputTokens +
      price.cacheRead * usage.cacheReadInputTokens +
      price.input * CLASSIFICATION_CONFIG.cacheWriteMultiplier * usage.cacheCreationInputTokens) /
    tokensPerPrice;
  return options.batch ? fullPrice * CLASSIFICATION_CONFIG.batchDiscount : fullPrice;
}
