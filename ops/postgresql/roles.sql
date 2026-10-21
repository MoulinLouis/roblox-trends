-- Run as a superuser by ops/bin/configure-database.sh; safe to run again. Both roles log in by peer authentication on
-- the local socket: the radar OS user owns the application, the analysis OS user maps to radar_analysis (pg_ident.conf).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'radar') THEN
    CREATE ROLE radar LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'radar_analysis') THEN
    CREATE ROLE radar_analysis LOGIN;
  END IF;
END
$$;
-- The system check reads pg_stat_archiver and the TimescaleDB job statistics.
GRANT pg_monitor TO radar;
-- Analysis sessions only read, and a forgotten query cannot hold the database.
ALTER ROLE radar_analysis SET default_transaction_read_only = on;
ALTER ROLE radar_analysis SET statement_timeout = '5min';
ALTER ROLE radar_analysis SET idle_in_transaction_session_timeout = '10min';
