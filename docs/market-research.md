# Roblox market-radar research

Research checked on August 10, 2026. This note records durable implementation lessons, not third-party marketing claims.

## Comparable products

- [rblx.maven](https://rblxmaven.com/) tracks discovery charts every 30 minutes and separates fast climbers, average-CCU surges, new entrants, chart migrations, theme clusters, event lift, and platform launch drag. Its most useful ideas are same-chart rank history, rolling average CCU, retained tracking after chart exit, vote history, and explicit event context.
- [RoWatcher](https://rowatcher.com/) describes breakout scoring through sustained CCU acceleration, visit velocity, favorite-to-visit ratio, and creator portfolio momentum. Its public emerging page can mix first-seen recency with genuinely new releases, so Roblox creation dates remain the source of truth here.
- [Rotrends](https://rotrends.com/) exposes new-and-rising, new-and-stable, top-100 movement, genre trends, likes per 1,000 visits, favorites per 1,000 visits, and estimated session or earnings metrics. Public vote and favorite conversion are useful; opaque revenue and session estimates are not imported.
- [Rolimon's game analytics](https://www.rolimons.com/games) adds votes, ratings, game passes, badges, server samples, and selected historical peaks. Its public game list is useful as an independent discovery source, but coverage is selected and its data is not treated as canonical.
- [RTrack](https://rtrack.live/) emphasizes long historical datasets and platform-versus-game comparisons. The rebuilt site is not yet a stable public product, and its terms do not make it a safe application dependency.
- [GGAID](https://www.ggaid.com/) records hourly CCU for tens of thousands of games and compares short-term movement with historical averages. This confirms that platform breadth and historical baselines matter more than another raw leaderboard.

## Changes adopted

1. Expand collection from three headline charts to 22 verified broad and genre-specific sorts.
2. Keep direct CCU snapshots for recent and recently active games after they leave discovery charts.
3. Preserve cumulative upvotes, downvotes, approval velocity, favorites per 1,000 new visits, and sponsorship observations.
4. Compare ranks only within the same chart and separately recognize migration onto a main discovery chart.
5. Store title and description versions so an update marker remains attributable after the creator removes it.
6. Use bounded Roblox keyword search and recommendation expansion to find related games outside headline charts.
7. Base momentum on comparable rolling averages, increasing from provisional discovery to 24-hour, 72-hour, and 7-day windows as history matures. Penalize event markers, sponsored observations, and drawdown from the recent peak.

## Deliberate exclusions

- Do not import estimated revenue, session length, or retention from a third party without a published, testable methodology.
- Do not make collection depend on scraping a competitor website or copying its datasets.
- Do not label a public competitor signal as organic discovery when sponsorship, influencer coverage, or a live event cannot be ruled out.
- Do not infer competitor D1, D7, or D30 retention. Roblox exposes those metrics only to authorized owners through Creator Analytics and the Analytics Query API.

## Future evidence worth adding

- Optional YouTube and Twitch overlays when official API credentials are configured, with exact release times and reach. This should remain context, not proof of causation.
- Age-and-genre percentile benchmarks after the local database has enough breadth and at least several weeks of history.
- Hour-of-week seasonal baselines after two or more complete weeks, so weekends and regional peaks are not mistaken for acceleration.
- Creator portfolio momentum and clone-launch cadence after creator histories have sufficient coverage.
- For a game owned by the operator, optional Roblox Analytics Query API metrics for acquisition source, play-through rate, session time, and D1/D7 retention. These private metrics cannot be collected for competitors.
