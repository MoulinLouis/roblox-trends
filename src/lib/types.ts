export const TAG_DIMENSIONS = ["coreLoop", "progression", "reward", "social", "theme"] as const;
export type TagDimension = (typeof TAG_DIMENSIONS)[number];

export type TrendStage = "spark" | "emerging" | "expanding" | "copy_wave" | "saturated" | "declining";

export interface GameTag {
  dimension: TagDimension;
  tag: string;
  source: "automatic" | "manual";
}

export interface GameSnapshotPoint {
  collectedAt: Date;
  ccu: number;
  visits: number;
  favorites: number;
  rank: number | null;
  chart?: string;
}

export interface ScorePart {
  key: string;
  label: string;
  raw: number;
  normalized: number;
  weight: number;
  points: number;
  explanation: string;
}

export interface MomentumResult {
  score: number;
  breakdown: ScorePart[];
}

export interface GameMetrics {
  growth1h: number;
  growth24h: number;
  growth72h: number;
  growth7d: number;
  gain1h: number;
  gain24h: number;
  gain72h: number;
  gain7d: number;
  acceleration: number;
  newVisits24h: number;
  newFavorites24h: number;
  rankMovement24h: number;
  ageDays: number;
  persistence: number;
  momentum: MomentumResult;
}

export interface TrendMetrics {
  gameCount: number;
  creatorCount: number;
  combinedCcu: number;
  combinedGrowth72h: number;
  newGames7d: number;
  growingShare: number;
  leaderShare: number;
  historyCoverage: number;
}

export interface DeveloperProfile {
  teamSize: number;
  robloxExperience: "recent" | "intermediate" | "expert";
  webProductSkill: number;
  uiUxSkill: number;
  budget: "limited" | "moderate" | "high";
  preferredWeeksMin: number;
  preferredWeeksMax: number;
  mobileFirst: boolean;
  prefersClearLoops: boolean;
  reusableSystems: string[];
}

export interface TaxonomyEntry {
  tag: string;
  aliases: string[];
}

export interface Taxonomy {
  coreLoop: TaxonomyEntry[];
  progression: TaxonomyEntry[];
  reward: TaxonomyEntry[];
  social: TaxonomyEntry[];
  theme: TaxonomyEntry[];
}

export interface AppSettings {
  thresholds: {
    minimumBaselineCcu: number;
    minimumAbsoluteGain: number;
    breakoutMomentum: number;
    saturationMinGames: number;
    saturationNewGames7d: number;
    saturationFlatGrowth: number;
    hourlyRetentionDays: number;
  };
  momentumWeights: {
    ccuGrowth: number;
    acceleration: number;
    absoluteGain: number;
    visitGrowth: number;
    rankImprovement: number;
    freshness: number;
    persistence: number;
  };
  opportunityWeights: {
    trendStrength: number;
    differentiation: number;
    feasibility: number;
    mobileClarity: number;
    reusePotential: number;
    retention: number;
    durability: number;
  };
  collection: {
    intervalMinutes: number;
    country: string;
    device: string;
    charts: string[];
    rolimonsEnabled: boolean;
    rolimonsCandidates: number;
  };
  taxonomy: Taxonomy;
  developerProfile: DeveloperProfile;
  discordWebhook: string;
}

export interface CollectedGame {
  universeId: string;
  rootPlaceId: string;
  name: string;
  description: string;
  creatorId: string;
  creatorName: string;
  creatorType: string;
  createdAt: Date;
  updatedAt: Date;
  ccu: number;
  visits: number;
  favorites: number;
  thumbnailUrl: string | null;
  genre: string | null;
  chart: string;
  rank: number | null;
  source: string;
}

export interface CollectionError {
  source: string;
  message: string;
}

export interface GeneratedIdea {
  workingTitle: string;
  pitch: string;
  coreLoop: string;
  firstTwentySeconds: string;
  progression: string;
  returnReason: string;
  socialComponent: string;
  differentiator: string;
  estimatedScope: string;
  requiredSystems: string[];
  requiredAssets: string[];
  reusableSystems: string[];
  risks: string[];
  relevance: string;
  supportingTrendIds: string[];
  supportingGameIds: string[];
  generationMode: "deterministic" | "openai";
}
