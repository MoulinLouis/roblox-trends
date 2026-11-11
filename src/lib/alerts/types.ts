export type AlertKind = "first_breakout" | "wave";

export interface GameFormat {
  name: string;
  family: string | null;
  template: string | null;
  coreAction: string | null;
}
