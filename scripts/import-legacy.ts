import { Pool } from "pg";
import { closeDatabaseWithin, getDatabase } from "@/db/client";
import { normalizePostgresConnectionUrl } from "@/db/connection-url";
import { assertNotLegacyDatabase, assertSupportedPostgres } from "@/db/legacy-guard";
import { parseImportArguments, type ImportArguments } from "@/lib/legacy/arguments";
import { importLegacyHistory } from "@/lib/legacy/import";
import { errorMessage, logger } from "@/lib/logger";

// Copies the v1 history (LEGACY_DATABASE_URL, only read) into the v2 database (DATABASE_URL). Every step is idempotent
// and data collected by v2 always wins, so a failed run is resumed by running it again; --since=<the start of the
// failed window, as logged> skips the raw windows already imported.
let parsed: ImportArguments;
try {
  parsed = parseImportArguments(process.argv.slice(2));
} catch (error) {
  logger.error("Invalid arguments: the only option is --since=<date>", { error: errorMessage(error) });
  process.exit(2);
}
const legacyUrl = process.env.LEGACY_DATABASE_URL?.trim();
if (!legacyUrl) {
  logger.error("LEGACY_DATABASE_URL is required");
  process.exit(2);
}

const source = new Pool({
  connectionString: normalizePostgresConnectionUrl(legacyUrl),
  max: 2,
  connectionTimeoutMillis: 10_000,
  application_name: "radar-import-legacy",
});
source.on("error", (error) => logger.warn("Idle legacy PostgreSQL client error", { error: errorMessage(error) }));

let exitCode = 1;
try {
  // Every statement commits on its own and stays short (one window, one page or one aggregate refresh at a time).
  const target = getDatabase("radar-import-legacy", { statementTimeoutMs: 10 * 60_000, lockTimeoutMs: 30_000 });
  await assertNotLegacyDatabase(target);
  await assertSupportedPostgres(target);
  const stats = await importLegacyHistory(target, source, { since: parsed.since });
  logger.info("Legacy import completed", { ...stats });
  exitCode = 0;
} catch (error) {
  logger.error("Legacy import failed", { error: errorMessage(error) });
}

await source.end().catch((error: unknown) => logger.warn("Could not close the legacy database", { error: errorMessage(error) }));
await closeDatabaseWithin(5_000, { command: "import:legacy" });
process.exit(exitCode);
