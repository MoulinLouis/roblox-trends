import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, formatCompact, formatDate, GameThumbnail, MetricCard, PageHeading, ScoreRing, TagList } from "@/components/ui";
import { buildRisingGameClusters } from "@/lib/rising-game-clusters";
import { RISING_GAMES_CONFIG } from "@/lib/config";
import { loadApplicationData } from "@/lib/view-data";
import type { RisingGameSignalType } from "@/lib/rising-game-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rising Games" };

interface SearchParams {
  type?: string;
  tier?: string;
  minCcu?: string;
}

export default async function RisingGamesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = await searchParams;
  const { dataset, risingSignals } = await loadApplicationData();
  const gamesByUniverse = new Map(dataset.map((item) => [item.game.universeId, item]));
  const minCcu = Number(filters.minCcu || 0) || 0;
  const signals = risingSignals.filter((signal) =>
    (!filters.type || signal.signalType === filters.type) &&
    (!filters.tier || signal.tier === filters.tier) &&
    signal.currentCcu >= minCcu,
  );
  const clusters = buildRisingGameClusters(risingSignals, dataset).slice(0, 8);
  const launchCount = risingSignals.filter((signal) => signal.signalType === "launch_breakout").length;
  const resurgenceCount = risingSignals.filter((signal) => signal.signalType === "resurgence").length;
  const explosiveCount = risingSignals.filter((signal) => signal.tier === "explosive").length;

  return <div className="content">
    <PageHeading eyebrow="Early demand radar" title="Rising games" subtitle="Launch breakouts find new games accelerating through meaningful CCU levels. Resurgences find older games moving far above their own recent baseline or setting a new tracked high." />
    <div className="grid grid-4">
      <MetricCard label="Active signals" value={String(risingSignals.length)} detail="Re-evaluated after every collection" />
      <MetricCard label="Launch breakouts" value={String(launchCount)} detail="Games created within 30 real days" tone="blue" />
      <MetricCard label="Resurgences" value={String(resurgenceCount)} detail="Older games breaking their baseline" tone="purple" />
      <MetricCard label="Explosive" value={String(explosiveCount)} detail="Highest confidence-adjusted velocity" tone="orange" />
    </div>

    <section className="section">
      <div className="section-heading"><h2>Hype clusters</h2><span className="trend-meta">Mechanics and themes shared by current movers</span></div>
      {clusters.length ? <div className="grid grid-4">{clusters.map((cluster) => <div className="card cluster-card" key={`${cluster.dimension}:${cluster.tag}`}><div><span className="badge cluster-dimension">{cluster.dimension}</span><h3>{cluster.tag}</h3></div><strong>{cluster.gameCount} {cluster.gameCount === 1 ? "game" : "games"}</strong><span>{formatCompact(cluster.totalCcu)} combined CCU · score {cluster.averageScore}</span><span>{cluster.launchBreakouts} launch · {cluster.resurgences} resurgence</span></div>)}</div> : <EmptyState>Clusters will appear as rising games share classified mechanics, progression, rewards, social hooks, or themes.</EmptyState>}
    </section>

    <section className="section">
      <div className="section-heading"><h2>Qualified signals</h2><span className="trend-meta">Absolute scale + relative acceleration + milestone evidence</span></div>
      <div className="card table-shell">
        <form className="filters rising-filters" method="get">
          <div className="field"><label htmlFor="type">Signal type</label><select className="select" id="type" name="type" defaultValue={filters.type || ""}><option value="">All signals</option><option value="launch_breakout">Launch breakout</option><option value="resurgence">Resurgence</option></select></div>
          <div className="field"><label htmlFor="tier">Strength</label><select className="select" id="tier" name="tier" defaultValue={filters.tier || ""}><option value="">All tiers</option><option value="explosive">Explosive</option><option value="surging">Surging</option><option value="rising">Rising</option></select></div>
          <div className="field"><label htmlFor="minCcu">Minimum CCU</label><input className="input" id="minCcu" name="minCcu" type="number" min="0" placeholder="1,000" defaultValue={filters.minCcu} /></div>
          <div className="field" style={{ alignSelf: "end" }}><button className="button primary" type="submit">Apply filters</button></div>
        </form>
        {signals.length ? <div className="table-scroll"><table><thead><tr><th>Game</th><th>Signal</th><th>Score</th><th>Current CCU</th><th>Strongest move</th><th>Why now</th><th>Confidence</th></tr></thead><tbody>{signals.map((signal) => {
          const item = gamesByUniverse.get(signal.universeId);
          if (!item) return null;
          const window = signal.metrics.strongestWindow;
          return <tr key={`${signal.universeId}:${signal.signalType}`}><td><Link className="game-cell" href={`/games/${signal.universeId}`}><GameThumbnail name={item.game.name} url={item.game.thumbnailUrl} /><div><strong>{item.game.name}</strong><span className="table-subline">Created {formatDate(item.game.createdAt)} · {Math.round(signal.metrics.ageDays)}d old</span><TagList tags={item.tags} limit={2} /></div></Link></td><td><span className={`badge signal-${signal.signalType}`}>{signalLabel(signal.signalType, signal.metrics.ageDays)}</span><span className={`signal-tier ${signal.tier}`}>{signal.tier}</span></td><td><ScoreRing score={signal.score} /></td><td><strong>{formatCompact(signal.currentCcu)}</strong>{signal.metrics.crossedMilestone ? <span className="algorithm-badge">Crossed {formatCompact(signal.metrics.crossedMilestone)}</span> : null}</td><td>{window ? <><strong className="positive">+{formatCompact(window.gain)}</strong><span className="table-subline">+{Math.round(window.growthPercent)}% in {window.actualHours}h</span></> : <span>Early discovery</span>}</td><td><span className="signal-reason">{signal.reasons[0]}</span>{signal.risks[0] ? <span className="table-subline warning">{signal.risks[0]}</span> : null}</td><td><span className="tag">{signal.confidence}</span>{signal.metrics.newHighSinceTracking ? <span className="algorithm-badge">New tracked high</span> : null}</td></tr>;
        })}</tbody></table></div> : <EmptyState>No active rising game matches these filters yet. The detector stays strict until both CCU scale and relative movement are credible.</EmptyState>}
      </div>
      <p className="trend-meta" style={{ marginTop: 12 }}>{signals.length} active signals shown. A signal is removed from this view when it no longer satisfies the live thresholds; its activation events remain idempotently recorded.</p>
    </section>
  </div>;
}

function signalLabel(type: RisingGameSignalType, ageDays: number): string {
  if (type === "resurgence") return "Resurgence";
  return ageDays <= RISING_GAMES_CONFIG.launchFreshAgeDays ? "Fresh launch" : "Launch breakout";
}
