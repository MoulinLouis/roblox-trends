import type { DiscoverySource } from "@/lib/jobs/types";

export type DiagnosisLabel = "leader" | "fading" | "liked but stuck" | "no audience";

// What the radar knows of an attempt it tracks.
export interface ConceptHistory {
  firstObservedAt: Date;
  // All-time, from game_daily_all; null before the first observation.
  peakCcu: number | null;
  peakDay: Date | null;
  // Within CONCEPT_CHECK_CONFIG.historyDays, oldest first.
  daily: { day: Date; ccuPeak: number }[];
  // Metadata version names other than the current one, oldest first.
  earlierNames: string[];
  sources: DiscoverySource[];
}

export interface ConceptAttempt {
  universeId: number;
  name: string;
  description: string;
  creatorName: string;
  created: Date;
  updated: Date;
  visits: number;
  playing: number;
  favorites: number;
  upVotes: number;
  downVotes: number;
  // Null without votes.
  likeRatio: number | null;
  // The phrases whose search returned the game.
  matchedPhrases: string[];
  // Null when the radar does not track the game or its history was not read.
  history: ConceptHistory | null;
  labels: DiagnosisLabel[];
}

export interface ConceptSummary {
  attempts: number;
  // Search results that share no word with the phrases.
  hidden: number;
  // Search results Roblox returned no details for.
  unavailable: number;
  firstAttempt: { universeId: number; name: string; created: Date } | null;
  leader: { universeId: number; name: string; playing: number; visits: number; fading: boolean } | null;
  // Created within CONCEPT_CHECK_CONFIG.recentDays, oldest first.
  recent: { universeId: number; name: string; created: Date }[];
}

export type HistoryStatus = { status: "read" } | { status: "skipped"; reason: string } | { status: "failed"; error: string };

export interface ConceptReport {
  phrases: string[];
  checkedAt: Date;
  // Oldest first.
  attempts: ConceptAttempt[];
  summary: ConceptSummary;
  // Searches that failed after their retries.
  failures: { phrase: string; error: string }[];
  history: HistoryStatus;
}
