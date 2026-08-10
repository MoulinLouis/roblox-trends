import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AppSettings, GameMetrics, GameTag, ScorePart, TrendMetrics, TrendStage } from "@/lib/types";

export const games = pgTable(
  "games",
  {
    universeId: text("universe_id").primaryKey(),
    rootPlaceId: text("root_place_id").notNull(),
    name: text("name").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    description: text("description").notNull().default(""),
    creatorId: text("creator_id").notNull(),
    creatorName: text("creator_name").notNull(),
    creatorType: text("creator_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    thumbnailUrl: text("thumbnail_url"),
    genre: text("genre"),
  },
  (table) => [index("games_created_at_idx").on(table.createdAt), index("games_last_seen_idx").on(table.lastSeenAt)],
);

export const gameTags = pgTable(
  "game_tags",
  {
    universeId: text("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    tag: text("tag").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.dimension, table.tag] }), index("game_tags_tag_idx").on(table.tag)],
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    universeId: text("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    ccu: integer("ccu").notNull(),
    visits: real("visits").notNull(),
    favorites: integer("favorites").notNull(),
    chart: text("chart").notNull(),
    rank: integer("rank"),
    source: text("source").notNull(),
  },
  (table) => [
    uniqueIndex("snapshots_idempotency_idx").on(table.universeId, table.bucketAt, table.source, table.chart),
    index("snapshots_game_time_idx").on(table.universeId, table.bucketAt),
    index("snapshots_time_idx").on(table.bucketAt),
  ],
);

export const dailySnapshots = pgTable(
  "daily_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    universeId: text("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    dayAt: timestamp("day_at", { withTimezone: true }).notNull(),
    averageCcu: integer("average_ccu").notNull(),
    peakCcu: integer("peak_ccu").notNull(),
    visits: real("visits").notNull(),
    favorites: integer("favorites").notNull(),
    bestRank: integer("best_rank"),
  },
  (table) => [
    uniqueIndex("daily_snapshots_game_day_idx").on(table.universeId, table.dayAt),
    index("daily_snapshots_time_idx").on(table.dayAt),
  ],
);

export const gameAnalyses = pgTable("game_analyses", {
  universeId: text("universe_id")
    .primaryKey()
    .references(() => games.universeId, { onDelete: "cascade" }),
  metrics: jsonb("metrics").$type<GameMetrics>().notNull(),
  momentumScore: integer("momentum_score").notNull(),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
});

export const trends = pgTable(
  "trends",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    tags: jsonb("tags").$type<GameTag[]>().notNull(),
    stage: text("stage").$type<TrendStage>().notNull(),
    trendScore: integer("trend_score").notNull(),
    saturationScore: integer("saturation_score").notNull(),
    opportunityScore: integer("opportunity_score").notNull(),
    metrics: jsonb("metrics").$type<TrendMetrics>().notNull(),
    scoreBreakdown: jsonb("score_breakdown").$type<ScorePart[]>().notNull(),
    saturationExplanation: text("saturation_explanation").notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("trends_stage_idx").on(table.stage),
    index("trends_opportunity_idx").on(table.opportunityScore),
  ],
);

export const trendGames = pgTable(
  "trend_games",
  {
    trendId: text("trend_id")
      .notNull()
      .references(() => trends.id, { onDelete: "cascade" }),
    universeId: text("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.trendId, table.universeId] })],
);

export const trendHistory = pgTable(
  "trend_history",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    trendId: text("trend_id")
      .notNull()
      .references(() => trends.id, { onDelete: "cascade" }),
    dayAt: timestamp("day_at", { withTimezone: true }).notNull(),
    stage: text("stage").$type<TrendStage>().notNull(),
    trendScore: integer("trend_score").notNull(),
    saturationScore: integer("saturation_score").notNull(),
    combinedCcu: integer("combined_ccu").notNull(),
    gameCount: integer("game_count").notNull(),
  },
  (table) => [uniqueIndex("trend_history_day_idx").on(table.trendId, table.dayAt)],
);

export const ideas = pgTable(
  "ideas",
  {
    id: text("id").primaryKey(),
    workingTitle: text("working_title").notNull(),
    pitch: text("pitch").notNull(),
    coreLoop: text("core_loop").notNull(),
    firstTwentySeconds: text("first_twenty_seconds").notNull(),
    progression: text("progression").notNull(),
    returnReason: text("return_reason").notNull(),
    socialComponent: text("social_component").notNull(),
    differentiator: text("differentiator").notNull(),
    estimatedScope: text("estimated_scope").notNull(),
    requiredSystems: jsonb("required_systems").$type<string[]>().notNull(),
    requiredAssets: jsonb("required_assets").$type<string[]>().notNull(),
    reusableSystems: jsonb("reusable_systems").$type<string[]>().notNull(),
    risks: jsonb("risks").$type<string[]>().notNull(),
    relevance: text("relevance").notNull(),
    supportingTrendIds: jsonb("supporting_trend_ids").$type<string[]>().notNull(),
    supportingGameIds: jsonb("supporting_game_ids").$type<string[]>().notNull(),
    generationMode: text("generation_mode").notNull(),
    saved: boolean("saved").notNull().default(false),
    rejected: boolean("rejected").notNull().default(false),
    rating: integer("rating"),
    comment: text("comment").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ideas_created_at_idx").on(table.createdAt)],
);

export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  value: jsonb("value").$type<AppSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceRuns = pgTable(
  "source_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    runKey: text("run_key").notNull(),
    job: text("job").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    items: integer("items").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("source_runs_key_idx").on(table.runKey, table.source)],
);

export const alertEvents = pgTable("alert_events", {
  eventKey: text("event_key").primaryKey(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
});
