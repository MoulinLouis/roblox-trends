import type { GameClassification } from "./schema";

export const CLASSIFICATION_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
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
