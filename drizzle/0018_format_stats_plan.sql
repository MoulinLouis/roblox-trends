-- One row per format with readings in the latest complete UTC week (the week that ended by as_of), built on
-- format_weeks (0016) over trend_weeks weeks: the latest week's figures, the share trend, the leader's own trend, the
-- hit counts of the whole window, the format's wave and its followers, and a phase label with the rule that gave it.
-- Every threshold is a parameter: src/lib/config.ts (FORMAT_CONFIG) holds the values.
--
-- share_trend is the shares of the newest half of the window over those of the oldest half (week W-1 + W over W-3 + W-2
-- for four weeks); null when the oldest half has no readings. leader_trend is the same formula over the CCU of week W's
-- leader, followed through its own daily rows in every week of the window, whatever its rank was then, with the
-- per-week averaging of format_weeks (divided by the days the market has readings for). entrants, entrants_matured,
-- hits_small and hits_large sum the window's weeks.
--
-- first_wave_day is the earliest UTC day before as_of on which one of the format's games reached wave_ccu as its daily
-- peak, wave_age_days the whole days from it to as_of, and wave_before_history says that day is the first day of
-- game_daily_all (the wave may have begun earlier). Followers are the format's games of rank follower_first to
-- follower_last in order of creation (then universe_id) among those created before as_of; each one's peak is its highest
-- daily peak over the hit_days UTC days from its creation day, and a follower whose window has not ended by as_of, or
-- with no reading in it, is left out of followers and of the median.
--
-- phase, in order: small (fewer than minimum_games games or under minimum_ccu average CCU in week W); unknown (the
-- window mixes top and full coverage); emerging (the wave is under emerging_days old, or the oldest half has no
-- readings); rising (share trend of rising_ratio or more); declining (share trend of declining_ratio or less, or a
-- leader holding leader_carry_share of the format or more with a leader trend of declining_ratio or less); else
-- plateau. phase_rule gives the measured value and the threshold.
--
-- 0018 replaces 0017's query, unchanged in what it returns. The planner takes format_weeks for a 1,000-row function and
-- estimated 2 latest formats where production had 771 (2026-11-11), so it planned two loops that read game_daily_all
-- once per row: the wave joined every format game to the whole view (about 40 s), and the followers' ranking ran once
-- per format with the peak lookup before the rank filter (2.45 million lookups). The call hit the analysis role's
-- 5-minute timeout. Each game's first wave day is now read in one pass (game_waves), and the ranking and the followers
-- (ranks follower_first to follower_last) are materialized once before the peak lookup: 3.4 s on production.
--
-- PL/pgSQL running one query through EXECUTE ... USING, like format_weeks. The arguments are $1 as_of,
-- $2 full_coverage_from, $3 hit_days, $4 hit_small, $5 hit_large, $6 wave_ccu, $7 follower_first, $8 follower_last,
-- $9 trend_weeks, $10 minimum_games, $11 minimum_ccu, $12 emerging_days, $13 rising_ratio, $14 declining_ratio and
-- $15 leader_carry_share.
CREATE OR REPLACE FUNCTION format_stats(
  as_of timestamptz,
  full_coverage_from date,
  hit_days int,
  hit_small int,
  hit_large int,
  wave_ccu int,
  follower_first int,
  follower_last int,
  trend_weeks int,
  minimum_games int,
  minimum_ccu int,
  emerging_days int,
  rising_ratio double precision,
  declining_ratio double precision,
  leader_carry_share double precision
)
RETURNS TABLE (
  dimension text,
  format text,
  week_start timestamptz,
  coverage text,
  games int,
  ccu_avg double precision,
  share double precision,
  share_trend double precision,
  leader_universe_id bigint,
  leader_name text,
  leader_share double precision,
  leader_trend double precision,
  entrants int,
  entrants_matured int,
  hits_small int,
  hits_large int,
  first_wave_day timestamptz,
  wave_age_days int,
  wave_before_history boolean,
  followers int,
  followers_median_peak double precision,
  phase text,
  phase_rule text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $function$
BEGIN
  RETURN QUERY EXECUTE $query$
WITH calendar AS (
  SELECT (date_trunc('week', $1 AT TIME ZONE 'UTC') - INTERVAL '7 days') AT TIME ZONE 'UTC' AS latest_start,
    (date_trunc('week', $1 AT TIME ZONE 'UTC') - $9 * INTERVAL '7 days') AT TIME ZONE 'UTC' AS first_start,
    date_trunc('week', $1 AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS range_end
),
weekly AS (
  SELECT f.*,
    ((c.latest_start AT TIME ZONE 'UTC')::date - (f.week_start AT TIME ZONE 'UTC')::date) / 7 AS age
  FROM format_weeks($1, $9, $2, $3, $4, $5) f
  CROSS JOIN calendar c
),
latest AS (
  SELECT * FROM weekly w WHERE w.age = 0 AND w.games > 0
),
summed AS (
  SELECT w.dimension, w.format,
    coalesce(sum(w.share) FILTER (WHERE w.age < $9 / 2), 0) AS recent,
    coalesce(sum(w.share) FILTER (WHERE w.age >= $9 / 2), 0) AS previous,
    sum(w.entrants) AS entrants,
    sum(w.entrants_matured) AS entrants_matured,
    sum(w.hits_small) AS hits_small,
    sum(w.hits_large) AS hits_large
  FROM weekly w
  GROUP BY w.dimension, w.format
),
daily AS (
  SELECT d.universe_id, d.day,
    date_trunc('week', d.day AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS week_start,
    d.ccu_avg::double precision AS ccu_avg
  FROM game_daily_all d
  CROSS JOIN calendar c
  WHERE d.day >= c.first_start AND d.day < c.range_end
),
market_days AS (
  SELECT dy.week_start, count(DISTINCT dy.day) AS days FROM daily dy GROUP BY dy.week_start
),
-- Week W's leader through its own rows in every week of the window.
leader_week AS (
  SELECT l.dimension, l.format,
    ((c.latest_start AT TIME ZONE 'UTC')::date - (dy.week_start AT TIME ZONE 'UTC')::date) / 7 AS age,
    sum(dy.ccu_avg) / md.days AS ccu
  FROM latest l
  CROSS JOIN calendar c
  JOIN daily dy ON dy.universe_id = l.leader_universe_id
  JOIN market_days md ON md.week_start = dy.week_start
  GROUP BY l.dimension, l.format, dy.week_start, md.days, c.latest_start
),
leader_trends AS (
  SELECT lw.dimension, lw.format,
    sum(lw.ccu) FILTER (WHERE lw.age < $9 / 2) / nullif(sum(lw.ccu) FILTER (WHERE lw.age >= $9 / 2), 0) AS trend
  FROM leader_week lw
  GROUP BY lw.dimension, lw.format
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
),
format_games AS (
  SELECT l.dimension, l.format, m.universe_id
  FROM latest l
  JOIN memberships m ON m.dimension = l.dimension AND m.format = l.format
),
game_waves AS MATERIALIZED (
  SELECT d.universe_id, min(d.day) AS day
  FROM game_daily_all d
  WHERE d.ccu_peak >= $6 AND d.day < $1
  GROUP BY d.universe_id
),
waves AS (
  SELECT fg.dimension, fg.format, min(gw.day) AS day
  FROM format_games fg
  JOIN game_waves gw ON gw.universe_id = fg.universe_id
  GROUP BY fg.dimension, fg.format
),
ranked AS MATERIALIZED (
  SELECT fg.dimension, fg.format, g.universe_id, g.roblox_created_at,
    row_number() OVER (PARTITION BY fg.dimension, fg.format ORDER BY g.roblox_created_at, g.universe_id) AS rank
  FROM format_games fg
  JOIN games g ON g.universe_id = fg.universe_id
  WHERE g.roblox_created_at < $1
),
followers AS MATERIALIZED (
  SELECT r.dimension, r.format, r.universe_id, r.roblox_created_at
  FROM ranked r
  WHERE r.rank BETWEEN $7 AND $8
    AND r.roblox_created_at + make_interval(hours => 24 * $3) <= $1
),
-- The UTC days from the creation day, as in format_weeks.
follower_peaks AS (
  SELECT r.dimension, r.format, p.peak
  FROM followers r
  CROSS JOIN LATERAL (
    SELECT max(d.ccu_peak) AS peak
    FROM game_daily_all d
    WHERE d.universe_id = r.universe_id
      AND d.day >= date_trunc('day', r.roblox_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND d.day < (date_trunc('day', r.roblox_created_at AT TIME ZONE 'UTC') + $3 * INTERVAL '1 day') AT TIME ZONE 'UTC'
  ) p
  WHERE p.peak IS NOT NULL
),
follower_stats AS (
  SELECT fp.dimension, fp.format, count(*) AS followers,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY fp.peak::double precision) AS median_peak
  FROM follower_peaks fp
  GROUP BY fp.dimension, fp.format
),
measured AS (
  SELECT l.dimension, l.format, l.week_start, l.coverage, l.games, l.ccu_avg,
    coalesce(l.share, 0) AS share,
    s.recent, s.previous,
    s.recent / nullif(s.previous, 0) AS share_trend,
    l.leader_universe_id, l.leader_name, l.leader_share, lt.trend AS leader_trend,
    s.entrants, s.entrants_matured, s.hits_small, s.hits_large,
    wv.day AS first_wave_day,
    floor(extract(epoch FROM ($1 - wv.day)) / 86400)::int AS wave_age_days,
    wv.day = (SELECT min(d.day) FROM game_daily_all d) AS wave_before_history,
    fs.followers, fs.median_peak,
    ((c.first_start AT TIME ZONE 'UTC')::date < $2 AND (c.latest_start AT TIME ZONE 'UTC')::date >= $2) AS mixed
  FROM latest l
  CROSS JOIN calendar c
  JOIN summed s ON s.dimension = l.dimension AND s.format = l.format
  LEFT JOIN leader_trends lt ON lt.dimension = l.dimension AND lt.format = l.format
  LEFT JOIN waves wv ON wv.dimension = l.dimension AND wv.format = l.format
  LEFT JOIN follower_stats fs ON fs.dimension = l.dimension AND fs.format = l.format
),
labelled AS (
  SELECT mz.*,
    CASE
      WHEN mz.games < $10 OR mz.ccu_avg < $11 THEN 'small'
      WHEN mz.mixed THEN 'unknown'
      WHEN mz.wave_age_days < $12 OR mz.previous = 0 THEN 'emerging'
      WHEN mz.share_trend >= $13 THEN 'rising'
      WHEN mz.share_trend <= $14 THEN 'declining'
      WHEN mz.leader_share >= $15 AND mz.leader_trend <= $14 THEN 'declining'
      ELSE 'plateau'
    END AS phase
  FROM measured mz
)
SELECT
  lb.dimension,
  lb.format,
  lb.week_start,
  lb.coverage,
  lb.games::int,
  lb.ccu_avg::double precision,
  lb.share::double precision,
  lb.share_trend::double precision,
  lb.leader_universe_id::bigint,
  lb.leader_name,
  lb.leader_share::double precision,
  lb.leader_trend::double precision,
  lb.entrants::int,
  lb.entrants_matured::int,
  lb.hits_small::int,
  lb.hits_large::int,
  lb.first_wave_day,
  lb.wave_age_days,
  lb.wave_before_history,
  coalesce(lb.followers, 0)::int,
  lb.median_peak::double precision,
  lb.phase,
  (CASE lb.phase
    WHEN 'small' THEN format('%s games and %s average CCU in the latest week (small under %s games or under %s average CCU)',
      lb.games, round(lb.ccu_avg), $10, $11)
    WHEN 'unknown' THEN format('the %s weeks mix top and full coverage (full from %s)', $9, $2)
    WHEN 'emerging' THEN CASE
      WHEN lb.wave_age_days < $12 THEN format('first %s CCU day %s days ago (emerging under %s days)', $6, lb.wave_age_days, $12)
      ELSE format('no readings in the first %s weeks of the %s (emerging)', $9 / 2, $9)
    END
    WHEN 'rising' THEN format('share x%s over %s weeks (rising at x%s or more)',
      to_char(round(lb.share_trend::numeric, 2), 'FM999990.00'), $9, to_char(round($13::numeric, 2), 'FM999990.00'))
    WHEN 'declining' THEN CASE
      WHEN lb.share_trend <= $14 THEN format('share x%s over %s weeks (declining at x%s or less)',
        to_char(round(lb.share_trend::numeric, 2), 'FM999990.00'), $9, to_char(round($14::numeric, 2), 'FM999990.00'))
      ELSE format('leader %s holds %s%% of the format and its CCU went x%s over %s weeks (declining at x%s or less when it holds %s%% or more)',
        lb.leader_name, round(lb.leader_share::numeric * 100),
        to_char(round(lb.leader_trend::numeric, 2), 'FM999990.00'), $9,
        to_char(round($14::numeric, 2), 'FM999990.00'), round($15::numeric * 100))
    END
    ELSE format('share x%s over %s weeks (between x%s and x%s)',
      to_char(round(lb.share_trend::numeric, 2), 'FM999990.00'), $9,
      to_char(round($14::numeric, 2), 'FM999990.00'), to_char(round($13::numeric, 2), 'FM999990.00'))
  END)::text
FROM labelled lb
ORDER BY lb.dimension, lb.format
$query$
  USING as_of, full_coverage_from, hit_days, hit_small, hit_large, wave_ccu, follower_first, follower_last,
    trend_weeks, minimum_games, minimum_ccu, emerging_days, rising_ratio, declining_ratio, leader_carry_share;
END
$function$;
