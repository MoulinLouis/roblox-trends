CREATE TABLE "collection_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"snapshots" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "source_runs_key_idx";--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "attempt_id" text;--> statement-breakpoint
CREATE INDEX "collection_attempts_bucket_idx" ON "collection_attempts" USING btree ("bucket_at");--> statement-breakpoint
CREATE INDEX "collection_attempts_started_idx" ON "collection_attempts" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_attempt_id_collection_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."collection_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_root_place_idx" ON "games" USING btree ("root_place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_runs_attempt_source_idx" ON "source_runs" USING btree ("attempt_id","source");--> statement-breakpoint
CREATE INDEX "source_runs_bucket_idx" ON "source_runs" USING btree ("run_key","started_at");