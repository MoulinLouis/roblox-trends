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
  const unique = uniqueBy(records, (record) => `${record.universeId}:${record.source}:${record.detail}`);
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
