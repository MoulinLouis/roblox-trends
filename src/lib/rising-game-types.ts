export type RisingGameSignalType = "launch_breakout" | "resurgence";
export type RisingGameTier = "rising" | "surging" | "explosive";
export type RisingGameConfidence = "early" | "verified" | "established";

export interface RisingWindowEvidence {
  hours: number;
  actualHours: number;
  baselineAt: string;
  baselineCcu: number;
  currentCcu: number;
  gain: number;
  growthPercent: number;
  visitsGain: number;
  favoritesGain: number;
}

export interface RisingGameMetrics {
  currentCcu: number;
  createdAt: string;
  observedHours: number;
  ageDays: number;
  firstSeenHoursAgo: number;
  strongestWindow: RisingWindowEvidence | null;
  windows: Partial<Record<"1" | "3" | "6" | "24", RisingWindowEvidence>>;
  priorPeakCcu: number;
  historicalMedianCcu: number;
  medianMultiple: number;
  peakDrawdownPercent: number;
  crossedMilestone: number | null;
  newHighSinceTracking: boolean;
  enteredDiscoveryChart: boolean;
  chart: string | null;
}

export interface RisingGameSignalCandidate {
  universeId: string;
  signalType: RisingGameSignalType;
  score: number;
  tier: RisingGameTier;
  confidence: RisingGameConfidence;
  detectedAt: Date;
  metrics: RisingGameMetrics;
  reasons: string[];
  risks: string[];
}

export type RisingGameEventType = "activated" | "tier_up" | "milestone";

export interface RisingGameEventPayload {
  metrics: RisingGameMetrics;
  reasons: string[];
  risks: string[];
}

export interface DiscoveryFrontierPoint {
  at: string;
  ccu: number;
}

export interface DiscoveryFrontierMetrics {
  score: number;
  qualifies: boolean;
  gain1h: number | null;
  growth1h: number | null;
  gain3h: number | null;
  growth3h: number | null;
  gain6h: number | null;
  growth6h: number | null;
  crossedMilestone: number | null;
  newHigh: boolean;
}

export interface DiscoveryFrontierState extends DiscoveryFrontierMetrics {
  placeId: string;
  name: string;
  thumbnailUrl: string | null;
  currentCcu: number;
  previousCcu: number;
  peakCcu: number;
  history: DiscoveryFrontierPoint[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  observations: number;
}
