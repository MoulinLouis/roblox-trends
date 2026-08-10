import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { normalizePostgresConnectionUrl } from "../src/db/connection-url";
import { logger } from "@/lib/logger";

type DatabaseRow = Record<string, unknown>;

interface TableTransfer {
  table: string;
  columns: string[];
  conflictClause: string;
}

const TABLE_TRANSFERS: TableTransfer[] = [
  {
    table: "games",
    columns: [
      "universe_id",
      "root_place_id",
      "name",
      "normalized_title",
      "description",
      "creator_id",
      "creator_name",
      "creator_type",
      "created_at",
      "updated_at",
      "first_seen_at",
      "last_seen_at",
      "thumbnail_url",
      "genre",
    ],
    conflictClause: `ON CONFLICT (universe_id) DO UPDATE SET
      first_seen_at = LEAST(games.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(games.last_seen_at, EXCLUDED.last_seen_at)`,
  },
  {
    table: "game_tags",
    columns: ["universe_id", "dimension", "tag", "source", "created_at"],
    conflictClause: "ON CONFLICT (universe_id, dimension, tag) DO NOTHING",
  },
  {
    table: "snapshots",
    columns: [
      "universe_id",
      "collected_at",
      "bucket_at",
      "ccu",
      "visits",
      "favorites",
      "chart",
      "rank",
      "source",
    ],
    conflictClause: "ON CONFLICT (universe_id, bucket_at, source, chart) DO NOTHING",
  },
  {
    table: "daily_snapshots",
    columns: [
      "universe_id",
      "day_at",
      "average_ccu",
      "peak_ccu",
      "visits",
      "favorites",
      "best_rank",
    ],
    conflictClause: "ON CONFLICT (universe_id, day_at) DO NOTHING",
  },
  {
    table: "source_runs",
    columns: [
      "run_key",
      "job",
      "source",
      "status",
      "items",
      "error",
      "started_at",
      "finished_at",
    ],
    conflictClause: "ON CONFLICT (run_key, source) DO NOTHING",
  },
];

const BATCH_SIZE = 200;

async function readRows(source: PGlite, transfer: TableTransfer): Promise<DatabaseRow[]> {
  const columns = transfer.columns.map(quoteIdentifier).join(", ");
  const result = await source.query<DatabaseRow>(
    `SELECT ${columns} FROM ${quoteIdentifier(transfer.table)}`,
  );
  return result.rows;
}

async function transferRows(
  client: PoolClient,
  transfer: TableTransfer,
  rows: DatabaseRow[],
): Promise<number> {
  let affectedRows = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = transfer.columns.map((column) => {
        values.push(row[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await client.query(
      `INSERT INTO ${quoteIdentifier(transfer.table)} (${transfer.columns.map(quoteIdentifier).join(", ")})
       VALUES ${tuples.join(", ")}
       ${transfer.conflictClause}`,
      values,
    );
    affectedRows += result.rowCount ?? 0;
  }
  return affectedRows;
}

async function databaseSummary(client: PoolClient): Promise<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  for (const table of TABLE_TRANSFERS.map((transfer) => transfer.table)) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  const history = await client.query<{
    earliest: Date | null;
    latest: Date | null;
    snapshot_points: string;
  }>(`SELECT
        min(bucket_at) AS earliest,
        max(bucket_at) AS latest,
        count(DISTINCT (universe_id, bucket_at))::text AS snapshot_points
      FROM snapshots`);
  const row = history.rows[0];
  return {
    ...counts,
    usableSnapshotPoints: Number(row?.snapshot_points ?? 0),
    earliestSnapshotAt: row?.earliest?.toISOString() ?? null,
    latestSnapshotAt: row?.latest?.toISOString() ?? null,
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_]+$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl?.startsWith("postgresql://")) {
  throw new Error("DATABASE_URL must contain the target PostgreSQL connection string.");
}

const sourceDirectory = resolve(process.env.PGLITE_DATA_DIR?.trim() || ".data/roblox-trends");
await access(sourceDirectory);

const source = new PGlite(sourceDirectory);
const target = new Pool({ connectionString: normalizePostgresConnectionUrl(databaseUrl), max: 2 });
const client = await target.connect();

try {
  const sourceRows = new Map<string, DatabaseRow[]>();
  for (const transfer of TABLE_TRANSFERS) {
    sourceRows.set(transfer.table, await readRows(source, transfer));
  }

  const before = await databaseSummary(client);
  const affected: Record<string, number> = {};
  await client.query("BEGIN");
  try {
    for (const transfer of TABLE_TRANSFERS) {
      affected[transfer.table] = await transferRows(
        client,
        transfer,
        sourceRows.get(transfer.table) ?? [],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const after = await databaseSummary(client);
  logger.info("Local live history import completed", {
    sourceDirectory,
    sourceRows: Object.fromEntries(
      [...sourceRows.entries()].map(([table, rows]) => [table, rows.length]),
    ),
    affected,
    before,
    after,
  });
} catch (error) {
  logger.error("Local live history import failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  client.release();
  await target.end();
  await source.close();
}
