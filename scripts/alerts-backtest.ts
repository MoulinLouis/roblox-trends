import { sql } from "drizzle-orm";
import { closeDatabaseWithin, getDatabase, type Database } from "@/db/client";
import { readBreakouts, readCardFacts, readGameFormats, readTrackedGames } from "@/db/alerts";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { replayAlerts } from "@/lib/alerts/backtest";
import { formatBacktestReport } from "@/lib/alerts/backtest-report";
import { trackedGameKeys } from "@/lib/alerts/keys";
import { ALERT_CONFIG, DATABASE_SESSION_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

// Replays the alerts job's decision over the radar's history so ALERT_CONFIG can be tuned (docs/operations.md). It
// reads through the analysis tunnel inside one read-only transaction that is always rolled back, and never writes.
const USAGE =
  "Usage: npm run alerts:backtest -- --from YYYY-MM-DD --to YYYY-MM-DD [--words-only] [--coverage-from YYYY-MM-DD]";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function parseDay(name: string, value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${name} needs a date like 2026-10-19`);
  return new Date(`${value}T00:00:00Z`);
}

function parseArguments(args: string[]) {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const from = parseDay("--from", value("--from"));
  // A `to` date covers that whole day, but the replay never runs past now.
  const to = new Date(Math.min(parseDay("--to", value("--to")).getTime() + DAY_MS, Date.now()));
  const coverageFrom = args.includes("--coverage-from") ? parseDay("--coverage-from", value("--coverage-from")) : new Date("2026-10-19T00:00:00Z");
  if (to.getTime() <= from.getTime()) throw new Error("--to must be after --from");
  return { from, to, coverageFrom, wordsOnly: args.includes("--words-only") };
}

class RollBack extends Error {}

let exitCode = 1;
try {
  const options = parseArguments(process.argv.slice(2));
  const database = getDatabase("radar-alerts-backtest", {
    statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs,
    lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs,
    settings: { default_transaction_read_only: "on" },
  });
  let report = "";
  try {
    await database.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await db.execute(sql`set transaction read only`);
      await assertNotLegacyDatabase(db);
      const tracked = await readTrackedGames(db);
      const formats = await readGameFormats(
        db,
        tracked.map((game) => game.universeId),
      );
      const keysOf = trackedGameKeys(tracked, formats, { wordsOnly: options.wordsOnly });
      const found = await readBreakouts(db, {
        createdSince: new Date(
          options.from.getTime() -
            (ALERT_CONFIG.lookbackDays + ALERT_CONFIG.maximumAgeDays) * DAY_MS -
            ALERT_CONFIG.candidateWindowHours * HOUR_MS,
        ),
        until: options.to,
      });
      const breakouts = found.map((breakout) => ({ ...breakout, keys: keysOf.get(breakout.universeId) ?? [], classified: true }));
      const result = replayAlerts({ breakouts, from: options.from, to: options.to });

      const ids = [
        ...new Set([
          ...result.pushes.flatMap((push) => [push.decision.universeId, ...Object.values(push.decision.priors).flat()]),
          ...result.digests.flatMap((digest) => digest.decisions.map((decision) => decision.universeId)),
        ]),
      ];
      const crossedAt = new Map(breakouts.map((breakout) => [breakout.universeId, breakout.crossedAt]));
      const facts = await readCardFacts(db, ids, crossedAt);
      report = formatBacktestReport({
        result,
        ...options,
        trackedGames: tracked.length,
        breakouts: breakouts.length,
        names: new Map([...facts].map(([id, fact]) => [id, fact.name])),
        peaks: new Map([...facts].map(([id, fact]) => [id, fact.peakCcu])),
        crossedAt,
      });
      throw new RollBack();
    });
  } catch (error) {
    if (!(error instanceof RollBack)) throw error;
  }
  console.log(report);
  exitCode = 0;
} catch (error) {
  const message = errorMessage(error);
  logger.error("Alerts backtest failed", { error: message });
  if (/^--/.test(message)) console.error(USAGE);
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "alerts-backtest" });
process.exit(exitCode);
