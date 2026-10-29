CREATE TABLE "classification_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"anthropic_id" text,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"requests" integer NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone,
	"cost_usd" real,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "classification_batches_anthropic_id_unique" UNIQUE("anthropic_id")
);
--> statement-breakpoint
CREATE TABLE "classification_overrides" (
	"universe_id" bigint NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"decided_at" text NOT NULL,
	CONSTRAINT "classification_overrides_universe_id_field_pk" PRIMARY KEY("universe_id","field")
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"batch_id" uuid NOT NULL,
	"universe_id" bigint NOT NULL,
	"name" text NOT NULL,
	"had_thumbnail" boolean NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"reason" text,
	"family" text,
	"template" text,
	"reward_loop" text,
	"core_action" text,
	"theme" text,
	"setting" text,
	"progression" text,
	"social" text,
	"confidence" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"finished_at" timestamp with time zone,
	CONSTRAINT "classifications_batch_id_universe_id_pk" PRIMARY KEY("batch_id","universe_id")
);
--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_batch_id_classification_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."classification_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_universe_id_games_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."games"("universe_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classification_batches_submitted_idx" ON "classification_batches" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "classifications_game_idx" ON "classifications" USING btree ("universe_id","finished_at");