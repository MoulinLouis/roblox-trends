CREATE TABLE "discovery_frontier" (
	"place_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"thumbnail_url" text,
	"current_ccu" integer NOT NULL,
	"previous_ccu" integer NOT NULL,
	"peak_ccu" integer NOT NULL,
	"score" integer NOT NULL,
	"qualifies" boolean NOT NULL,
	"history" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"observations" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rising_game_events" (
	"id" text PRIMARY KEY NOT NULL,
	"universe_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"event_type" text NOT NULL,
	"tier" text NOT NULL,
	"score" integer NOT NULL,
	"current_ccu" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rising_game_signals" (
	"universe_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"score" integer NOT NULL,
	"tier" text NOT NULL,
	"confidence" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_ccu" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"risks" jsonb NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rising_game_signals_universe_id_signal_type_pk" PRIMARY KEY("universe_id","signal_type")
);
--> statement-breakpoint
ALTER TABLE "rising_game_events" ADD CONSTRAINT "rising_game_events_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rising_game_signals" ADD CONSTRAINT "rising_game_signals_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_frontier_candidates_idx" ON "discovery_frontier" USING btree ("qualifies","score");--> statement-breakpoint
CREATE INDEX "discovery_frontier_seen_idx" ON "discovery_frontier" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "rising_game_events_recent_idx" ON "rising_game_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "rising_game_events_notification_idx" ON "rising_game_events" USING btree ("notified_at","detected_at");--> statement-breakpoint
CREATE INDEX "rising_game_signals_active_score_idx" ON "rising_game_signals" USING btree ("active","score");--> statement-breakpoint
CREATE INDEX "rising_game_signals_detected_idx" ON "rising_game_signals" USING btree ("last_detected_at");