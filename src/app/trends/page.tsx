import type { Metadata } from "next";
import Link from "next/link";
import { PageHeading, ScoreRing, StageBadge, TagList, formatCompact, formatPercent } from "@/components/ui";
import { loadApplicationData } from "@/lib/view-data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Trends" };

export default async function TrendsPage({ searchParams }: { searchParams: Promise<{ stage?: string; sort?: string }> }) {
  const filters = await searchParams;
  const { trends } = await loadApplicationData();
  const rows = trends
    .filter((trend) => !filters.stage || trend.stage === filters.stage)
    .sort((a, b) => filters.sort === "growth" ? b.metrics.combinedGrowth72h - a.metrics.combinedGrowth72h : filters.sort === "saturation" ? b.saturationScore - a.saturationScore : filters.sort === "trend" ? b.trendScore - a.trendScore : b.opportunityScore - a.opportunityScore);
  return <div className="content"><PageHeading eyebrow="Propagation map" title="Trends" subtitle="A trend becomes credible when several games from independent creators grow together. Saturation rises when new supply arrives faster than player demand." />
    <div className="card table-shell"><form className="filters" method="get"><div className="field"><label htmlFor="stage">Stage</label><select className="select" id="stage" name="stage" defaultValue={filters.stage || ""}><option value="">All stages</option><option value="spark">Spark</option><option value="emerging">Emerging</option><option value="expanding">Expanding</option><option value="copy_wave">Copy wave</option><option value="saturated">Saturated</option><option value="declining">Declining</option></select></div><div className="field"><label htmlFor="sort">Sort by</label><select className="select" id="sort" name="sort" defaultValue={filters.sort || "opportunity"}><option value="opportunity">Opportunity</option><option value="trend">Trend strength</option><option value="growth">72h growth</option><option value="saturation">Saturation</option></select></div><div className="field" style={{ alignSelf: "end" }}><button className="button primary">Apply filters</button></div></form><div className="table-scroll"><table><thead><tr><th>Format / combination</th><th>Stage</th><th>Trend</th><th>Opportunity</th><th>Saturation</th><th>Combined CCU</th><th>72h growth</th><th>Games</th><th>Creators</th></tr></thead><tbody>{rows.map((trend) => <tr key={trend.id}><td><Link href={`/trends/${trend.id}`}><strong>{trend.label}</strong><div style={{ marginTop: 7 }}><TagList tags={trend.tags} limit={3} /></div></Link></td><td><StageBadge stage={trend.stage} /></td><td><ScoreRing score={trend.trendScore} color="var(--blue)" /></td><td><ScoreRing score={trend.opportunityScore} color="var(--purple)" /></td><td><strong className={trend.saturationScore >= 70 ? "negative" : trend.saturationScore >= 45 ? "warning" : "positive"}>{trend.saturationScore}%</strong></td><td>{formatCompact(trend.metrics.combinedCcu)}</td><td className={trend.metrics.combinedGrowth72h >= 0 ? "positive" : "negative"}>{formatPercent(trend.metrics.combinedGrowth72h)}</td><td>{trend.metrics.gameCount}</td><td>{trend.metrics.creatorCount}</td></tr>)}</tbody></table></div></div>
    <p className="trend-meta" style={{ marginTop: 12 }}>{rows.length} active signals. Single-game signals remain in Spark until propagation is visible.</p>
  </div>;
}
