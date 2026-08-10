import { closeDatabase } from "@/db";
import { migrateDatabase } from "@/db/migrate";
import { generateAgentDecisionBrief } from "@/lib/agent-brief";
import { logger } from "@/lib/logger";

try {
  await migrateDatabase();
  const result = await generateAgentDecisionBrief();
  logger.info("Agent decision brief generated", {
    readiness: result.brief.decisionReadiness.level,
    games: result.brief.dataQuality.trackedGames,
    historyHours: result.brief.dataQuality.historyHours,
    markdownPath: result.markdownPath,
    jsonPath: result.jsonPath,
  });
} catch (error) {
  logger.error("Agent decision brief failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
