CREATE TABLE "classification_merges" (
	"field" text NOT NULL,
	"from_key" text NOT NULL,
	"from_value" text NOT NULL,
	"to_value" text NOT NULL,
	"reason" text NOT NULL,
	"decided_at" text NOT NULL,
	CONSTRAINT "classification_merges_field_from_key_pk" PRIMARY KEY("field","from_key")
);
