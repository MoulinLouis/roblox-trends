import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGame, getTrendIdsForGame, getTrends } from "@/db/repository";
import { TagEditor } from "@/components/TagEditor";
import { AreaChart, formatCompact, formatDate, formatPercent, GameThumbnail, ScoreRing, StageBadge, TagList } from "@/components/ui";
import { ensureAppReady } from "@/lib/app-ready";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await ensureAppReady();
  const item = await getGame((await params).id);
  return { title: item?.game.normalizedTitle ?? "Game" };
}

export default async function GameDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureAppReady();
  const id = (await params).id;
  const [item, trendIds, allTrends] = await Promise.all([getGame(id), getTrendIdsForGame(id), getTrends()]);
  if (!item) notFound();
  const relatedTrends = allTrends.filter((trend) => trendIds.includes(trend.id));
  const point = item.snapshots.at(-1);
  const metrics = item.analysis?.metrics;
  return <div className="content"><div className="detail-hero"><GameThumbnail name={item.game.normalizedTitle} url={item.game.thumbnailUrl} large /><div className="detail-hero-copy"><p className="eyebrow">Game signal · Universe {item.game.universeId}</p><h1>{item.game.normalizedTitle}</h1><p className="page-subtitle">By {item.game.creatorName} · First seen {formatDate(item.game.firstSeenAt)}</p></div><ScoreRing score={item.analysis?.momentumScore ?? 0} large /><div className="detail-actions"><a className="button" href={`https://www.roblox.com/games/${item.game.rootPlaceId}`} target="_blank" rel="noreferrer">Open Roblox <ExternalLink size={14} /></a></div></div>
    <div className="grid grid-4"><div className="card metric-card"><span className="metric-label">Current CCU</span><div className="metric-value">{formatCompact(point?.ccu ?? 0)}</div><span className="metric-detail">Rank {point?.rank ? `#${point.rank}` : "not charted"}</span></div><div className="card metric-card"><span className="metric-label">24h growth</span><div className={`metric-value ${(metrics?.growth24h ?? 0) >= 0 ? "positive" : "negative"}`}>{formatPercent(metrics?.growth24h ?? 0)}</div><span className="metric-detail">{formatCompact(metrics?.gain24h ?? 0)} net players</span></div><div className="card metric-card"><span className="metric-label">Acceleration</span><div className={`metric-value ${(metrics?.acceleration ?? 0) >= 0 ? "positive" : "negative"}`}>{formatPercent(metrics?.acceleration ?? 0)}</div><span className="metric-detail">Versus the previous 24h period</span></div><div className="card metric-card"><span className="metric-label">Persistence</span><div className="metric-value">{Math.round(metrics?.persistence ?? 0)}%</div><span className="metric-detail">Recent periods still growing</span></div></div>
    <div className="grid grid-2 section"><div className="card chart-card"><div className="chart-header"><div><h2>CCU history</h2><span>Concurrent demand over time</span></div></div><AreaChart points={item.snapshots} value="ccu" /></div><div className="card chart-card"><div className="chart-header"><div><h2>Visit history</h2><span>{formatCompact(metrics?.newVisits24h ?? 0)} new visits in 24h</span></div></div><AreaChart points={item.snapshots} value="visits" color="var(--blue)" /></div><div className="card chart-card"><div className="chart-header"><div><h2>Favorite history</h2><span>{formatCompact(metrics?.newFavorites24h ?? 0)} new favorites in 24h</span></div></div><AreaChart points={item.snapshots} value="favorites" color="var(--purple)" /></div><div className="card chart-card"><div className="chart-header"><div><h2>Chart rank history</h2><span>{metrics?.rankMovement24h ?? 0} places gained in 24h</span></div></div><AreaChart points={item.snapshots} value="rank" color="var(--orange)" /></div></div>
    <div className="dashboard-layout section"><div className="card card-pad"><h2>Momentum score breakdown</h2><div className="breakdown">{metrics?.momentum.breakdown.map((part) => <div className="breakdown-row" key={part.key}><div className="breakdown-name"><strong>{part.label}</strong><span>{part.explanation}</span></div><div className="bar"><span style={{ width: `${part.normalized}%` }} /></div><span className="breakdown-points">{part.points.toFixed(1)} pts</span></div>)}</div></div><div className="card card-pad"><h2>Metadata</h2><div className="metadata"><div className="metadata-row"><span>Created</span><strong>{item.game.createdAt.toLocaleDateString("en")}</strong></div><div className="metadata-row"><span>Last updated</span><strong>{item.game.updatedAt.toLocaleDateString("en")}</strong></div><div className="metadata-row"><span>Visits</span><strong>{formatCompact(point?.visits ?? 0)}</strong></div><div className="metadata-row"><span>Favorites</span><strong>{formatCompact(point?.favorites ?? 0)}</strong></div><div className="metadata-row"><span>Genre</span><strong>{item.game.genre || "Unclassified"}</strong></div><div className="metadata-row"><span>Collection source</span><strong>{point?.chart || "Unknown"}</strong></div></div></div></div>
    <div className="grid grid-2 section"><div className="card card-pad"><h2>Classification</h2><TagList tags={item.tags} /><p className="page-subtitle" style={{ margin: "16px 0" }}>Automatic tags stay separate across loop, progression, reward, social pressure, and theme. Manual additions override gaps without erasing automatic evidence.</p><TagEditor universeId={item.game.universeId} tags={item.tags} /></div><div className="card card-pad"><h2>Related trends</h2>{relatedTrends.length ? <div className="list">{relatedTrends.map((trend) => <Link href={`/trends/${trend.id}`} className="list-row" key={trend.id}><div className="list-row-main"><strong>{trend.label}</strong><span>Opportunity {trend.opportunityScore}/100 · {formatCompact(trend.metrics.combinedCcu)} CCU</span></div><StageBadge stage={trend.stage} /></Link>)}</div> : <p className="page-subtitle">This game is a standalone signal and has not propagated into a related trend yet.</p>}</div></div>
    <section className="section card card-pad"><h2>Description</h2><p className="page-subtitle" style={{ whiteSpace: "pre-wrap" }}>{item.game.description || "No public description provided."}</p></section>
  </div>;
}
