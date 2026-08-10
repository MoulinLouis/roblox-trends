CREATE TABLE "alert_events" (
	"event_key" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"universe_id" text NOT NULL,
	"day_at" timestamp with time zone NOT NULL,
	"average_ccu" integer NOT NULL,
	"peak_ccu" integer NOT NULL,
	"visits" real NOT NULL,
	"favorites" integer NOT NULL,
	"best_rank" integer
);
--> statement-breakpoint
CREATE TABLE "game_analyses" (
	"universe_id" text PRIMARY KEY NOT NULL,
	"metrics" jsonb NOT NULL,
	"momentum_score" integer NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_tags" (
	"universe_id" text NOT NULL,
	"dimension" text NOT NULL,
	"tag" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_tags_universe_id_dimension_tag_pk" PRIMARY KEY("universe_id","dimension","tag")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"universe_id" text PRIMARY KEY NOT NULL,
	"root_place_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"creator_id" text NOT NULL,
	"creator_name" text NOT NULL,
	"creator_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"thumbnail_url" text,
	"genre" text
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"working_title" text NOT NULL,
	"pitch" text NOT NULL,
	"core_loop" text NOT NULL,
	"first_twenty_seconds" text NOT NULL,
	"progression" text NOT NULL,
	"return_reason" text NOT NULL,
	"social_component" text NOT NULL,
	"differentiator" text NOT NULL,
	"estimated_scope" text NOT NULL,
	"required_systems" jsonb NOT NULL,
	"required_assets" jsonb NOT NULL,
	"reusable_systems" jsonb NOT NULL,
	"risks" jsonb NOT NULL,
	"relevance" text NOT NULL,
	"supporting_trend_ids" jsonb NOT NULL,
	"supporting_game_ids" jsonb NOT NULL,
	"generation_mode" text NOT NULL,
	"saved" boolean DEFAULT false NOT NULL,
	"rejected" boolean DEFAULT false NOT NULL,
	"rating" integer,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"universe_id" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"ccu" integer NOT NULL,
	"visits" real NOT NULL,
	"favorites" integer NOT NULL,
	"chart" text NOT NULL,
	"rank" integer,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_key" text NOT NULL,
	"job" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trend_games" (
	"trend_id" text NOT NULL,
	"universe_id" text NOT NULL,
	CONSTRAINT "trend_games_trend_id_universe_id_pk" PRIMARY KEY("trend_id","universe_id")
);
--> statement-breakpoint
CREATE TABLE "trend_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trend_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trend_id" text NOT NULL,
	"day_at" timestamp with time zone NOT NULL,
	"stage" text NOT NULL,
	"trend_score" integer NOT NULL,
	"saturation_score" integer NOT NULL,
	"combined_ccu" integer NOT NULL,
	"game_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trends" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"tags" jsonb NOT NULL,
	"stage" text NOT NULL,
	"trend_score" integer NOT NULL,
	"saturation_score" integer NOT NULL,
	"opportunity_score" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"saturation_explanation" text NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_analyses" ADD CONSTRAINT "game_analyses_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_tags" ADD CONSTRAINT "game_tags_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_games" ADD CONSTRAINT "trend_games_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_games" ADD CONSTRAINT "trend_games_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_history" ADD CONSTRAINT "trend_history_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_snapshots_game_day_idx" ON "daily_snapshots" USING btree ("universe_id","day_at");--> statement-breakpoint
CREATE INDEX "daily_snapshots_time_idx" ON "daily_snapshots" USING btree ("day_at");--> statement-breakpoint
CREATE INDEX "game_tags_tag_idx" ON "game_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "games_created_at_idx" ON "games" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "games_last_seen_idx" ON "games" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ideas_created_at_idx" ON "ideas" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_idempotency_idx" ON "snapshots" USING btree ("universe_id","bucket_at","source","chart");--> statement-breakpoint
CREATE INDEX "snapshots_game_time_idx" ON "snapshots" USING btree ("universe_id","bucket_at");--> statement-breakpoint
CREATE INDEX "snapshots_time_idx" ON "snapshots" USING btree ("bucket_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_runs_key_idx" ON "source_runs" USING btree ("run_key","source");--> statement-breakpoint
CREATE UNIQUE INDEX "trend_history_day_idx" ON "trend_history" USING btree ("trend_id","day_at");--> statement-breakpoint
CREATE INDEX "trends_stage_idx" ON "trends" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "trends_opportunity_idx" ON "trends" USING btree ("opportunity_score");