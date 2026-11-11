-- One row per format and complete UTC week (Monday 00:00 to Monday 00:00, the `weeks` most recent that ended by as_of),
-- computed on demand from game_daily_all and game_formats so the dashboard, analysis sessions and backtests share one
-- definition. Every threshold is a parameter: src/lib/config.ts (FORMAT_CONFIG) holds the values. Week boundaries are
-- computed on UTC wall-clock timestamps and converted back, so neither the session time zone nor daylight saving moves them.
--
-- dimension is family, template, reward_loop or family_reward_loop (format reads 'family × reward_loop'). A template's
-- games are grouped by its normalized key (whitespace collapsed, lower-cased) and shown with their most frequent
-- spelling across all games; template 'none' has no row. dimension_filter and format_filter (case-insensitive) narrow the
-- result.
--
-- CCU figures are the sum of the games' daily average CCU over the week divided by the number of distinct days on which
-- the market (every game in game_daily_all) has readings, not by 7: a week with missing days is not understated. share is
-- the format's ccu_avg over the market's. The leader is the format's game with the highest such average, its
-- leader_previous_ccu is the same figure for the week before (read one week earlier than the first returned week; null
-- without readings), and leader_share is its part of the format.
--
-- An entrant is a game created in the week (games.roblox_created_at). It is matured once hit_days days have passed by
-- as_of, and a hit when its highest daily peak, over the hit_days UTC days from its creation day, reaches hit_small or
-- hit_large. A format with entrants and no readings in a week still has a row (games and ccu_avg 0).
--
-- coverage is 'top' for a week starting before full_coverage_from, else 'full'.
--
-- PL/pgSQL running its query through EXECUTE ... USING, like rising_games (0009): the query is planned at every call with
-- the arguments as constants, so TimescaleDB replaces the continuous aggregate's cagg_watermark() by its value before
-- planning. The arguments are $1 as_of, $2 weeks, $3 full_coverage_from, $4 hit_days, $5 hit_small, $6 hit_large,
-- $7 dimension_filter and $8 format_filter.
CREATE OR REPLACE FUNCTION format_weeks(
  as_of timestamptz,
  weeks int,
  full_coverage_from date,
  hit_days int,
  hit_small int,
  hit_large int,
  dimension_filter text DEFAULT NULL,
  format_filter text DEFAULT NULL
)
RETURNS TABLE (
  dimension text,
  format text,
  week_start timestamptz,
  coverage text,
  market_games int,
  market_ccu double precision,
  games int,
  ccu_avg double precision,
  share double precision,
  leader_universe_id bigint,
  leader_name text,
  leader_ccu double precision,
  leader_previous_ccu double precision,
  leader_share double precision,
  entrants int,
  entrants_matured int,
  hits_small int,
  hits_large int
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $function$
BEGIN
  RETURN QUERY EXECUTE $query$
-- The weeks, newest first. One more than asked for is read: the oldest only gives the leaders' previous CCU.
WITH weeks AS (
  SELECT
    (date_trunc('week', $1 AT TIME ZONE 'UTC') - k * INTERVAL '7 days') AT TIME ZONE 'UTC' AS week_start,
    (date_trunc('week', $1 AT TIME ZONE 'UTC') - (k + 1) * INTERVAL '7 days') AT TIME ZONE 'UTC' AS previous_start,
    k <= $2 AS shown
  FROM generate_series(1, $2 + 1) AS k
),
bounds AS (
  SELECT min(w.week_start) AS range_start,
    date_trunc('week', $1 AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS range_end
  FROM weeks w
),
daily AS (
  SELECT d.universe_id,
    date_trunc('week', d.day AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS week_start,
    d.day,
    d.ccu_avg::double precision AS ccu_avg
  FROM game_daily_all d
  CROSS JOIN bounds r
  WHERE d.day >= r.range_start AND d.day < r.range_end
),
market AS (
  SELECT dy.week_start,
    count(DISTINCT dy.universe_id) AS games,
    sum(dy.ccu_avg) / count(DISTINCT dy.day) AS ccu
  FROM daily dy
  GROUP BY dy.week_start
),
-- Each game's average CCU of each week, over the market's days.
game_week AS (
  SELECT dy.universe_id, dy.week_start, sum(dy.ccu_avg) / mk.days AS ccu
  FROM daily dy
  JOIN (SELECT d2.week_start, count(DISTINCT d2.day) AS days FROM daily d2 GROUP BY d2.week_start) mk
    ON mk.week_start = dy.week_start
  GROUP BY dy.universe_id, dy.week_start, mk.days
),
templates AS (
  SELECT lower(btrim(regexp_replace(f.template, '\s+', ' ', 'g'))) AS key, f.template, count(*) AS n
  FROM game_formats f
  WHERE f.template IS NOT NULL
  GROUP BY 1, 2
),
shown_templates AS (
  SELECT DISTINCT ON (t.key) t.key, t.template
  FROM templates t
  WHERE t.key NOT IN ('', 'none')
  ORDER BY t.key, t.n DESC, t.template
),
memberships AS (
  SELECT m.universe_id, m.dimension, m.format
  FROM (
    SELECT f.universe_id, 'family'::text AS dimension, f.family AS format
    FROM game_formats f
    UNION ALL
    SELECT f.universe_id, 'reward_loop', f.reward_loop
    FROM game_formats f
    WHERE f.reward_loop IS NOT NULL
    UNION ALL
    SELECT f.universe_id, 'template', st.template
    FROM game_formats f
    JOIN shown_templates st ON st.key = lower(btrim(regexp_replace(f.template, '\s+', ' ', 'g')))
    UNION ALL
    SELECT f.universe_id, 'family_reward_loop', f.family || ' × ' || f.reward_loop
    FROM game_formats f
    WHERE f.reward_loop IS NOT NULL
  ) m
  WHERE ($7 IS NULL OR m.dimension = $7)
    AND ($8 IS NULL OR lower(m.format) = lower($8))
),
format_week AS (
  SELECT m.dimension, m.format, gw.week_start, count(*) AS games, sum(gw.ccu) AS ccu
  FROM memberships m
  JOIN game_week gw ON gw.universe_id = m.universe_id
  JOIN weeks w ON w.week_start = gw.week_start AND w.shown
  GROUP BY m.dimension, m.format, gw.week_start
),
leaders AS (
  SELECT DISTINCT ON (m.dimension, m.format, gw.week_start)
    m.dimension, m.format, gw.week_start, gw.universe_id, gw.ccu, previous.ccu AS previous_ccu
  FROM memberships m
  JOIN game_week gw ON gw.universe_id = m.universe_id
  JOIN weeks w ON w.week_start = gw.week_start AND w.shown
  LEFT JOIN game_week previous ON previous.universe_id = gw.universe_id AND previous.week_start = w.previous_start
  ORDER BY m.dimension, m.format, gw.week_start, gw.ccu DESC, gw.universe_id
),
-- The UTC days from the creation day: a game created at 15:00 on day 1 counts that day's peak.
entrants AS (
  SELECT g.universe_id, w.week_start,
    g.roblox_created_at + make_interval(hours => 24 * $4) <= $1 AS matured,
    date_trunc('day', g.roblox_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hits_from,
    (date_trunc('day', g.roblox_created_at AT TIME ZONE 'UTC') + $4 * INTERVAL '1 day') AT TIME ZONE 'UTC' AS hits_to
  FROM games g
  JOIN weeks w ON w.shown
    AND date_trunc('week', g.roblox_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' = w.week_start
),
entrant_peaks AS (
  SELECT e.universe_id, e.week_start, e.matured, p.peak
  FROM entrants e
  LEFT JOIN LATERAL (
    SELECT max(d.ccu_peak) AS peak
    FROM game_daily_all d
    WHERE e.matured AND d.universe_id = e.universe_id AND d.day >= e.hits_from AND d.day < e.hits_to
  ) p ON true
),
format_entrants AS (
  SELECT m.dimension, m.format, ep.week_start,
    count(*) AS entrants,
    count(*) FILTER (WHERE ep.matured) AS matured,
    count(*) FILTER (WHERE ep.matured AND ep.peak >= $5) AS hits_small,
    count(*) FILTER (WHERE ep.matured AND ep.peak >= $6) AS hits_large
  FROM memberships m
  JOIN entrant_peaks ep ON ep.universe_id = m.universe_id
  GROUP BY m.dimension, m.format, ep.week_start
)
SELECT
  k.dimension,
  k.format,
  k.week_start,
  (CASE WHEN (k.week_start AT TIME ZONE 'UTC')::date < $3 THEN 'top' ELSE 'full' END)::text,
  coalesce(mk.games, 0)::int,
  coalesce(mk.ccu, 0)::double precision,
  coalesce(fw.games, 0)::int,
  coalesce(fw.ccu, 0)::double precision,
  (coalesce(fw.ccu, 0) / nullif(mk.ccu, 0))::double precision,
  l.universe_id::bigint,
  g.name,
  l.ccu::double precision,
  l.previous_ccu::double precision,
  (l.ccu / nullif(fw.ccu, 0))::double precision,
  coalesce(fe.entrants, 0)::int,
  coalesce(fe.matured, 0)::int,
  coalesce(fe.hits_small, 0)::int,
  coalesce(fe.hits_large, 0)::int
FROM format_week fw
FULL JOIN format_entrants fe
  ON fe.dimension = fw.dimension AND fe.format = fw.format AND fe.week_start = fw.week_start
CROSS JOIN LATERAL (
  SELECT coalesce(fw.dimension, fe.dimension) AS dimension,
    coalesce(fw.format, fe.format) AS format,
    coalesce(fw.week_start, fe.week_start) AS week_start
) k
LEFT JOIN market mk ON mk.week_start = k.week_start
LEFT JOIN leaders l ON l.dimension = k.dimension AND l.format = k.format AND l.week_start = k.week_start
LEFT JOIN games g ON g.universe_id = l.universe_id
ORDER BY k.dimension, k.format, k.week_start
$query$
  USING as_of, weeks, full_coverage_from, hit_days, hit_small, hit_large, dimension_filter, format_filter;
END
$function$;
