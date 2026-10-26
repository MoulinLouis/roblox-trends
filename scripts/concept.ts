import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { readConceptHistory } from "@/db/concept";
import { assertNotLegacyDatabase } from "@/db/legacy-guard";
import { RobloxClient } from "@/lib/api/roblox";
import { runConceptCheck, type ConceptCheckDependencies } from "@/lib/concept/check";
import { formatConceptReport } from "@/lib/concept/report";
import { DATABASE_SESSION_CONFIG, ROBLOX_REGION } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";

// Every Roblox attempt at a concept, for analysis sessions (docs/operations.md). It searches Roblox from the machine
// it runs on, so it never runs on the server, whose search allowance belongs to explore. It reads the radar's history
// when DATABASE_URL points to it (the analysis tunnel), in a read-only session, and never writes.
const args = process.argv.slice(2);
const json = args.includes("--json");
const phrases = args
  .filter((arg) => arg !== "--json")
  .map((arg) => arg.trim())
  .filter(Boolean);

let exitCode = 1;
if (!phrases.length) {
  console.error('Usage: npm run concept -- [--json] "<phrase>" ["<phrase>" ...]');
} else {
  try {
    const dependencies: ConceptCheckDependencies = {
      api: new RobloxClient(ROBLOX_REGION.country, ROBLOX_REGION.device),
      now: new Date(),
    };
    if (process.env.DATABASE_URL?.trim()) {
      const database = getDatabase("radar-concept", {
        statementTimeoutMs: DATABASE_SESSION_CONFIG.statusStatementTimeoutMs,
        lockTimeoutMs: DATABASE_SESSION_CONFIG.statusLockTimeoutMs,
        settings: { default_transaction_read_only: "on" },
      });
      // Inside the reader, so an unreachable database leaves the report without history instead of failing it.
      dependencies.readHistory = async (universeIds, since) => {
        await assertNotLegacyDatabase(database);
        return readConceptHistory(database, universeIds, since);
      };
    } else {
      dependencies.historySkippedReason = "DATABASE_URL is not set";
    }
    const report = await runConceptCheck(phrases, dependencies);
    console.log(json ? JSON.stringify(report, null, 2) : formatConceptReport(report));
    exitCode = report.failures.length === phrases.length ? 1 : 0;
  } catch (error) {
    logger.error("Concept check failed", { error: errorMessage(error) });
  }
}

await closeDatabaseWithin(DATABASE_SESSION_CONFIG.closeTimeoutMs, { command: "concept" });
process.exit(exitCode);
