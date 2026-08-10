import Link from "next/link";
import type { TrendRow } from "@/db/repository";
import { formatCompact, formatPercent, ScoreRing, StageBadge, TagList } from "./ui";

export function TrendCard({ trend }: { trend: TrendRow }) {
  return <Link href={`/trends/${trend.id}`} className="card trend-card"><div className="trend-card-top"><div><StageBadge stage={trend.stage} /><h3>{trend.label}</h3><p className="trend-meta">{trend.metrics.creatorCount} independent creators · {Math.round(trend.metrics.growingShare)}% growing</p></div><ScoreRing score={trend.opportunityScore} color="var(--purple)" /></div><TagList tags={trend.tags} limit={4} /><div className="trend-numbers"><div className="trend-number"><strong>{formatCompact(trend.metrics.combinedCcu)}</strong><span>Combined CCU</span></div><div className="trend-number"><strong className={trend.metrics.combinedGrowth72h >= 0 ? "positive" : "negative"}>{formatPercent(trend.metrics.combinedGrowth72h)}</strong><span>72h growth</span></div><div className="trend-number"><strong>{trend.metrics.gameCount}</strong><span>Games</span></div></div></Link>;
}
