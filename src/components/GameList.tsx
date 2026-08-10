import Link from "next/link";
import type { GameDatasetItem } from "@/db/repository";
import { buildIdeaGameEvidence } from "@/lib/idea-evidence";
import { formatCompact, formatPercent, GameThumbnail, ScoreRing, Sparkline, TagList } from "./ui";

export function GameList({ items, compact = false }: { items: GameDatasetItem[]; compact?: boolean }) {
  if (!items.length) return <div className="empty">No games match this signal yet.</div>;
  if (compact) {
    return <div className="list">{items.map((item) => { const evidence = buildIdeaGameEvidence(item); const metrics = item.analysis?.metrics; return <Link className="list-row" href={`/games/${item.game.universeId}`} key={item.game.universeId}><div className="game-cell"><GameThumbnail name={item.game.normalizedTitle} url={item.game.thumbnailUrl} /><div><strong>{item.game.normalizedTitle}</strong><span>{item.game.creatorName} · {formatCompact(item.snapshots.at(-1)?.ccu ?? 0)} CCU</span>{evidence?.algorithmProof ? <span className="algorithm-badge">Discovery breakout · durability {evidence.durabilityStatus} ({evidence.durabilityConfidence}/100)</span> : null}</div></div><div style={{ textAlign: "right" }}><strong className={(metrics?.durableGrowth ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(metrics?.durableGrowth ?? 0)}</strong><span className="trend-meta">{signalWindow(metrics?.durableWindowHours ?? 0)}</span></div></Link>;})}</div>;
  }
  return <div className="table-scroll"><table><thead><tr><th>Game</th><th>CCU</th><th>Sustained growth</th><th>Average gain</th><th>Age</th><th>Rank</th><th>Momentum</th><th>Tags</th><th>History</th></tr></thead><tbody>{items.map((item) => { const point = item.snapshots.at(-1); const metrics = item.analysis?.metrics; const evidence = buildIdeaGameEvidence(item); return <tr key={item.game.universeId}><td><Link className="game-cell" href={`/games/${item.game.universeId}`}><GameThumbnail name={item.game.normalizedTitle} url={item.game.thumbnailUrl} /><div><strong>{item.game.normalizedTitle}</strong><span>{item.game.creatorName}</span>{evidence?.algorithmProof ? <span className="algorithm-badge">Discovery · durability {evidence.durabilityStatus} {evidence.durabilityConfidence}/100</span> : null}</div></Link></td><td><strong>{formatCompact(point?.ccu ?? 0)}</strong></td><td className={(metrics?.durableGrowth ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(metrics?.durableGrowth ?? 0)} <span className="trend-meta">{signalWindow(metrics?.durableWindowHours ?? 0)}</span></td><td>{(metrics?.durableGain ?? 0) > 0 ? "+" : ""}{formatCompact(metrics?.durableGain ?? 0)}</td><td>{Math.round(metrics?.ageDays ?? 0)}d</td><td>{point?.rank ? `#${point.rank}` : "—"}</td><td><ScoreRing score={item.analysis?.momentumScore ?? 0} /></td><td><TagList tags={item.tags} limit={3} /></td><td><Sparkline points={item.snapshots.slice(-24).map((snapshot) => snapshot.ccu)} /></td></tr>; })}</tbody></table></div>;
}

function signalWindow(hours: number): string {
  if (hours >= 168) return "7d average";
  if (hours >= 72) return "72h average";
  if (hours >= 24) return "24h average";
  return `${Math.max(1, Math.round(hours))}h discovery`;
}
