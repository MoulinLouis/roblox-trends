import type { Metadata } from "next";
import { GameList } from "@/components/GameList";
import { EmptyState, PageHeading } from "@/components/ui";
import { buildIdeaGameEvidence, type IdeaGameEvidence } from "@/lib/idea-evidence";
import { loadApplicationData } from "@/lib/view-data";
import type { TrendStage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Games" };

interface SearchParams {
  minAge?: string;
  maxAge?: string;
  minCcu?: string;
  minGrowth?: string;
  tag?: string;
  stage?: string;
  sort?: string;
  proof?: string;
}

export default async function GamesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = await searchParams;
  const { dataset, stagesByGame } = await loadApplicationData();
  const tags = [...new Set(dataset.flatMap((item) => item.tags.map((tag) => tag.tag)))].sort();
  const minAge = numberOr(filters.minAge, 0);
  const maxAge = numberOr(filters.maxAge, Number.POSITIVE_INFINITY);
  const minCcu = numberOr(filters.minCcu, 0);
  const minGrowth = numberOr(filters.minGrowth, Number.NEGATIVE_INFINITY);
  const evidenceByGame = new Map(
    dataset.map((item) => [item.game.universeId, buildIdeaGameEvidence(item)]),
  );
  const items = dataset
    .filter((item) => {
      const age = item.analysis?.metrics.ageDays ?? 0;
      const ccu = item.snapshots.at(-1)?.ccu ?? 0;
      const growth = item.analysis?.metrics.growth24h ?? 0;
      const gameStages = stagesByGame.get(item.game.universeId) ?? new Set<TrendStage>();
      return age >= minAge && age <= maxAge && ccu >= minCcu && growth >= minGrowth && (!filters.tag || item.tags.some((tag) => tag.tag === filters.tag)) && (!filters.stage || gameStages.has(filters.stage as TrendStage)) && (!filters.proof || evidenceByGame.get(item.game.universeId)?.algorithmProof === true);
    })
    .sort((a, b) => compareGames(a, b, filters.sort || "momentum", evidenceByGame));

  return <div className="content"><PageHeading eyebrow="Growth explorer" title="Games" subtitle="Filter the market by freshness and real growth signals. A large established game does not rank highly unless its current trajectory deserves attention." />
    <div className="card table-shell"><form className="filters" method="get"><div className="field"><label htmlFor="minAge">Minimum age</label><input className="input" id="minAge" name="minAge" type="number" min="0" placeholder="0 days" defaultValue={filters.minAge} /></div><div className="field"><label htmlFor="maxAge">Maximum age</label><input className="input" id="maxAge" name="maxAge" type="number" min="0" placeholder="Any age" defaultValue={filters.maxAge} /></div><div className="field"><label htmlFor="minCcu">Minimum CCU</label><input className="input" id="minCcu" name="minCcu" type="number" min="0" placeholder="Any CCU" defaultValue={filters.minCcu} /></div><div className="field"><label htmlFor="minGrowth">Minimum 24h growth</label><input className="input" id="minGrowth" name="minGrowth" type="number" placeholder="Any growth" defaultValue={filters.minGrowth} /></div><div className="field"><label htmlFor="tag">Tag</label><select className="select" id="tag" name="tag" defaultValue={filters.tag || ""}><option value="">All tags</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></div><div className="field"><label htmlFor="stage">Trend stage</label><select className="select" id="stage" name="stage" defaultValue={filters.stage || ""}><option value="">All stages</option><option value="spark">Spark</option><option value="emerging">Emerging</option><option value="expanding">Expanding</option><option value="copy_wave">Copy wave</option><option value="saturated">Saturated</option><option value="declining">Declining</option></select></div><div className="field"><label htmlFor="proof">Discovery evidence</label><select className="select" id="proof" name="proof" defaultValue={filters.proof || ""}><option value="">All games</option><option value="1">Recent algorithm breakouts</option></select></div><div className="field wide-mobile"><label htmlFor="sort">Sort by</label><select className="select" id="sort" name="sort" defaultValue={filters.sort || "momentum"}><option value="algorithm">Algorithm evidence</option><option value="momentum">Momentum</option><option value="growth">24h growth</option><option value="gain">Absolute gain</option><option value="ccu">Current CCU</option><option value="age">Newest</option><option value="rank">Chart rank</option></select></div><div className="field" style={{ alignSelf: "end" }}><button className="button primary" type="submit">Apply filters</button></div></form>{items.length ? <GameList items={items} /> : <EmptyState>No games match these filters. Try widening the age or growth range.</EmptyState>}</div>
    <p className="trend-meta" style={{ marginTop: 12 }}>{items.length} of {dataset.length} games shown. Growth is suppressed when the baseline and absolute gain are both too small.</p>
  </div>;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareGames(a: Awaited<ReturnType<typeof loadApplicationData>>["dataset"][number], b: Awaited<ReturnType<typeof loadApplicationData>>["dataset"][number], sort: string, evidenceByGame: Map<string, IdeaGameEvidence | null>): number {
  const aMetrics = a.analysis?.metrics;
  const bMetrics = b.analysis?.metrics;
  if (sort === "growth") return (bMetrics?.growth24h ?? 0) - (aMetrics?.growth24h ?? 0);
  if (sort === "gain") return (bMetrics?.gain24h ?? 0) - (aMetrics?.gain24h ?? 0);
  if (sort === "ccu") return (b.snapshots.at(-1)?.ccu ?? 0) - (a.snapshots.at(-1)?.ccu ?? 0);
  if (sort === "age") return (aMetrics?.ageDays ?? 0) - (bMetrics?.ageDays ?? 0);
  if (sort === "rank") return (a.snapshots.at(-1)?.rank ?? 9999) - (b.snapshots.at(-1)?.rank ?? 9999);
  if (sort === "algorithm") return (evidenceByGame.get(b.game.universeId)?.evidenceScore ?? 0) - (evidenceByGame.get(a.game.universeId)?.evidenceScore ?? 0);
  return (b.analysis?.momentumScore ?? 0) - (a.analysis?.momentumScore ?? 0);
}
