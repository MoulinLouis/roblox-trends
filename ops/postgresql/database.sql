-- Run as a superuser in the radar database by ops/bin/configure-database.sh, before the first migration; safe to run
-- again. TimescaleDB is a trusted extension that the owner could create itself; created here, it belongs to postgres,
-- which runs its updates (ALTER EXTENSION timescaledb UPDATE), and the migration's CREATE EXTENSION IF NOT EXISTS is
-- then a no-op.
CREATE EXTENSION IF NOT EXISTS timescaledb;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO radar_analysis', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO radar_analysis;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO radar_analysis;
-- Tables, views and continuous aggregates created later by the migrations (run as radar) are readable too.
ALTER DEFAULT PRIVILEGES FOR ROLE radar IN SCHEMA public GRANT SELECT ON TABLES TO radar_analysis;
