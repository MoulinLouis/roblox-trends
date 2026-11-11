import {
  markAlertsSent,
  readBreakouts,
  readCardFacts,
  readGameFormats,
  readLastSentAt,
  readPastAlerts,
  readTrackedGames,
  readUnsentAlerts,
  recordAlerts,
} from "@/db/alerts";
import { decideAlerts } from "@/lib/alerts/decide";
import { digestDue } from "@/lib/alerts/digest-time";
import { alertEvidence, digestMessage, DiscordError, postDiscord, waveMessage, type AlertEvidence } from "@/lib/alerts/discord";
import { patternKeys, wordFrequencies } from "@/lib/alerts/keys";
import type { Breakout } from "@/lib/alerts/types";
import { ALERT_CONFIG, JOB_CONFIG } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { JobDefinition } from "./runner";

export interface AlertsDependencies {
  // Read inside the run: the URL is a secret that only the alerts unit loads, and it never reaches a log, stat or row.
  webhookUrl: () => string | undefined;
  post?: typeof postDiscord;
}

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

// Records the alerts the breakouts call for, then sends them: each wave on its own right away, the first breakouts in
// one digest once per local day. An alert is recorded before it is sent and marked sent after its post succeeded, so a
// failed post leaves it for the next run.
export function createAlertsJob(dependencies: AlertsDependencies): JobDefinition {
  const config = JOB_CONFIG.alerts;
  const post = dependencies.post ?? postDiscord;
  return {
    name: "alerts",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      // Keys of every tracked game: the count of games per key is the card's keyGames.
      const tracked = await readTrackedGames(db);
      const formats = await readGameFormats(
        db,
        tracked.map((game) => game.universeId),
      );
      const frequencies = wordFrequencies(tracked.map((game) => game.name));
      const keysOf = new Map<number, string[]>();
      const keyGames: Record<string, { tracked: number; recent: number }> = {};
      const recentSince = now.getTime() - ALERT_CONFIG.recentGamesDays * dayMs;
      for (const game of tracked) {
        const format = formats.get(game.universeId) ?? { name: game.name, family: null, template: null, coreAction: null };
        const keys = patternKeys(format, frequencies, tracked.length);
        keysOf.set(game.universeId, keys);
        const recent = game.robloxCreatedAt !== null && game.robloxCreatedAt.getTime() >= recentSince;
        for (const key of keys) {
          const entry = (keyGames[key] ??= { tracked: 0, recent: 0 });
          entry.tracked += 1;
          if (recent) entry.recent += 1;
        }
      }

      const found = await readBreakouts(db, {
        createdSince: new Date(now.getTime() - (ALERT_CONFIG.lookbackDays + ALERT_CONFIG.maximumAgeDays) * dayMs),
        until: now,
      });
      const breakouts: Breakout[] = found.map((breakout) => ({
        ...breakout,
        keys: keysOf.get(breakout.universeId) ?? [],
        classified: formats.get(breakout.universeId)?.classified ?? false,
      }));
      const pastAlerts = await readPastAlerts(
        db,
        new Date(now.getTime() - Math.max(ALERT_CONFIG.lookbackDays, ALERT_CONFIG.waveCooldownDays) * dayMs),
      );
      const decisions = decideAlerts({ breakouts, pastAlerts, now });

      if (decisions.length > 0) {
        const ids = [...new Set(decisions.flatMap((decision) => [decision.universeId, ...Object.values(decision.priors).flat()]))];
        const facts = await readCardFacts(db, ids, new Map(breakouts.map((breakout) => [breakout.universeId, breakout.crossedAt])));
        await recordAlerts(
          db,
          decisions.map((decision) => ({ decision, evidence: alertEvidence(decision, facts, keyGames), createdAt: now })),
        );
      }

      const unsent = await readUnsentAlerts(db);
      const webhookUrl = dependencies.webhookUrl();
      let sent = 0;
      let failedPosts = 0;
      if (webhookUrl) {
        const attempt = async (message: Parameters<typeof postDiscord>[1], alerts: typeof unsent): Promise<void> => {
          try {
            await post(webhookUrl, message);
          } catch (error) {
            failedPosts += 1;
            // The kind of failure only: DiscordError text never holds the URL, and nothing else is copied.
            logger.error("A Discord alert was not sent", { kind: error instanceof DiscordError ? "discord" : "unexpected", alerts: alerts.length });
            return;
          }
          await markAlertsSent(db, alerts.map((alert) => alert.id), now);
          sent += alerts.length;
        };
        for (const alert of unsent.filter((entry) => entry.kind === "wave")) {
          await attempt(waveMessage(alert.evidence as AlertEvidence), [alert]);
        }
        const firstBreakouts = unsent.filter((entry) => entry.kind === "first_breakout");
        if (firstBreakouts.length > 0 && digestDue(now, await readLastSentAt(db, "first_breakout"))) {
          await attempt(digestMessage(firstBreakouts.map((alert) => alert.evidence as AlertEvidence)), firstBreakouts);
        }
      }

      const unsentAtEnd = unsent.length - sent;
      return {
        // Without a webhook nothing can be sent: any unsent alert is degraded. With one, only a failed post is.
        status: (webhookUrl ? failedPosts > 0 : unsentAtEnd > 0) ? "degraded" : "success",
        stats: {
          candidates: breakouts.filter((breakout) => breakout.crossedAt.getTime() > now.getTime() - ALERT_CONFIG.candidateWindowHours * hourMs).length,
          // The decisions of this run; recordAlerts skips one already stored, which only a concurrent run could cause.
          firstBreakouts: decisions.filter((decision) => decision.kind === "first_breakout").length,
          waves: decisions.filter((decision) => decision.kind === "wave").length,
          sent,
          unsent: unsentAtEnd,
        },
      };
    },
  };
}
