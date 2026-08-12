CREATE TABLE "generated_artifacts" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"text_content" text,
	"json_content" jsonb,
	"generated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduler_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_job_runs_slot_idx" ON "scheduled_job_runs" USING btree ("job_name","scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_recent_idx" ON "scheduled_job_runs" USING btree ("job_name","started_at");