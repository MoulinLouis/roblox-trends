-- The current classification of each game, with the owner's overrides applied field by field (src/lib/classify/overrides.ts,
-- copied into classification_overrides by every classify run). A game with overrides and no classification yet still
-- has a row. Analysis sessions and format_stats read this view, never the tables.
CREATE VIEW game_classifications AS
WITH latest AS (
  SELECT DISTINCT ON (c.universe_id)
    c.universe_id, c.name, c.reason, c.family, c.template, c.reward_loop, c.core_action, c.theme, c.setting,
    c.progression, c.social, c.confidence, c.finished_at, b.model, b.prompt_version
  FROM classifications c
  JOIN classification_batches b ON b.id = c.batch_id
  WHERE c.status = 'classified'
  ORDER BY c.universe_id, c.finished_at DESC
),
overridden AS (
  SELECT universe_id,
    max(value) FILTER (WHERE field = 'family') AS family,
    max(value) FILTER (WHERE field = 'template') AS template,
    max(value) FILTER (WHERE field = 'rewardLoop') AS reward_loop,
    max(value) FILTER (WHERE field = 'coreAction') AS core_action
  FROM classification_overrides
  GROUP BY universe_id
)
SELECT
  coalesce(l.universe_id, o.universe_id) AS universe_id,
  coalesce(o.family, l.family) AS family,
  coalesce(o.template, l.template) AS template,
  coalesce(o.reward_loop, l.reward_loop) AS reward_loop,
  coalesce(o.core_action, l.core_action) AS core_action,
  l.theme, l.setting, l.progression, l.social, l.confidence, l.reason,
  l.name AS classified_name, l.model, l.prompt_version, l.finished_at AS classified_at,
  o.universe_id IS NOT NULL AS overridden
FROM latest l
FULL JOIN overridden o ON o.universe_id = l.universe_id;
