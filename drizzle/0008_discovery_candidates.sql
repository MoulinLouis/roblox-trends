CREATE TABLE "discovery_candidates" (
	"universe_id" bigint NOT NULL,
	"source" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"player_count" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	CONSTRAINT "discovery_candidates_universe_id_source_detail_pk" PRIMARY KEY("universe_id","source","detail")
);
