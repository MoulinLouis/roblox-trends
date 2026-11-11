export type AlertKind = "first_breakout" | "wave";

export interface GameFormat {
  name: string;
  family: string | null;
  template: string | null;
  coreAction: string | null;
}

// A game that crossed the CCU threshold, with the pattern keys it carries.
export interface Breakout {
  universeId: number;
  createdAt: Date;
  crossedAt: Date;
  keys: string[];
  classified: boolean;
}

// An alert already sent, as far as the decision needs to know it.
export interface PastAlert {
  kind: AlertKind;
  universeId: number;
  keys: string[];
  createdAt: Date;
}

// `priors` lists, for each key, the universe ids of its earlier breakouts in crossing order.
export interface AlertDecision {
  kind: AlertKind;
  universeId: number;
  keys: string[];
  priors: Record<string, number[]>;
}

// What an alert card shows about one game, read when the card is built.
export interface CardFacts {
  name: string;
  rootPlaceId: number;
  thumbnailUrl: string | null;
  robloxCreatedAt: Date;
  // The moment the game crossed the threshold, echoed from the caller's map.
  crossedAt: Date;
  lastCcu: number;
  // The game's hourly peak CCU 24 hours before its crossing; null when it was not read then.
  ccuDayBefore: number | null;
  // Share of up votes in the latest vote reading; null without votes.
  likeRatio: number | null;
  family: string | null;
  template: string | null;
  rewardLoop: string | null;
  coreAction: string | null;
  // The highest daily peak CCU the game ever read, v1 history included.
  peakCcu: number;
}

// An alert row as stored; `sentAt` is null until the digest or instant message went out.
export interface StoredAlert {
  id: string;
  kind: AlertKind;
  universeId: number;
  keys: string[];
  evidence: unknown;
  createdAt: Date;
  sentAt: Date | null;
}
