-- Rising games (design section 5A), computed on demand from the hourly aggregates for any as_of, so the dashboard,
-- analysis sessions and backtests share one definition. Every threshold is a parameter: src/lib/config.ts
-- (RADAR_CONFIG) holds the values; smoothing_ccu must be positive. Windows are whole UTC hours before as_of: the current
-- window, the window before it (acceleration) and the current window one week earlier (weekday-safe growth). Every
-- metric comes with its sample size, in hourly buckets. Intervals are in hours, never days, so a session time zone with
-- daylight saving cannot shift the windows. Game metadata (first_observed_at, the place-to-universe mapping) is
-- today's, not as_of's: a backtest sees the games' current names and places.
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
  velocity_end int,
  velocity_max_gap_hours int
)
RETURNS TABLE (
  universe_id bigint,
  name text,
  icon_url text,
  roblox_created_at timestamptz,
  first_observed_at timestamptz,
  ccu_last int,
  ccu_last_at timestamptz,
  ccu_avg double precision,
  ccu_peak int,
  window_peak int,
  window_median double precision,
  is_event boolean,
  week_baseline text,
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
PARALLEL SAFE
AS $$
WITH candidates AS (
  SELECT g.universe_id, g.name, g.icon_url, g.roblox_created_at, g.first_observed_at
  FROM games g
  WHERE g.roblox_created_at > rising_games.as_of - make_interval(hours => 24 * rising_games.max_age_days)
    AND g.roblox_created_at <= rising_games.as_of
),
current_hours AS (
  SELECT h.universe_id, h.bucket, h.ccu_avg, h.ccu_max
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
    AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
),
windows AS (
  SELECT cur.universe_id,
    avg(cur.ccu_avg) AS ccu_avg,
    max(cur.ccu_max) AS window_peak,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY cur.ccu_avg) AS window_median,
    count(*) AS samples
  FROM current_hours cur
  GROUP BY cur.universe_id
),
-- The games shown: the heavier readings below only run for them.
selected AS (
  SELECT c.universe_id, c.name, c.icon_url, c.roblox_created_at, c.first_observed_at,
    w.ccu_avg, w.window_peak, w.window_median, w.samples
  FROM candidates c
  JOIN windows w ON w.universe_id = c.universe_id
  WHERE w.ccu_avg >= rising_games.min_ccu
),
previous AS (
  SELECT h.universe_id, avg(h.ccu_avg) AS previous_avg, count(*) AS previous_samples
  FROM game_hourly h
  JOIN selected s ON s.universe_id = h.universe_id
  WHERE h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 2 * rising_games.window_hours)
    AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
  GROUP BY h.universe_id
),
-- Every game, of any age, read both in an hour of the current window and in the same hour one week earlier. Shares are
-- taken among these games and these hours only: the same hours cancel each game's own daily cycle when the week-ago
-- samples are sparse (v1 read 6 to 7 hours a day), and the same games keep a change in which games the radar tracked
-- (v1 to v2) from moving every share.
pairs AS (
  SELECT cur.universe_id, cur.bucket, cur.ccu_avg::double precision AS ccu, week.ccu_avg::double precision AS week_ccu
  FROM game_hourly cur
  JOIN game_hourly week ON week.universe_id = cur.universe_id
    AND week.bucket = cur.bucket - make_interval(hours => 7 * 24)
  WHERE cur.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => rising_games.window_hours)
    AND cur.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
    AND week.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24 + rising_games.window_hours)
    AND week.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24)
),
pair_totals AS (
  SELECT p.bucket, sum(p.ccu) AS total, sum(p.week_ccu) AS week_total
  FROM pairs p
  GROUP BY p.bucket
),
pair_market AS (
  SELECT avg(t.total) AS total FROM pair_totals t
),
week_shares AS (
  SELECT p.universe_id,
    avg(p.ccu / nullif(t.total, 0)) AS share,
    avg(p.week_ccu / nullif(t.week_total, 0)) AS week_share,
    count(*) AS week_samples
  FROM pairs p
  JOIN selected s ON s.universe_id = p.universe_id
  JOIN pair_totals t ON t.bucket = p.bucket
  GROUP BY p.universe_id
),
-- The hours of the week-ago window in which the radar read any game. All of them means it was watching then: a game
-- it did not read had fewer players than the active-set minimum, so its growth counts from 0.
week_coverage AS (
  SELECT count(DISTINCT h.bucket) AS hours
  FROM game_hourly h
  WHERE h.bucket >= time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24 + rising_games.window_hours)
    AND h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of) - make_interval(hours => 7 * 24)
),
-- The freshest CCU, from the observations themselves: the current hour is not whole yet.
latest AS (
  SELECT DISTINCT ON (o.universe_id) o.universe_id, o.ccu, o.observed_at
  FROM game_observations o
  JOIN selected s ON s.universe_id = o.universe_id
  WHERE o.observed_at <= rising_games.as_of
    AND o.observed_at > rising_games.as_of - make_interval(hours => rising_games.window_hours)
  ORDER BY o.universe_id, o.observed_at DESC
),
-- One hourly reading per game, from poll and from the census of its places: census lists a place long before its CCU
-- earns it a poll, which dates the threshold crossings. A place counts its own players only, so a crossing dated from
-- census can be late, never early.
readings AS (
  SELECT r.universe_id, r.bucket, max(r.ccu_max) AS ccu_max
  FROM (
    SELECT h.universe_id, h.bucket, h.ccu_max
    FROM game_hourly h
    JOIN selected s ON s.universe_id = h.universe_id
    WHERE h.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
      AND h.bucket >= rising_games.as_of - make_interval(hours => 24 * (rising_games.max_age_days + 1))
    UNION ALL
    SELECT p.universe_id, ch.bucket, ch.ccu_max
    FROM census_hourly ch
    JOIN places p ON p.place_id = ch.place_id
    JOIN selected s ON s.universe_id = p.universe_id
    WHERE ch.bucket < time_bucket(INTERVAL '1 hour', rising_games.as_of)
      AND ch.bucket >= rising_games.as_of - make_interval(hours => 24 * (rising_games.max_age_days + 1))
  ) r
  GROUP BY r.universe_id, r.bucket
),
series AS (
  SELECT r.universe_id, r.bucket, r.ccu_max,
    r.bucket - lag(r.bucket) OVER (PARTITION BY r.universe_id ORDER BY r.bucket) AS gap
  FROM readings r
),
-- A crossing is dated by the first reading at or above the threshold; the gap before it bounds the error, and is null
-- when the radar first read the game above the threshold.
crossings AS (
  SELECT s.universe_id,
    (array_agg(s.ccu_max ORDER BY s.bucket))[1] AS first_seen_ccu,
    max(s.ccu_max) AS peak,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_start) AS at_start,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_middle) AS at_middle,
    min(s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_end) AS at_end,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_start))[1] AS gap_start,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_middle))[1] AS gap_middle,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= rising_games.velocity_end))[1] AS gap_end
  FROM series s
  GROUP BY s.universe_id
),
-- v1 daily peaks (2026-08-24 to 2026-09-19), older than the hourly history; a day that has not ended by as_of is left out.
legacy_peaks AS (
  SELECT l.universe_id, max(l.ccu_peak) AS peak
  FROM game_daily_legacy l
  JOIN selected s ON s.universe_id = l.universe_id
  WHERE l.day + INTERVAL '24 hours' <= rising_games.as_of
  GROUP BY l.universe_id
)
SELECT
  s.universe_id::bigint,
  s.name,
  s.icon_url,
  s.roblox_created_at,
  s.first_observed_at,
  l.ccu::int,
  l.observed_at,
  s.ccu_avg::double precision,
  greatest(x.peak, l.ccu, lp.peak)::int,
  s.window_peak::int,
  s.window_median::double precision,
  (s.samples >= rising_games.event_min_samples AND s.window_peak >= rising_games.event_peak_ratio * s.window_median),
  (CASE
    WHEN ws.week_samples > 0 THEN 'tracked'
    -- Created after the start of the week-ago window: the game had no players to compare with.
    WHEN s.roblox_created_at >= time_bucket(INTERVAL '1 hour', rising_games.as_of)
      - make_interval(hours => 7 * 24 + rising_games.window_hours) THEN 'new'
    WHEN wc.hours >= rising_games.window_hours THEN 'untracked'
    ELSE 'unknown'
  END)::text,
  (ws.share / nullif(ws.week_share, 0))::double precision,
  (CASE
    WHEN ws.week_samples > 0 THEN
      ln(nullif(ws.share * pm.total + rising_games.smoothing_ccu, 0)
        / nullif(ws.week_share * pm.total + rising_games.smoothing_ccu, 0))
    WHEN s.roblox_created_at >= time_bucket(INTERVAL '1 hour', rising_games.as_of)
      - make_interval(hours => 7 * 24 + rising_games.window_hours)
      OR wc.hours >= rising_games.window_hours THEN
      ln(nullif(s.ccu_avg + rising_games.smoothing_ccu, 0) / nullif(rising_games.smoothing_ccu, 0))
  END)::double precision,
  (s.ccu_avg / nullif(pv.previous_avg, 0))::double precision,
  x.first_seen_ccu::int,
  (CASE
    WHEN x.gap_start <= make_interval(hours => rising_games.velocity_max_gap_hours)
      AND x.gap_middle <= make_interval(hours => rising_games.velocity_max_gap_hours)
      THEN extract(epoch FROM x.at_middle - x.at_start) / 3600
  END)::double precision,
  (CASE
    WHEN x.gap_middle <= make_interval(hours => rising_games.velocity_max_gap_hours)
      AND x.gap_end <= make_interval(hours => rising_games.velocity_max_gap_hours)
      THEN extract(epoch FROM x.at_end - x.at_middle) / 3600
  END)::double precision,
  s.samples::int,
  coalesce(pv.previous_samples, 0)::int,
  coalesce(ws.week_samples, 0)::int
FROM selected s
CROSS JOIN pair_market pm
CROSS JOIN week_coverage wc
LEFT JOIN previous pv ON pv.universe_id = s.universe_id
LEFT JOIN week_shares ws ON ws.universe_id = s.universe_id
LEFT JOIN latest l ON l.universe_id = s.universe_id
LEFT JOIN crossings x ON x.universe_id = s.universe_id
LEFT JOIN legacy_peaks lp ON lp.universe_id = s.universe_id
$$;
