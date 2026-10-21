import type { Database } from "@/db/client";
import { recordDiscoveries } from "@/db/discovery";
import { knownUniverseIds, upsertGameDetails } from "@/db/games";
import type { RobloxApi } from "@/lib/api/roblox";
import { errorMessage } from "@/lib/logger";
import type { DiscoverySource } from "./types";

// The Games API failed, so callers may carry on and promote later. Database errors are not wrapped: they still fail
// the run.
export class PromotionApiError extends Error {
  constructor(
    cause: unknown,
    // Discoveries of known games recorded before the call, which the failure does not undo.
    readonly recordedDiscoveries = 0,
  ) {
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
// With recordKnown, discoveries of already-tracked games are recorded too, before the Games API call: its failure
// then loses only the unknown universes, which the caller finds again on its next run. With skipApi, nothing else
// happens: a caller whose Games API host is rate limited still records what it found among known games.
export async function promoteUniverses(
  db: Database,
  roblox: Pick<RobloxApi, "getGameDetails">,
  candidates: PromotionCandidate[],
  now: Date,
  options: { recordKnown?: boolean; skipApi?: boolean } = {},
): Promise<{ promoted: number; discoveries: number }> {
  if (!candidates.length) return { promoted: 0, discoveries: 0 };
  const universeIds = [...new Set(candidates.map((candidate) => candidate.universeId))];
  const knownBefore = await knownUniverseIds(db, universeIds);
  const record = (found: (universeId: number) => boolean) =>
    recordDiscoveries(
      db,
      candidates
        .filter((candidate) => found(candidate.universeId))
        .map((candidate) => ({ ...candidate, firstSeenAt: now, lastSeenAt: now })),
    );
  let discoveries = options.recordKnown ? await record((universeId) => knownBefore.has(universeId)) : 0;
  const unknown = universeIds.filter((universeId) => !knownBefore.has(universeId));
  if (!unknown.length || options.skipApi) return { promoted: 0, discoveries };
  const details = await roblox.getGameDetails(unknown.map(String)).catch((error: unknown) => {
    throw new PromotionApiError(error, discoveries);
  });
  const promoted = (await upsertGameDetails(db, details, now)).inserted.length;
  // A universe the Games API omitted stays unknown and is not recorded.
  const knownAfter = await knownUniverseIds(db, unknown);
  discoveries += await record((universeId) => !knownBefore.has(universeId) && knownAfter.has(universeId));
  return { promoted, discoveries };
}
