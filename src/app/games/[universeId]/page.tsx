import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GameIcon } from "@/components/GameIcon";
import { InteractiveAreaChart } from "@/components/InteractiveAreaChart";
import { MetricCard } from "@/components/MetricCard";
import { dashboardDatabase } from "@/db/dashboard";
import { readGameView } from "@/db/game-view";
import { GAME_VIEW_CONFIG } from "@/lib/config";
import { engagementSignals } from "@/lib/dashboard/engagement";
import { discoveryLabel } from "@/lib/dashboard/labels";
import { buildTimeline } from "@/lib/dashboard/timeline";
import { formatCount, formatDay, formatElapsed, formatHours, formatPercent, formatUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Game" };

// Canonical universe ids only, small enough to stay exact as numbers.
const universeIdPattern = /^[1-9]\d*$/;

export default async function GamePage({ params }: { params: Promise<{ universeId: string }> }) {
  await connection();
  const { universeId } = await params;
  if (!universeIdPattern.test(universeId) || !Number.isSafeInteger(Number(universeId))) notFound();
  const now = new Date();
  const view = await readGameView(dashboardDatabase(), Number(universeId), now);
  if (!view) notFound();
  const { game, discovery } = view;
  const signals = engagementSignals(view.engagement, view.votes, view.charts);
  const timeline = buildTimeline(view.versions, view.charts).slice(0, GAME_VIEW_CONFIG.timelineEntries);
  const peak = view.daily.length ? Math.max(...view.daily.map((day) => day.peak)) : null;
  return (
    <div className="content">
      <div className="detail-hero">
        <GameIcon url={game.iconUrl} name={game.name} size="large" />
        <div className="detail-hero-copy">
          <p className="eyebrow">Game</p>
          <h1>{game.name}</h1>
          <p className="page-subtitle">
            By {game.creatorName}{game.genre ? ` · ${game.genre}` : ""} · created {formatDay(game.robloxCreatedAt)}, {formatElapsed(game.robloxCreatedAt, now)} ago
          </p>
        </div>
        <div className="detail-actions">
          <a className="button" href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noreferrer"><ExternalLink size={14} />Roblox</a>
          <Link className="button" href="/">Radar</Link>
        </div>
      </div>

      <div className="grid grid-4">
        <MetricCard label="CCU now" value={formatCount(game.lastCcu)} detail={game.lastCcuAt ? `Polled ${formatElapsed(game.lastCcuAt, now)} ago` : "Never polled"} />
        <MetricCard label="Peak CCU" value={formatCount(peak)} detail="Highest daily peak since tracking" />
        <MetricCard
          label="Like ratio"
          value={formatPercent(signals.likeRatio)}
          detail={signals.upVotes === null ? "No votes recorded" : `${formatCount(signals.upVotes)} up · ${formatCount(signals.downVotes)} down`}
        />
        <MetricCard
          label="First seen by the radar"
          value={formatDay(game.firstObservedAt)}
          detail={discovery ? `Through ${discoveryLabel(discovery.source, discovery.detail)}` : "Before v2 recorded discoveries"}
        />
      </div>

      <section className="section card chart-card">
        <div className="chart-header"><h2>Last {GAME_VIEW_CONFIG.recentDays} days</h2><span>Every observation</span></div>
        {view.recent.length ? (
          <InteractiveAreaChart
            data={view.recent.map((point) => ({ timestamp: point.at.toISOString(), value: point.ccu }))}
            color="#84f0c1"
            valueLabel="CCU"
            yAxisLabel="CCU"
            xAxisLabel="Time (UTC)"
          />
        ) : <div className="empty">No observation in this window.</div>}
      </section>

      <section className="section card chart-card">
        <div className="chart-header"><h2>Daily peak</h2><span>Since the radar first tracked the game</span></div>
        {view.daily.length ? (
          <InteractiveAreaChart
            data={view.daily.map((day) => ({ timestamp: day.day.toISOString(), value: day.peak }))}
            color="#6ca5ff"
            valueLabel="CCU"
            yAxisLabel="Peak CCU"
            xAxisLabel="Day (UTC)"
          />
        ) : <div className="empty">No daily history yet.</div>}
      </section>

      <div className="section grid grid-2">
        <div className="card card-pad">
          <h2>Signals</h2>
          <div className="metadata">
            <Signal
              label="Session length"
              value={signals.sessionMinutes === null ? "—" : `${Math.round(signals.sessionMinutes)} min`}
              detail={
                signals.windowHours === null
                  ? `No observation in the last ${GAME_VIEW_CONFIG.engagementDays} days`
                  : `Average CCU × time / new visits over ${formatHours(signals.windowHours)} (${formatCount(signals.newVisits)} new visits); needs ${GAME_VIEW_CONFIG.engagementMinimumHours} h`
              }
            />
            <Signal
              label="Favorites per 1,000 new visits"
              value={signals.favoritesPerThousandVisits === null ? "—" : signals.favoritesPerThousandVisits.toFixed(1)}
              detail={`Over the same ${GAME_VIEW_CONFIG.engagementDays}-day window`}
            />
            <Signal
              label="Monetization"
              value={signals.earningRank === null ? "Not in Top Earning" : `Earning #${signals.earningRank} · Playing #${signals.playingRank ?? "—"}`}
              detail={`Best ranks over the last ${GAME_VIEW_CONFIG.chartBestRankHours} h: an earning rank above the playing rank means the game earns more than its popularity`}
            />
            <Signal
              label="Retention"
              value={signals.revisitedRank === null ? "Not in Top Revisited" : `Top Revisited #${signals.revisitedRank}`}
              detail={`${formatCount(signals.revisitedHours)} h in Top Revisited over ${GAME_VIEW_CONFIG.chartRecentDays} days`}
            />
          </div>
        </div>
        <div className="card card-pad">
          <h2>Timeline</h2>
          {timeline.length ? (
            <div className="list">
              {timeline.map((entry, index) => (
                <div className="list-row" key={`${entry.at.getTime()}-${index}`}>
                  <div className="list-row-main"><strong>{entry.label}</strong></div>
                  <span className="timeline-time">{formatUtc(entry.at)}</span>
                </div>
              ))}
            </div>
          ) : <div className="empty">No change recorded yet.</div>}
        </div>
      </div>
    </div>
  );
}

function Signal({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metadata-row">
      <span>{label}</span>
      <strong>{value}</strong>
      <em className="signal-detail">{detail}</em>
    </div>
  );
}
