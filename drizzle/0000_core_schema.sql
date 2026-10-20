CREATE TABLE "census_observations" (
	"place_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ccu" integer NOT NULL,
	CONSTRAINT "census_observations_place_id_observed_at_pk" PRIMARY KEY("place_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "chart_placements" (
	"sort_id" text NOT NULL,
	"universe_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"rank" integer NOT NULL,
	"player_count" integer NOT NULL,
	"is_sponsored" boolean,
	CONSTRAINT "chart_placements_sort_id_universe_id_observed_at_pk" PRIMARY KEY("sort_id","universe_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"universe_id" bigint NOT NULL,
	"source" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "discovery_sources_universe_id_source_detail_pk" PRIMARY KEY("universe_id","source","detail")
);
--> statement-breakpoint
CREATE TABLE "game_daily_legacy" (
	"universe_id" bigint NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"ccu_avg" real NOT NULL,
	"ccu_peak" integer NOT NULL,
	"visits" bigint NOT NULL,
	"favorites" bigint NOT NULL,
	CONSTRAINT "game_daily_legacy_universe_id_day_pk" PRIMARY KEY("universe_id","day")
);
--> statement-breakpoint
CREATE TABLE "game_observations" (
	"universe_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ccu" integer NOT NULL,
	"visits" bigint NOT NULL,
	"favorites" bigint NOT NULL,
	"source" text DEFAULT 'poll' NOT NULL,
	CONSTRAINT "game_observations_universe_id_observed_at_pk" PRIMARY KEY("universe_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "game_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"universe_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"raw_fingerprint" text NOT NULL,
	"content_fingerprint" text,
	"name" text,
	"description" text,
	"thumbnail_url" text,
	"roblox_updated_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"universe_id" bigint PRIMARY KEY NOT NULL,
	"root_place_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"creator_id" bigint NOT NULL,
	"creator_name" text NOT NULL,
	"creator_type" text NOT NULL,
	"genre" text,
	"roblox_created_at" timestamp with time zone NOT NULL,
	"roblox_updated_at" timestamp with time zone NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"last_ccu" integer DEFAULT 0 NOT NULL,
	"last_ccu_at" timestamp with time zone,
	"metadata_fingerprint" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"thumbnail_url" text,
	"icon_url" text,
	"thumbnails_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "places" (
	"place_id" bigint PRIMARY KEY NOT NULL,
	"universe_id" bigint,
	"resolved_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "vote_observations" (
	"universe_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"up_votes" integer NOT NULL,
	"down_votes" integer NOT NULL,
	CONSTRAINT "vote_observations_universe_id_observed_at_pk" PRIMARY KEY("universe_id","observed_at")
);
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_placements_game_time_idx" ON "chart_placements" USING btree ("universe_id","observed_at");--> statement-breakpoint
CREATE INDEX "discovery_sources_first_seen_idx" ON "discovery_sources" USING btree ("first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_versions_unique_idx" ON "game_versions" USING btree ("universe_id","kind","raw_fingerprint","observed_at");--> statement-breakpoint
CREATE INDEX "game_versions_game_time_idx" ON "game_versions" USING btree ("universe_id","observed_at");--> statement-breakpoint
CREATE INDEX "games_roblox_created_idx" ON "games" USING btree ("roblox_created_at");--> statement-breakpoint
CREATE INDEX "games_root_place_idx" ON "games" USING btree ("root_place_id");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_job_slot_idx" ON "job_runs" USING btree ("job","slot");--> statement-breakpoint
CREATE INDEX "places_universe_idx" ON "places" USING btree ("universe_id");