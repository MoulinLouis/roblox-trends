CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('game_observations', by_range('observed_at', INTERVAL '1 day'));
--> statement-breakpoint
SELECT create_hypertable('census_observations', by_range('observed_at', INTERVAL '1 day'));
--> statement-breakpoint
SELECT create_hypertable('vote_observations', by_range('observed_at', INTERVAL '7 days'));
--> statement-breakpoint
SELECT create_hypertable('chart_placements', by_range('observed_at', INTERVAL '7 days'));
--> statement-breakpoint
ALTER TABLE game_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'universe_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE census_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'place_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE vote_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'universe_id', timescaledb.compress_orderby = 'observed_at DESC');
--> statement-breakpoint
ALTER TABLE chart_placements SET (timescaledb.compress, timescaledb.compress_segmentby = 'sort_id', timescaledb.compress_orderby = 'observed_at DESC, rank');
--> statement-breakpoint
SELECT add_compression_policy('game_observations', INTERVAL '7 days');
--> statement-breakpoint
SELECT add_compression_policy('census_observations', INTERVAL '7 days');
--> statement-breakpoint
SELECT add_compression_policy('vote_observations', INTERVAL '30 days');
--> statement-breakpoint
SELECT add_compression_policy('chart_placements', INTERVAL '30 days');
--> statement-breakpoint
SELECT add_retention_policy('game_observations', INTERVAL '90 days');
--> statement-breakpoint
SELECT add_retention_policy('census_observations', INTERVAL '90 days');
--> statement-breakpoint
CREATE MATERIALIZED VIEW game_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  universe_id,
  time_bucket(INTERVAL '1 hour', observed_at) AS bucket,
  min(ccu) AS ccu_min,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_max,
  last(visits, observed_at) AS visits_last,
  last(favorites, observed_at) AS favorites_last,
  count(*) AS samples
FROM game_observations
GROUP BY universe_id, bucket
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW game_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  universe_id,
  time_bucket(INTERVAL '1 day', observed_at) AS bucket,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_peak,
  last(visits, observed_at) AS visits_last,
  last(favorites, observed_at) AS favorites_last,
  count(*) AS samples
FROM game_observations
GROUP BY universe_id, bucket
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW census_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  place_id,
  time_bucket(INTERVAL '1 hour', observed_at) AS bucket,
  avg(ccu)::real AS ccu_avg,
  max(ccu) AS ccu_max,
  count(*) AS samples
FROM census_observations
GROUP BY place_id, bucket
WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('game_hourly', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes');
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('game_daily', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('census_hourly', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes');
--> statement-breakpoint
CREATE VIEW game_daily_all AS
SELECT universe_id, bucket AS day, ccu_avg, ccu_peak, visits_last AS visits, favorites_last AS favorites, 'observed'::text AS origin
FROM game_daily
UNION ALL
SELECT legacy.universe_id, legacy.day, legacy.ccu_avg, legacy.ccu_peak, legacy.visits, legacy.favorites, 'legacy'::text AS origin
FROM game_daily_legacy legacy
WHERE NOT EXISTS (
  SELECT 1 FROM game_daily observed
  WHERE observed.universe_id = legacy.universe_id AND observed.bucket = legacy.day
);
