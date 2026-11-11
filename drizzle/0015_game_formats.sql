-- game_classifications with the owner's vocabulary merges applied (src/lib/classify/merges.ts, copied into
-- classification_merges by every classify run), so near-duplicate spellings of a format count as one. format_stats reads
-- this view. Analysis sessions read it for merged values and game_classifications for the model's own answers.
-- The join key is the SQL mirror of mergeKey: collapse whitespace runs, trim, lower-case. Games without a family are left out.
CREATE VIEW game_formats AS
SELECT
  c.universe_id,
  coalesce(mf.to_value, c.family) AS family,
  coalesce(mt.to_value, c.template) AS template,
  coalesce(mr.to_value, c.reward_loop) AS reward_loop
FROM game_classifications c
LEFT JOIN classification_merges mf
  ON mf.field = 'family' AND mf.from_key = lower(btrim(regexp_replace(c.family, '\s+', ' ', 'g')))
LEFT JOIN classification_merges mt
  ON mt.field = 'template' AND mt.from_key = lower(btrim(regexp_replace(c.template, '\s+', ' ', 'g')))
LEFT JOIN classification_merges mr
  ON mr.field = 'rewardLoop' AND mr.from_key = lower(btrim(regexp_replace(c.reward_loop, '\s+', ' ', 'g')))
WHERE c.family IS NOT NULL;
