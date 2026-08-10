import { AlertTriangle, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { GameList } from "@/components/GameList";
import { TrendCard } from "@/components/TrendCard";
import { Freshness, formatCompact, MetricCard, PageHeading } from "@/components/ui";
import { buildIdeaGameEvidence } from "@/lib/idea-evidence";
import { latestCollectionTime, loadApplicationData } from "@/lib/view-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { dataset, trends, ideas, sourceRuns } = await loadApplicationData();
  const latest = latestCollectionTime(dataset);
  const errors = sourceRuns.filter((run) => run.status === "error" || run.status === "partial");
  const evidenceByGame = new Map(
    dataset.map((item) => [item.game.universeId, buildIdeaGameEvidence(item)]),
  );
  const breakouts = dataset
    .filter((item) => evidenceByGame.get(item.game.universeId)?.algorithmProof)
    .sort(
      (a, b) =>
        (evidenceByGame.get(b.game.universeId)?.evidenceScore ?? 0) -
        (evidenceByGame.get(a.game.universeId)?.evidenceScore ?? 0),
    );
  const emerging = trends.filter((trend) => trend.stage === "emerging" || trend.stage === "spark").slice(0, 3);
  const expanding = trends.filter((trend) => trend.stage === "expanding" || trend.stage === "copy_wave").slice(0, 3);
  const saturated = trends.filter((trend) => trend.stage === "saturated").slice(0, 3);
  const opportunities = [...trends].sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 4);
  const combinedCcu = dataset.reduce((sum, item) => sum + (item.snapshots.at(-1)?.ccu ?? 0), 0);

  return <div className="content"><PageHeading eyebrow="Daily command center" title="Catch the wave before the clones" subtitle="Momentum combines growth velocity, acceleration, real player gains, chart movement, persistence, and freshness—not just raw popularity." action={<Freshness date={latest} errors={errors.length} />} />
    <div className="grid grid-4">
      <MetricCard label="Tracked demand" value={formatCompact(combinedCcu)} detail={`Across ${dataset.length} monitored games`} />
      <MetricCard label="Discovery breakouts" value={String(breakouts.length)} detail="24h evidence; durability requires 72h" tone="blue" />
      <MetricCard label="Expanding signals" value={String(expanding.length)} detail="Multi-creator growth" tone="purple" />
      <MetricCard label="Saturated formats" value={String(saturated.length)} detail="Supply is outpacing demand" tone="orange" />
    </div>

    <section className="section"><div className="section-heading"><h2>Highest-scoring opportunities</h2><Link href="/trends">Explore all trends <ArrowUpRight size={12} /></Link></div><div className="grid grid-4">{opportunities.map((trend) => <TrendCard trend={trend} key={trend.id} />)}</div></section>

    <div className="dashboard-layout section"><div><div className="section-heading"><h2>Recent discovery breakouts</h2><Link href="/games?proof=1&sort=algorithm">Inspect durability</Link></div><div className="card table-shell"><GameList items={breakouts.slice(0, 7)} compact /></div></div><div><div className="section-heading"><h2>Source health</h2><span className="trend-meta">Last 12 runs</span></div><div className="card card-pad">{errors.length ? <div className="list">{errors.slice(0, 4).map((run) => <div className="alert" key={`${run.runKey}-${run.source}`}><AlertTriangle size={16} /><div><strong>{run.source}</strong><br />{run.error || "Partial source response"}</div></div>)}</div> : <div className="empty">All recent sources completed successfully.</div>}<div className="list" style={{ marginTop: 10 }}>{sourceRuns.filter((run) => run.status === "success").slice(0, 3).map((run) => <div className="list-row" key={`${run.runKey}-${run.source}`}><div className="list-row-main"><strong>{run.source}</strong><span>{run.items} records · healthy</span></div><span className="positive">●</span></div>)}</div></div></div></div>

    <section className="section"><div className="section-heading"><h2>Emerging trends</h2><Link href="/trends?stage=emerging">See stage</Link></div><div className="grid grid-3">{emerging.map((trend) => <TrendCard trend={trend} key={trend.id} />)}</div></section>
    <section className="section"><div className="section-heading"><h2>Expansion and copy waves</h2><span className="trend-meta">Credibility rises with independent creators</span></div><div className="grid grid-3">{expanding.map((trend) => <TrendCard trend={trend} key={trend.id} />)}</div></section>
    <section className="section"><div className="section-heading"><h2>Saturation watch</h2><span className="trend-meta">New supply without matching demand</span></div><div className="grid grid-3">{saturated.map((trend) => <TrendCard trend={trend} key={trend.id} />)}</div></section>

    {ideas[0] ? <section className="section"><div className="card card-pad"><p className="eyebrow">Idea Lab pick</p><div className="page-heading" style={{ marginBottom: 0 }}><div><h2>{ideas[0].workingTitle}</h2><p className="page-subtitle">{ideas[0].pitch}</p></div><Link className="button primary" href="/ideas">Open concept</Link></div></div></section> : null}
  </div>;
}
