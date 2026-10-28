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
export const classificationJsonSchema: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(gameClassificationSchema)).filter(([key]) => key !== "$schema"),
);
