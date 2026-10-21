import { z } from "zod";
import { logger } from "@/lib/logger";
import { fetchJson } from "./http";

// Entries are validated one by one so that a single malformed game cannot discard the whole list.
const rolimonsResponseSchema = z.object({
  success: z.boolean(),
  game_count: z.number(),
  games: z.record(z.string(), z.unknown()),
});
// Extra elements are allowed, so a field appended by Rolimon's does not reject every entry.
const rolimonsEntrySchema = z.tuple([z.string(), z.number().nonnegative(), z.string()], z.unknown());
// Only canonical positive decimals: each accepted key maps to exactly one place id.
const placeIdPattern = /^[1-9]\d{0,15}$/;

export interface RolimonsGame {
  placeId: string;
  name: string;
  ccu: number;
  thumbnailUrl: string;
}

export interface RolimonsGameList {
  games: RolimonsGame[];
  // Entries skipped because their key or their tuple was malformed.
  rejected: number;
}

export function parseRolimonsResponse(value: unknown): RolimonsGameList {
  const parsed = rolimonsResponseSchema.parse(value);
  if (!parsed.success) throw new Error("Rolimon's returned an unsuccessful response");
  const games: RolimonsGame[] = [];
  const rejected: string[] = [];
  for (const [placeId, raw] of Object.entries(parsed.games)) {
    const entry = rolimonsEntrySchema.safeParse(raw);
    if (!entry.success || !isPlaceId(placeId)) {
      rejected.push(placeId);
      continue;
    }
    const [name, ccu, thumbnailUrl] = entry.data;
    games.push({ placeId, name, ccu, thumbnailUrl });
  }
  if (rejected.length) logger.warn("Rejected malformed Rolimon's entries", { rejected: rejected.length, placeIds: rejected.slice(0, 3) });
  return { games, rejected: rejected.length };
}

function isPlaceId(key: string): boolean {
  return placeIdPattern.test(key) && Number.isSafeInteger(Number(key));
}

export async function getRolimonsGames(): Promise<RolimonsGameList> {
  const value = await fetchJson<unknown>("https://api.rolimons.com/games/v1/gamelist", {
    timeoutMs: 15_000,
    cacheTtlMs: 5 * 60 * 1000,
  });
  return parseRolimonsResponse(value);
}
