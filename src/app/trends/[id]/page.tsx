import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaChart, formatCompact, formatDate, formatPercent, PageHeading, ScoreRing, StageBadge } from "@/components/ui";
import { GameList } from "@/components/GameList";
import { ensureAppReady } from "@/lib/app-ready";
import { getTrend } from "@/db/repository";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await ensureAppReady();
  const result = await getTrend((await params).id);
  return { title: result?.trend.label ?? "Trend" };
}

export default async function TrendDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureAppReady();
  const result = await getTrend((await params).id);
  if (!result) notFound();
  const { trend, history, games } = result;
  const leaders = [...games].sort((a, b) => (b.snapshots.at(-1)?.ccu ?? 0) - (a.snapshots.at(-1)?.ccu ?? 0));
  const creators = [...new Set(games.map((item) => item.game.creatorName))];
  const entrants = games.filter((item) => trend.analyzedAt.getTime() - item.game.firstSeenAt.getTime() <= 7 * 24 * 60 * 60 * 1000);
  const allTags = new Map<string, number>();
  for (const item of games) for (const tag of item.tags) allTags.set(tag.tag, (allTags.get(tag.tag) ?? 0) + 1);
  const combinedPoints = history.map((entry) => ({ collectedAt: entry.dayAt, ccu: entry.combinedCcu, visits: 0, favorites: 0, rank: null }));
  const gameCountPoints = history.map((entry) => ({ collectedAt: entry.dayAt, ccu: entry.gameCount, visits: 0, favorites: 0, rank: null }));
  return <div className="content"><PageHeading eyebrow="Trend intelligence" title={trend.label} subtitle={`${trend.metrics.creatorCount} independent creators carry this signal. ${Math.round(trend.metrics.growingShare)}% of related games are growing, while the leader holds ${Math.round(trend.metrics.leaderShare)}% of demand.`} action={<div style={{ display: "flex", alignItems: "center", gap: 12 }}><StageBadge stage={trend.stage} /><ScoreRing score={trend.opportunityScore} large color="var(--purple)" /></div>} />
    <div className="grid grid-4"><div className="card metric-card"><span className="metric-label">Combined CCU</span><div className="metric-value">{formatCompact(trend.metrics.combinedCcu)}</div><span className="metric-detail">Across {trend.metrics.gameCount} games</span></div><div className="card metric-card"><span className="metric-label">72h demand</span><div className={`metric-value ${trend.metrics.combinedGrowth72h >= 0 ? "positive" : "negative"}`}>{formatPercent(trend.metrics.combinedGrowth72h)}</div><span className="metric-detail">Protected aggregate growth</span></div><div className="card metric-card"><span className="metric-label">Trend strength</span><div className="metric-value">{trend.trendScore}</div><span className="metric-detail">Breadth, growth, and demand</span></div><div className="card metric-card"><span className="metric-label">Saturation</span><div className={`metric-value ${trend.saturationScore >= 70 ? "negative" : "warning"}`}>{trend.saturationScore}</div><span className="metric-detail">Supply pressure and flat demand</span></div></div>
    <div className="grid grid-2 section"><div className="card chart-card"><div className="chart-header"><div><h2>Combined CCU history</h2><span>Demand across all related games</span></div></div><AreaChart points={combinedPoints} value="ccu" /></div><div className="card chart-card"><div className="chart-header"><div><h2>Game count evolution</h2><span>Supply entering the format</span></div></div><AreaChart points={gameCountPoints} value="ccu" color="var(--orange)" yAxisLabel="Related games" /></div></div>
    <div className="dashboard-layout section"><div><div className="section-heading"><h2>Leading games</h2><span className="trend-meta">Ranked by current CCU</span></div><div className="card table-shell"><GameList items={leaders.slice(0, 8)} compact /></div></div><div className="grid"><div className="card card-pad"><h2>Saturation explanation</h2><p className="page-subtitle">{trend.saturationExplanation}</p><div className="metadata" style={{ marginTop: 12 }}><div className="metadata-row"><span>New entrants · 7d</span><strong>{trend.metrics.newGames7d}</strong></div><div className="metadata-row"><span>Leader share</span><strong>{Math.round(trend.metrics.leaderShare)}%</strong></div><div className="metadata-row"><span>Growing share</span><strong>{Math.round(trend.metrics.growingShare)}%</strong></div><div className="metadata-row"><span>72h history coverage</span><strong>{Math.round(trend.metrics.historyCoverage)}%</strong></div><div className="metadata-row"><span>Creators</span><strong>{trend.metrics.creatorCount}</strong></div></div></div><div className="card card-pad"><h2>Related tags</h2><div className="tags">{[...allTags.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => <span className="tag" key={tag}>{tag} · {count}</span>)}</div></div></div></div>
    <div className="grid grid-2 section"><div className="card card-pad"><h2>Opportunity score explanation</h2><div className="breakdown">{trend.scoreBreakdown.map((part) => <div className="breakdown-row" key={part.key}><div className="breakdown-name"><strong>{part.label}</strong><span>{part.explanation}</span></div><div className="bar"><span style={{ width: `${part.normalized}%` }} /></div><span className="breakdown-points">{part.points.toFixed(1)} pts</span></div>)}</div></div><div className="card card-pad"><h2>Stage history</h2><div className="list">{history.slice().reverse().map((entry) => <div className="list-row" key={entry.id}><div className="list-row-main"><strong>{formatDate(entry.dayAt)}</strong><span>{formatCompact(entry.combinedCcu)} CCU · {entry.gameCount} games</span></div><StageBadge stage={entry.stage} /></div>)}</div></div></div>
    <div className="grid grid-2 section"><div className="card card-pad"><h2>Independent creators</h2><div className="tags">{creators.map((creator) => <span className="tag" key={creator}>{creator}</span>)}</div></div><div className="card card-pad"><h2>New entrants</h2>{entrants.length ? <div className="list">{entrants.map((item) => <div className="list-row" key={item.game.universeId}><div className="list-row-main"><strong>{item.game.normalizedTitle}</strong><span>First seen {formatDate(item.game.firstSeenAt)}</span></div><strong>{formatCompact(item.snapshots.at(-1)?.ccu ?? 0)} CCU</strong></div>)}</div> : <p className="page-subtitle">No game entered this signal in the last seven days.</p>}</div></div>
  </div>;
}
