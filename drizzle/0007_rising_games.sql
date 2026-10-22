-- Rising games (design section 5A), computed on demand from the hourly aggregates for any as_of, so the dashboard,
-- analysis sessions and backtests share one definition. Every threshold is a parameter: src/lib/config.ts
-- (RADAR_CONFIG) holds the values. Windows are whole UTC hours before as_of: the current window, the window before it
-- (acceleration) and the current window one week earlier (weekday-safe growth). Every metric comes with its sample
-- size, in hourly buckets. Intervals are in hours, never days, so a session time zone with daylight saving cannot
-- shift the windows.
CREATE FUNCTION rising_games(
  as_of timestamptz,
  max_age_days int,
  min_ccu int,
  window_hours int,
  smoothing_ccu double precision,
  event_peak_ratio double precision,
  event_min_samples int,
  velocity_start int,
  velocity_middle int,
  velocity_end int
)
RETURNS TABLE (
  universe_id bigint,
  name text,
  icon_url text,
  roblox_created_at timestamptz,
  first_observed_at timestamptz,
  ccu_last int,
  ccu_avg double precision,
  ccu_peak int,
  window_peak int,
  window_median double precision,
  is_event boolean,
  week_growth double precision,
  week_growth_score double precision,
  day_growth double precision,
  first_seen_ccu int,
  hours_to_middle double precision,
  hours_to_end double precision,
  samples int,
  previous_samples int,
  week_samples int
)
LANGUAGE sql
STABLE
AS $$
WITH candidates AS (
  SELECT g.universe_id, g.name, g.icon_url, g.roblox_created_at, g.first_observed_at
  FROM games g
  WHERE g.roblox_created_at > rising_games.as_of - make_interval(hours => 24 * rising_games.max_age_days)
    AND g.roblox_created_at <= rising_games.as_of
),
-- The candidates' hourly CCU in the three windows. The week-ago window sits seven days (one week) before the current
-- one, so both cover the same weekdays and hours.
hourly AS (
  SELECT h.universe_id, h.bucket, h.ccu_avg, h.ccu_max,
    CASE
      WHEN h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
        THEN 'current'
      WHEN h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 2 * rising_games.window_hours)
        THEN 'previous'
      ELSE 'week'
    END AS period
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 2 * rising_games.window_hours)
      OR (
        h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24 + rising_games.window_hours)
        AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24)
      )
    )
),
-- Tracked CCU of every game, of any age, per hour of the current and week-ago windows: the denominator of the shares,
-- which cancels the weekday and hour-of-day swings of the whole market.
market AS (
  SELECT h.bucket, sum(h.ccu_avg::double precision) AS total
  FROM game_hourly h
  WHERE (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
      AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    ) OR (
      h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24 + rising_games.window_hours)
      AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24)
    )
  GROUP BY h.bucket
),
market_size AS (
  SELECT avg(m.total) AS total
  FROM market m
  WHERE m.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
),
windows AS (
  SELECT h.universe_id,
    avg(h.ccu_avg) FILTER (WHERE h.period = 'current') AS ccu_avg,
    avg(h.ccu_avg) FILTER (WHERE h.period = 'previous') AS previous_avg,
    avg(h.ccu_avg / nullif(m.total, 0)) FILTER (WHERE h.period = 'current') AS share,
    avg(h.ccu_avg / nullif(m.total, 0)) FILTER (WHERE h.period = 'week') AS week_share,
    max(h.ccu_max) FILTER (WHERE h.period = 'current') AS window_peak,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY h.ccu_avg) FILTER (WHERE h.period = 'current') AS window_median,
    count(*) FILTER (WHERE h.period = 'current') AS samples,
    count(*) FILTER (WHERE h.period = 'previous') AS previous_samples,
    count(*) FILTER (WHERE h.period = 'week') AS week_samples
  FROM hourly h
  LEFT JOIN market m ON m.bucket = h.bucket
  GROUP BY h.universe_id
),
-- The freshest CCU, from the observations themselves: the current hour is not whole yet.
latest AS (
  SELECT DISTINCT ON (o.universe_id) o.universe_id, o.ccu
  FROM game_observations o
  JOIN candidates c ON c.universe_id = o.universe_id
  WHERE o.observed_at <= rising_games.as_of
    AND o.observed_at > rising_games.as_of - make_interval(hours => rising_games.window_hours)
  ORDER BY o.universe_id, o.observed_at DESC
),
-- Every hourly reading of the candidates, from poll and from the census of their places: census lists a place long
-- before its CCU earns it a poll, which dates the threshold crossings.
series AS (
  SELECT h.universe_id, h.bucket, h.ccu_max
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND h.bucket >= rising_games.as_of - make_interval(hours => 24 * (rising_games.max_age_days + 1))
  UNION ALL
  SELECT p.universe_id, ch.bucket, ch.ccu_max
  FROM census_hourly ch
  JOIN places p ON p.place_id = ch.place_id
  JOIN candidates c ON c.universe_id = p.universe_id
  WHERE ch.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND ch.bucket >= rising_games.as_of - make_interval(hours => 24 * (rising_games.max_age_days + 1))
),
crossings AS (
  SELECT s.universe_id,
    min(s.bucket) AS first_bucket,
    (array_agg(s.ccu_max ORDER BY s.bucket, s.ccu_max DESC))[1] AS first_seen_ccu,
    max(s.ccu_max) AS peak,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_start) AS at_start,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_middle) AS at_middle,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_end) AS at_end
  FROM series s
  GROUP BY s.universe_id
),
-- v1 daily peaks (2026-08-24 to 2026-09-19), older than the hourly history.
legacy_peaks AS (
  SELECT l.universe_id, max(l.ccu_peak) AS peak
  FROM game_daily_legacy l
  JOIN candidates c ON c.universe_id = l.universe_id
  WHERE l.day + INTERVAL '24 hours' <= rising_games.as_of
  GROUP BY l.universe_id
)
SELECT
  c.universe_id::bigint,
  c.name,
  c.icon_url,
  c.roblox_created_at,
  c.first_observed_at,
  l.ccu::int,
  w.ccu_avg::double precision,
  greatest(x.peak, l.ccu, lp.peak)::int,
  w.window_peak::int,
  w.window_median::double precision,
  (w.samples >= rising_games.event_min_samples AND w.window_peak >= rising_games.event_peak_ratio * w.window_median),
  (w.share / nullif(w.week_share, 0))::double precision,
  (CASE
    WHEN w.week_samples > 0 THEN
      ln((w.share * ms.total + rising_games.smoothing_ccu) / (w.week_share * ms.total + rising_games.smoothing_ccu))
    -- Created after the start of the week-ago window: the game had no players to compare with.
    WHEN c.roblox_created_at >= time_bucket(INTERVAL '1 hour', rising_games.as_of)
      - make_interval(hours => 7 * 24 + rising_games.window_hours) THEN
      ln((w.share * ms.total + rising_games.smoothing_ccu) / rising_games.smoothing_ccu)
  END)::double precision,
  (w.ccu_avg / nullif(w.previous_avg, 0))::double precision,
  x.first_seen_ccu::int,
  (CASE WHEN x.at_start > x.first_bucket THEN extract(epoch FROM x.at_middle - x.at_start) / 3600 END)::double precision,
  (CASE WHEN x.at_middle > x.first_bucket THEN extract(epoch FROM x.at_end - x.at_middle) / 3600 END)::double precision,
  w.samples::int,
  w.previous_samples::int,
  w.week_samples::int
FROM candidates c
JOIN windows w ON w.universe_id = c.universe_id
CROSS JOIN market_size ms
LEFT JOIN latest l ON l.universe_id = c.universe_id
LEFT JOIN crossings x ON x.universe_id = c.universe_id
LEFT JOIN legacy_peaks lp ON lp.universe_id = c.universe_id
WHERE w.samples > 0 AND w.ccu_avg >= rising_games.min_ccu
$$;
