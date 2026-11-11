CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"universe_id" bigint NOT NULL,
	"keys" text[] NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_kind_game_idx" ON "alerts" USING btree ("kind","universe_id");--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");