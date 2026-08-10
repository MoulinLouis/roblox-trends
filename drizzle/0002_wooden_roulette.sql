CREATE TABLE "game_metadata_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_metadata_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"universe_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"name" text NOT NULL,
	"normalized_title" text NOT NULL,
	"description" text NOT NULL,
	"game_updated_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD COLUMN "up_votes" integer;--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD COLUMN "down_votes" integer;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "up_votes" integer;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "down_votes" integer;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "is_sponsored" boolean;--> statement-breakpoint
ALTER TABLE "game_metadata_history" ADD CONSTRAINT "game_metadata_history_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_metadata_history_version_idx" ON "game_metadata_history" USING btree ("universe_id","fingerprint");--> statement-breakpoint
CREATE INDEX "game_metadata_history_game_time_idx" ON "game_metadata_history" USING btree ("universe_id","observed_at");