import { sql } from "drizzle-orm";
import { chunk, uniqueBy } from "@/lib/arrays";
import type { DiscoverySource } from "@/lib/jobs/types";
import type { Database } from "./client";
import { discoverySources } from "./schema";

export interface DiscoveryRecord {
  universeId: number;
  source: DiscoverySource;
  detail: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export async function recordDiscoveries(db: Database, records: DiscoveryRecord[]): Promise<number> {
  // Rows are locked in key order, so concurrent jobs recording the same discoveries cannot deadlock.
  const unique = uniqueBy(records, (record) => `${record.universeId}:${record.source}:${record.detail}`).sort(compareKeys);
  for (const part of chunk(unique, 1_000)) {
    await db
      .insert(discoverySources)
      .values(part)
      .onConflictDoUpdate({
        target: [discoverySources.universeId, discoverySources.source, discoverySources.detail],
        set: {
          firstSeenAt: sql`least(${discoverySources.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${discoverySources.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return unique.length;
}

function compareKeys(left: DiscoveryRecord, right: DiscoveryRecord): number {
  return left.universeId - right.universeId || compareText(left.source, right.source) || compareText(left.detail, right.detail);
}

// Code-unit order: any fixed order prevents deadlocks, and it does not depend on the runtime locale.
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
