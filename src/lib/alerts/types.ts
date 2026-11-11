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
