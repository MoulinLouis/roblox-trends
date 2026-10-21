import { sql } from "drizzle-orm";
import { chunk } from "@/lib/arrays";
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
  const unique = mergeByKey(records).sort(compareKeys);
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

// Duplicates of one key are merged into the widest seen window, like the upsert does across calls.
function mergeByKey(records: DiscoveryRecord[]): DiscoveryRecord[] {
  const merged = new Map<string, DiscoveryRecord>();
  for (const record of records) {
    const key = `${record.universeId}:${record.source}:${record.detail}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? {
            ...existing,
            firstSeenAt: record.firstSeenAt < existing.firstSeenAt ? record.firstSeenAt : existing.firstSeenAt,
            lastSeenAt: record.lastSeenAt > existing.lastSeenAt ? record.lastSeenAt : existing.lastSeenAt,
          }
        : record,
    );
  }
  return [...merged.values()];
}

function compareKeys(left: DiscoveryRecord, right: DiscoveryRecord): number {
  return left.universeId - right.universeId || compareText(left.source, right.source) || compareText(left.detail, right.detail);
}

// Code-unit order: any fixed order prevents deadlocks, and it does not depend on the runtime locale.
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
