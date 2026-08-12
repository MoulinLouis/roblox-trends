import {
  getPendingRisingGameEvents,
  loadGameDataset,
  markRisingGameEventsNotified,
} from "@/db/repository";
import { logger } from "./logger";
import { RISING_GAMES_CONFIG } from "./config";
import type { AppSettings } from "./types";

const HOUR = 60 * 60 * 1_000;

export async function sendPendingRisingGameAlerts(
  settings: AppSettings,
  now = new Date(),
): Promise<{ sent: boolean; events: number }> {
  const events = await getPendingRisingGameEvents(
    new Date(now.getTime() - RISING_GAMES_CONFIG.alerts.lookbackHours * HOUR),
    RISING_GAMES_CONFIG.alerts.minimumScore,
    RISING_GAMES_CONFIG.alerts.maximumEventsPerDelivery,
  );
  if (!events.length) return { sent: false, events: 0 };

  const webhook = settings.discordWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) {
    logger.info("Rising game alerts are ready but no Discord webhook is configured", {
      events: events.length,
    });
    return { sent: false, events: events.length };
  }

  const displayedEvents = events.slice(0, RISING_GAMES_CONFIG.alerts.maximumEntriesPerDelivery);
  const dataset = await loadGameDataset([...new Set(displayedEvents.map((event) => event.universeId))]);
  const gamesByUniverse = new Map(dataset.map((item) => [item.game.universeId, item.game]));
  const lines = ["**ROBLOX TREND RADAR — RISING GAMES**"];
  for (const event of displayedEvents) {
    const game = gamesByUniverse.get(event.universeId);
    if (!game) continue;
    const metrics = event.payload.metrics;
    const movement = metrics.strongestWindow
      ? `+${formatNumber(metrics.strongestWindow.gain)} CCU / +${Math.round(metrics.strongestWindow.growthPercent)}% in ${metrics.strongestWindow.actualHours}h`
      : "discovered at meaningful scale";
    const label = event.signalType === "launch_breakout" ? "LAUNCH" : "RESURGENCE";
    const trigger = event.eventType === "tier_up"
      ? `tier upgraded to ${event.tier}`
      : event.eventType === "milestone"
        ? `crossed ${formatNumber(metrics.crossedMilestone ?? event.currentCcu)} CCU`
        : `${event.tier} signal activated`;
    lines.push(
      "",
      `**${label} · ${event.score}/100 · ${formatNumber(event.currentCcu)} CCU**`,
      `[${game.name}](https://www.roblox.com/games/${game.rootPlaceId}) — ${trigger}`,
      `${movement}${metrics.newHighSinceTracking ? " · new tracked high" : ""}`,
      event.payload.reasons[0] ?? "Relative demand is accelerating.",
      ...(event.payload.risks[0] ? [`Caution: ${event.payload.risks[0]}`] : []),
    );
  }

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: lines.join("\n").slice(0, 2_000), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}`);
  await markRisingGameEventsNotified(events.map((event) => event.id), now);
  logger.info("Rising game alert digest sent", {
    displayed: displayedEvents.length,
    processed: events.length,
  });
  return { sent: true, events: displayedEvents.length };
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
