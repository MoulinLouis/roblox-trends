ALTER TABLE "ideas" ADD COLUMN "alternative_titles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "recommendation_score" integer DEFAULT 0 NOT NULL;