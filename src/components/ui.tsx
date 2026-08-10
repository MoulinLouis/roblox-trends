import type { CSSProperties, ReactNode } from "react";
import { Clock3 } from "lucide-react";
import Image from "next/image";
import { STAGE_LABELS } from "@/lib/config";
import type { GameSnapshotPoint, TrendStage } from "@/lib/types";
import { InteractiveAreaChart } from "./InteractiveAreaChart";

export function StageBadge({ stage }: { stage: TrendStage }) {
  return <span className={`badge ${stage}`}>{STAGE_LABELS[stage]}</span>;
}

export function ScoreRing({ score, large = false, color }: { score: number; large?: boolean; color?: string }) {
  return <span className={`score-ring ${large ? "large" : ""}`} style={{ "--score": score, "--ring-color": color ?? "var(--accent)" } as CSSProperties}><span>{score}</span></span>;
}

export function TagList({ tags, limit }: { tags: Array<{ tag: string; dimension?: string }>; limit?: number }) {
  const visible = limit ? tags.slice(0, limit) : tags;
  return <div className="tags">{visible.map((tag) => <span className="tag" key={`${tag.dimension ?? "tag"}-${tag.tag}`}>{tag.tag}</span>)}{limit && tags.length > limit ? <span className="tag">+{tags.length - limit}</span> : null}</div>;
}

export function GameThumbnail({ name, url, large = false }: { name: string; url: string | null; large?: boolean }) {
  if (url) return <Image className={`thumbnail ${large ? "large" : ""}`} src={url} alt="" width={large ? 76 : 42} height={large ? 76 : 42} unoptimized />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <span className={`thumbnail ${large ? "large" : ""}`} aria-hidden="true">{initials}</span>;
}

export function Sparkline({ points, color = "var(--accent)", width = 110, height = 34 }: { points: number[]; color?: string; width?: number; height?: number }) {
  if (!points.length) return <span style={{ color: "var(--muted)" }}>No history</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * width;
    const y = height - 3 - ((point - min) / range) * (height - 6);
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Historical trend"><path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function AreaChart({ points, value, color = "var(--accent)", yAxisLabel }: { points: GameSnapshotPoint[]; value: keyof Pick<GameSnapshotPoint, "ccu" | "visits" | "favorites" | "rank">; color?: string; yAxisLabel?: string }) {
  const labels = {
    ccu: "Concurrent players",
    visits: "Total visits",
    favorites: "Total favorites",
    rank: "Chart rank",
  };
  const data = points.flatMap((point) => {
    const item = point[value];
    if (item === null || item === undefined || !Number.isFinite(Number(item))) return [];
    return [{ timestamp: point.collectedAt.toISOString(), value: Number(item) }];
  });
  if (!data.length) return <div className="empty">No history collected yet.</div>;
  const label = yAxisLabel ?? labels[value];
  return <InteractiveAreaChart data={data} color={color} valueLabel={label} yAxisLabel={label} rankIsBetter={value === "rank"} />;
}

export function MetricCard({ label, value, detail, tone = "accent" }: { label: string; value: string; detail: string; tone?: "accent" | "blue" | "purple" | "orange" }) {
  const colors = { accent: "rgba(132,240,193,.13)", blue: "rgba(108,165,255,.13)", purple: "rgba(178,140,255,.13)", orange: "rgba(255,173,102,.13)" };
  return <div className="card metric-card" style={{ "--glow": colors[tone] } as CSSProperties}><span className="metric-label">{label}</span><div className="metric-value">{value}</div><span className="metric-detail">{detail}</span></div>;
}

export function Freshness({ date, errors = 0 }: { date: Date | null; errors?: number }) {
  return <div className="status-cluster"><span className="status-chip"><span className="status-dot" />{date ? `Updated ${relativeTime(date)}` : "Waiting for first collection"}</span>{errors > 0 ? <span className="status-chip warning">{errors} source {errors === 1 ? "issue" : "issues"}</span> : null}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) { return <div className="card empty">{children}</div>; }

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
}

export function relativeTime(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (Math.abs(minutes) < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-subtitle">{subtitle}</p></div>{action}</div>;
}

export function CollectionIcon() { return <Clock3 size={13} />; }
