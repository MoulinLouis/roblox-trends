import { getIdeas, getTrends, hasAlertEvent, loadGameDataset, recordAlertEvent } from "@/db/repository";
import type { AppSettings } from "./types";
import { formatNumber, formatSigned } from "./scoring";
import { logger } from "./logger";

interface ReportEvent {
  key: string;
  type: string;
  line: string;
  payload: Record<string, unknown>;
}

export async function sendDailyReport(settings: AppSettings): Promise<{ sent: boolean; events: number }> {
  const [dataset, trendRows, ideaRows] = await Promise.all([loadGameDataset(), getTrends(), getIdeas()]);
  const candidates: ReportEvent[] = [];
  for (const item of dataset) {
    const metrics = item.analysis?.metrics;
    if (!metrics || item.analysis!.momentumScore < settings.thresholds.breakoutMomentum) continue;
    candidates.push({
      key: `breakout:${item.game.universeId}`,
      type: "breakout",
      line: `${item.game.normalizedTitle} — ${formatNumber(metrics.gain24h)} players gained in 24h — created ${Math.round(metrics.ageDays)} days ago`,
      payload: { universeId: item.game.universeId, score: item.analysis!.momentumScore },
    });
  }
  for (const trend of trendRows) {
    if (["emerging", "expanding", "saturated"].includes(trend.stage)) {
      candidates.push({
        key: `trend-stage:${trend.id}:${trend.stage}`,
        type: trend.stage,
        line: `${trend.label} — ${trend.metrics.gameCount} games — ${formatNumber(trend.metrics.combinedCcu)} CCU — ${formatSigned(trend.metrics.combinedGrowth72h)}% over 72h`,
        payload: { trendId: trend.id, stage: trend.stage },
      });
    }
  }
  for (const trend of trendRows.slice(0, 3)) {
    candidates.push({
      key: `opportunity:${trend.id}:${Math.floor(trend.opportunityScore / 10)}`,
      type: "opportunity",
      line: `${trend.label} — opportunity ${trend.opportunityScore}/100 — saturation ${trend.saturationScore}/100`,
      payload: { trendId: trend.id, opportunityScore: trend.opportunityScore },
    });
  }
  const events: ReportEvent[] = [];
  for (const candidate of candidates) if (!(await hasAlertEvent(candidate.key))) events.push(candidate);
  const content = renderDiscordReport(events, ideaRows[0]?.workingTitle);
  const webhook = settings.discordWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) {
    logger.warn("Discord report skipped because no webhook is configured", { events: events.length });
    return { sent: false, events: events.length };
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}`);
  for (const event of events) await recordAlertEvent(event.key, event.type, event.payload);
  logger.info("Discord report sent", { events: events.length });
  return { sent: true, events: events.length };
}

export function renderDiscordReport(events: ReportEvent[], topIdea?: string): string {
  const sections: Array<[string, string[]]> = [
    ["BREAKOUTS", events.filter((event) => event.type === "breakout").map((event) => event.line)],
    ["EMERGING TRENDS", events.filter((event) => event.type === "emerging").map((event) => event.line)],
    ["EXPANSION", events.filter((event) => event.type === "expanding").map((event) => event.line)],
    ["SATURATION", events.filter((event) => event.type === "saturated").map((event) => event.line)],
    ["OPPORTUNITIES", events.filter((event) => event.type === "opportunity").map((event) => event.line)],
  ];
  const lines = ["**ROBLOX TREND RADAR**"];
  for (const [title, entries] of sections) {
    if (entries.length) lines.push(`\n**${title}**`, ...entries.slice(0, 5));
  }
  if (!events.length) lines.push("\nNo new qualifying events today.");
  if (topIdea) lines.push(`\n**IDEA LAB PICK**\n${topIdea}`);
  return lines.join("\n");
}
