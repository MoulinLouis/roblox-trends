import {
  bigint,
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
  uuid,
} from "drizzle-orm/pg-core";
import type { DiscoverySource, JobName, JobStatus } from "@/lib/jobs/types";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const id64 = (name: string) => bigint(name, { mode: "number" });

export const games = pgTable(
  "games",
  {
    universeId: id64("universe_id").primaryKey(),
    rootPlaceId: id64("root_place_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    creatorId: id64("creator_id").notNull(),
    creatorName: text("creator_name").notNull(),
    creatorType: text("creator_type").notNull(),
    genre: text("genre"),
    robloxCreatedAt: timestamptz("roblox_created_at").notNull(),
    robloxUpdatedAt: timestamptz("roblox_updated_at").notNull(),
    firstObservedAt: timestamptz("first_observed_at").notNull(),
    lastObservedAt: timestamptz("last_observed_at").notNull(),
    lastCcu: integer("last_ccu").notNull().default(0),
    lastCcuAt: timestamptz("last_ccu_at"),
    // The latest observation with players; null until one is seen. A single empty poll does not reset it.
    lastActiveAt: timestamptz("last_active_at"),
    // Raw fingerprint of the current name + description; a version is recorded whenever it changes.
    metadataFingerprint: text("metadata_fingerprint").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    iconUrl: text("icon_url"),
    thumbnailsCheckedAt: timestamptz("thumbnails_checked_at"),
  },
  (table) => [
    index("games_roblox_created_idx").on(table.robloxCreatedAt),
    index("games_root_place_idx").on(table.rootPlaceId),
  ],
);

export const places = pgTable(
  "places",
  {
    placeId: id64("place_id").primaryKey(),
    universeId: id64("universe_id"),
    resolvedAt: timestamptz("resolved_at").notNull(),
    error: text("error"),
  },
  (table) => [index("places_universe_idx").on(table.universeId)],
);

export const gameVersions = pgTable(
  "game_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    universeId: id64("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    kind: text("kind").$type<"metadata" | "thumbnail">().notNull(),
    rawFingerprint: text("raw_fingerprint").notNull(),
    contentFingerprint: text("content_fingerprint"),
    name: text("name"),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    robloxUpdatedAt: timestamptz("roblox_updated_at"),
    observedAt: timestamptz("observed_at").notNull(),
  },
  // Versions are compared with the game's current state, not with all history, so a title or
  // thumbnail that reverts (X → [🎃] X → X) records the return. The unique key keeps imports idempotent.
  (table) => [
    uniqueIndex("game_versions_unique_idx").on(table.universeId, table.kind, table.rawFingerprint, table.observedAt),
    index("game_versions_game_time_idx").on(table.universeId, table.observedAt),
  ],
);

export const discoverySources = pgTable(
  "discovery_sources",
  {
    universeId: id64("universe_id")
      .notNull()
      .references(() => games.universeId, { onDelete: "cascade" }),
    source: text("source").$type<DiscoverySource>().notNull(),
    detail: text("detail").notNull().default(""),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.universeId, table.source, table.detail] }),
    index("discovery_sources_first_seen_idx").on(table.firstSeenAt),
  ],
);

// Hypertables (converted in drizzle/0001_timescale.sql). No foreign keys, for write volume and compression.
export const gameObservations = pgTable(
  "game_observations",
  {
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    ccu: integer("ccu").notNull(),
    visits: id64("visits").notNull(),
    favorites: id64("favorites").notNull(),
    source: text("source").$type<"poll" | "legacy">().notNull().default("poll"),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.observedAt] })],
);

export const censusObservations = pgTable(
  "census_observations",
  {
    placeId: id64("place_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    ccu: integer("ccu").notNull(),
  },
  (table) => [primaryKey({ columns: [table.placeId, table.observedAt] })],
);

export const voteObservations = pgTable(
  "vote_observations",
  {
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    upVotes: integer("up_votes").notNull(),
    downVotes: integer("down_votes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.observedAt] })],
);

export const chartPlacements = pgTable(
  "chart_placements",
  {
    sortId: text("sort_id").notNull(),
    universeId: id64("universe_id").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    rank: integer("rank").notNull(),
    playerCount: integer("player_count").notNull(),
    isSponsored: boolean("is_sponsored"),
  },
  (table) => [
    primaryKey({ columns: [table.sortId, table.universeId, table.observedAt] }),
    index("chart_placements_game_time_idx").on(table.universeId, table.observedAt),
  ],
);

export const gameDailyLegacy = pgTable(
  "game_daily_legacy",
  {
    universeId: id64("universe_id").notNull(),
    day: timestamptz("day").notNull(),
    ccuAvg: real("ccu_avg").notNull(),
    ccuPeak: integer("ccu_peak").notNull(),
    visits: id64("visits").notNull(),
    favorites: id64("favorites").notNull(),
  },
  (table) => [primaryKey({ columns: [table.universeId, table.day] })],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey(),
    job: text("job").$type<JobName>().notNull(),
    slot: timestamptz("slot").notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
  },
  (table) => [
    index("job_runs_job_started_idx").on(table.job, table.startedAt),
    index("job_runs_job_slot_idx").on(table.job, table.slot),
  ],
);
