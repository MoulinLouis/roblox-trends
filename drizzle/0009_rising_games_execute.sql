-- Rising games (design section 5A), computed on demand from the hourly aggregates for any as_of, so the dashboard,
-- analysis sessions and backtests share one definition. Every threshold is a parameter: src/lib/config.ts
-- (RADAR_CONFIG) holds the values; smoothing_ccu must be positive. Windows are whole UTC hours before as_of: the current
-- window, the window before it (acceleration) and the current window one week earlier (weekday-safe growth). Every
-- metric comes with its sample size, in hourly buckets. Intervals are in hours, never days, so a session time zone with
-- daylight saving cannot shift the windows. Game metadata (first_observed_at, the place-to-universe mapping) is
-- today's, not as_of's: a backtest sees the games' current names and places.
--
-- The function ranks the games itself (sort_by: growth, acceleration, ccu or age; any other value sorts by ccu) and
-- returns the first row_limit of them (all when null) with their sort_rank: the history behind velocity, first-seen CCU
-- and peak is read for those rows only.
--
-- PL/pgSQL running its query through EXECUTE ... USING, which plans it at every call with the arguments as constants.
-- Inlined from a SQL function (0007), the query reached the planner after the step where TimescaleDB replaces each
-- continuous aggregate's cagg_watermark() by its value, so a sequential scan of a whole materialized chunk evaluated it
-- once per row: 11 s instead of 0.4 s on production on 2026-10-24, the first day of a new game_hourly chunk. The query
-- is 0007's, with the arguments as $1 as_of, $2 max_age_days, $3 min_ccu, $4 window_hours, $5 smoothing_ccu,
-- $6 event_peak_ratio, $7 event_min_samples, $8 velocity_start, $9 velocity_middle, $10 velocity_end,
-- $11 velocity_max_gap_hours, $12 sort_by and $13 row_limit.
CREATE OR REPLACE FUNCTION rising_games(
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
  velocity_max_gap_hours int,
  sort_by text DEFAULT 'growth',
  row_limit int DEFAULT NULL
)
RETURNS TABLE (
  sort_rank int,
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
  window_last double precision,
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
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $function$
BEGIN
  RETURN QUERY EXECUTE $query$
WITH candidates AS (
  SELECT g.universe_id, g.name, g.icon_url, g.roblox_created_at, g.first_observed_at
  FROM games g
  WHERE g.roblox_created_at > $1 - make_interval(hours => 24 * $2)
    AND g.roblox_created_at <= $1
),
current_hours AS (
  SELECT h.universe_id, h.bucket, h.ccu_avg, h.ccu_max
  FROM game_hourly h
  JOIN candidates c ON c.universe_id = h.universe_id
  WHERE h.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => $4)
    AND h.bucket < time_bucket(INTERVAL '1 hour', $1)
),
windows AS (
  SELECT cur.universe_id,
    avg(cur.ccu_avg) AS ccu_avg,
    max(cur.ccu_max) AS window_peak,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY cur.ccu_avg) AS window_median,
    (array_agg(cur.ccu_avg ORDER BY cur.bucket DESC))[1] AS window_last,
    count(*) AS samples
  FROM current_hours cur
  GROUP BY cur.universe_id
),
-- The games that pass the filters.
selected AS (
  SELECT c.universe_id, c.name, c.icon_url, c.roblox_created_at, c.first_observed_at,
    w.ccu_avg, w.window_peak, w.window_median, w.window_last, w.samples
  FROM candidates c
  JOIN windows w ON w.universe_id = c.universe_id
  WHERE w.ccu_avg >= $3
),
previous AS (
  SELECT h.universe_id, avg(h.ccu_avg) AS previous_avg, count(*) AS previous_samples
  FROM game_hourly h
  JOIN selected s ON s.universe_id = h.universe_id
  WHERE h.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 2 * $4)
    AND h.bucket < time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => $4)
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
  WHERE cur.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => $4)
    AND cur.bucket < time_bucket(INTERVAL '1 hour', $1)
    AND week.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24 + $4)
    AND week.bucket < time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24)
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
-- A game poll did not read a week earlier was usually not discovered yet, while Rolimon's already listed its places:
-- its census, summed over the places listed in both hours, against the same market totals. A place counts its own
-- players only, which the ratio of the two windows cancels. Census history is read place by place through its index
-- (OFFSET 0 keeps each lookup a per-place scan rather than a join over every listed place).
unpaired_places AS MATERIALIZED (
  SELECT p.universe_id, p.place_id
  FROM selected s
  JOIN places p ON p.universe_id = s.universe_id
  WHERE NOT EXISTS (SELECT 1 FROM week_shares ws WHERE ws.universe_id = s.universe_id)
),
census_now AS (
  SELECT up.universe_id, up.place_id, ch.bucket, ch.ccu_avg
  FROM unpaired_places up
  CROSS JOIN LATERAL (
    SELECT c.bucket, c.ccu_avg
    FROM census_hourly c
    WHERE c.place_id = up.place_id
      AND c.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => $4)
      AND c.bucket < time_bucket(INTERVAL '1 hour', $1)
    OFFSET 0
  ) ch
),
census_week AS (
  SELECT up.universe_id, up.place_id, ch.bucket, ch.ccu_avg
  FROM unpaired_places up
  CROSS JOIN LATERAL (
    SELECT c.bucket, c.ccu_avg
    FROM census_hourly c
    WHERE c.place_id = up.place_id
      AND c.bucket >= time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24 + $4)
      AND c.bucket < time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24)
    OFFSET 0
  ) ch
),
census_pairs AS (
  SELECT cn.universe_id, cn.bucket, sum(cn.ccu_avg)::double precision AS ccu, sum(cw.ccu_avg)::double precision AS week_ccu
  FROM census_now cn
  JOIN census_week cw ON cw.place_id = cn.place_id AND cw.bucket = cn.bucket - make_interval(hours => 7 * 24)
  GROUP BY cn.universe_id, cn.bucket
),
census_shares AS (
  SELECT cp.universe_id,
    avg(cp.ccu / nullif(t.total, 0)) AS share,
    avg(cp.week_ccu / nullif(t.week_total, 0)) AS week_share,
    count(*) AS week_samples
  FROM census_pairs cp
  JOIN pair_totals t ON t.bucket = cp.bucket
  GROUP BY cp.universe_id
),
-- The games poll did not read whose places Rolimon's listed in any hour of the week-ago window.
census_listed AS (
  SELECT DISTINCT cw.universe_id FROM census_week cw
),
-- The hours of the week-ago window with a stored Rolimon's list. All of them means census was watching: a game none of
-- them listed had too few players for Rolimon's, so its growth counts from 0.
census_coverage AS (
  SELECT count(*) AS hours
  FROM generate_series(
    time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24 + $4),
    time_bucket(INTERVAL '1 hour', $1) - make_interval(hours => 7 * 24 + 1),
    INTERVAL '1 hour'
  ) AS week_hours(bucket)
  WHERE EXISTS (SELECT 1 FROM census_hourly ch WHERE ch.bucket = week_hours.bucket)
),
baselines AS (
  SELECT s.*,
    pv.previous_avg,
    coalesce(pv.previous_samples, 0) AS previous_samples,
    (CASE
      WHEN ws.universe_id IS NOT NULL THEN 'tracked'
      WHEN cs.universe_id IS NOT NULL THEN 'census'
      -- Created after the start of the week-ago window: the game had no players to compare with.
      WHEN s.roblox_created_at >= time_bucket(INTERVAL '1 hour', $1)
        - make_interval(hours => 7 * 24 + $4) THEN 'new'
      WHEN cl.universe_id IS NULL AND cc.hours >= $4 THEN 'unlisted'
      ELSE 'unknown'
    END) AS week_baseline,
    coalesce(ws.share, cs.share) AS share,
    coalesce(ws.week_share, cs.week_share) AS week_share,
    coalesce(ws.week_samples, cs.week_samples, 0) AS week_samples
  FROM selected s
  CROSS JOIN census_coverage cc
  LEFT JOIN previous pv ON pv.universe_id = s.universe_id
  LEFT JOIN week_shares ws ON ws.universe_id = s.universe_id
  LEFT JOIN census_shares cs ON cs.universe_id = s.universe_id
  LEFT JOIN census_listed cl ON cl.universe_id = s.universe_id
),
scored AS (
  SELECT b.*,
    b.share / nullif(b.week_share, 0) AS week_growth,
    (CASE
      WHEN b.week_baseline IN ('tracked', 'census') THEN
        ln(nullif(b.share * pm.total + $5, 0)
          / nullif(b.week_share * pm.total + $5, 0))
      WHEN b.week_baseline IN ('new', 'unlisted') THEN
        ln(nullif(b.ccu_avg + $5, 0) / nullif($5, 0))
    END) AS week_growth_score,
    b.ccu_avg / nullif(b.previous_avg, 0) AS day_growth
  FROM baselines b
  CROSS JOIN pair_market pm
),
-- Every sort ends with the window's average CCU, then the universe id, so the order is stable.
ranked AS (
  SELECT sc.*,
    row_number() OVER (ORDER BY
      (CASE $12 WHEN 'growth' THEN sc.week_growth_score WHEN 'acceleration' THEN sc.day_growth END)
        DESC NULLS LAST,
      (CASE WHEN $12 = 'age' THEN sc.roblox_created_at END) DESC NULLS LAST,
      sc.ccu_avg DESC,
      sc.universe_id
    ) AS sort_rank
  FROM scored sc
  ORDER BY sort_rank
  LIMIT $13
),
-- The freshest CCU, from the observations themselves: the current hour is not whole yet.
latest AS (
  SELECT DISTINCT ON (o.universe_id) o.universe_id, o.ccu, o.observed_at
  FROM game_observations o
  JOIN ranked r ON r.universe_id = o.universe_id
  WHERE o.observed_at <= $1
    AND o.observed_at > $1 - make_interval(hours => $4)
  ORDER BY o.universe_id, o.observed_at DESC
),
-- One hourly reading per game, from poll and from the census of its places: census lists a place long before its CCU
-- earns it a poll, which dates the threshold crossings. A place counts its own players only, so a crossing dated from
-- census can be late, never early.
-- Read game by game and place by place through their indexes, like the census above.
readings AS (
  SELECT x.universe_id, x.bucket, max(x.ccu_max) AS ccu_max
  FROM (
    SELECT r.universe_id, h.bucket, h.ccu_max
    FROM ranked r
    CROSS JOIN LATERAL (
      SELECT g.bucket, g.ccu_max
      FROM game_hourly g
      WHERE g.universe_id = r.universe_id
        AND g.bucket < time_bucket(INTERVAL '1 hour', $1)
        AND g.bucket >= $1 - make_interval(hours => 24 * ($2 + 1))
      OFFSET 0
    ) h
    UNION ALL
    SELECT r.universe_id, ch.bucket, ch.ccu_max
    FROM ranked r
    JOIN places p ON p.universe_id = r.universe_id
    CROSS JOIN LATERAL (
      SELECT c.bucket, c.ccu_max
      FROM census_hourly c
      WHERE c.place_id = p.place_id
        AND c.bucket < time_bucket(INTERVAL '1 hour', $1)
        AND c.bucket >= $1 - make_interval(hours => 24 * ($2 + 1))
      OFFSET 0
    ) ch
  ) x
  GROUP BY x.universe_id, x.bucket
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
    min(s.bucket) FILTER (WHERE s.ccu_max >= $8) AS at_start,
    min(s.bucket) FILTER (WHERE s.ccu_max >= $9) AS at_middle,
    min(s.bucket) FILTER (WHERE s.ccu_max >= $10) AS at_end,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= $8))[1] AS gap_start,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= $9))[1] AS gap_middle,
    (array_agg(s.gap ORDER BY s.bucket) FILTER (WHERE s.ccu_max >= $10))[1] AS gap_end
  FROM series s
  GROUP BY s.universe_id
),
-- v1 daily peaks (2026-08-24 to 2026-09-19), older than the hourly history; a day that has not ended by as_of is left out.
legacy_peaks AS (
  SELECT l.universe_id, max(l.ccu_peak) AS peak
  FROM game_daily_legacy l
  JOIN ranked r ON r.universe_id = l.universe_id
  WHERE l.day + INTERVAL '24 hours' <= $1
  GROUP BY l.universe_id
)
SELECT
  r.sort_rank::int,
  r.universe_id::bigint,
  r.name,
  r.icon_url,
  r.roblox_created_at,
  r.first_observed_at,
  l.ccu::int,
  l.observed_at,
  r.ccu_avg::double precision,
  greatest(x.peak, l.ccu, lp.peak)::int,
  r.window_peak::int,
  r.window_median::double precision,
  r.window_last::double precision,
  -- A spike that has come back down: a breakout still rising at the end of the window is not an event.
  (r.samples >= $7
    AND r.window_peak >= $6 * r.window_median
    AND r.window_last < $6 * r.window_median),
  r.week_baseline::text,
  r.week_growth::double precision,
  r.week_growth_score::double precision,
  r.day_growth::double precision,
  x.first_seen_ccu::int,
  (CASE
    WHEN x.gap_start <= make_interval(hours => $11)
      AND x.gap_middle <= make_interval(hours => $11)
      THEN extract(epoch FROM x.at_middle - x.at_start) / 3600
  END)::double precision,
  (CASE
    WHEN x.gap_middle <= make_interval(hours => $11)
      AND x.gap_end <= make_interval(hours => $11)
      THEN extract(epoch FROM x.at_end - x.at_middle) / 3600
  END)::double precision,
  r.samples::int,
  r.previous_samples::int,
  r.week_samples::int
FROM ranked r
LEFT JOIN latest l ON l.universe_id = r.universe_id
LEFT JOIN crossings x ON x.universe_id = r.universe_id
LEFT JOIN legacy_peaks lp ON lp.universe_id = r.universe_id
$query$
  USING as_of, max_age_days, min_ccu, window_hours, smoothing_ccu, event_peak_ratio, event_min_samples,
    velocity_start, velocity_middle, velocity_end, velocity_max_gap_hours, sort_by, row_limit;
END
$function$;
