import type { Database } from "@/db/client";
import { recordDiscoveries } from "@/db/discovery";
import { knownUniverseIds, upsertGameDetails } from "@/db/games";
import type { RobloxApi } from "@/lib/api/roblox";
import { errorMessage } from "@/lib/logger";
import type { DiscoverySource } from "./types";

// The Games API failed, so callers may carry on and promote later. Database errors are not wrapped: they still fail
// the run.
export class PromotionApiError extends Error {
  constructor(cause: unknown) {
    super(`Game details request failed: ${errorMessage(cause)}`, { cause });
    this.name = "PromotionApiError";
  }
}

export interface PromotionCandidate {
  universeId: number;
  source: DiscoverySource;
  detail: string;
}

// Adds unknown universes to the games table and records how they were found.
// With recordKnown, discoveries of already-tracked games are recorded too.
export async function promoteUniverses(
  db: Database,
  roblox: Pick<RobloxApi, "getGameDetails">,
  candidates: PromotionCandidate[],
  now: Date,
  options: { recordKnown?: boolean } = {},
): Promise<{ promoted: number; discoveries: number }> {
  if (!candidates.length) return { promoted: 0, discoveries: 0 };
  const universeIds = [...new Set(candidates.map((candidate) => candidate.universeId))];
  const knownBefore = await knownUniverseIds(db, universeIds);
  const unknown = universeIds.filter((universeId) => !knownBefore.has(universeId));
  let promoted = 0;
  if (unknown.length) {
    const details = await roblox.getGameDetails(unknown.map(String)).catch((error: unknown) => {
      throw new PromotionApiError(error);
    });
    promoted = (await upsertGameDetails(db, details, now)).inserted.length;
  }
  const knownAfter = await knownUniverseIds(db, universeIds);
  const discoveries = candidates
    .filter((candidate) => knownAfter.has(candidate.universeId))
    .filter((candidate) => options.recordKnown || !knownBefore.has(candidate.universeId))
    .map((candidate) => ({ ...candidate, firstSeenAt: now, lastSeenAt: now }));
  return { promoted, discoveries: await recordDiscoveries(db, discoveries) };
}
