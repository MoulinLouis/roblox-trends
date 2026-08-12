import { z } from "zod";
import { fetchJson } from "./http";

const rolimonsResponseSchema = z.object({
  success: z.boolean(),
  game_count: z.number(),
  games: z.record(z.string(), z.tuple([z.string(), z.number().nonnegative(), z.string()])),
});

export interface RolimonsGame {
  placeId: string;
  name: string;
  ccu: number;
  thumbnailUrl: string;
}

export function parseRolimonsResponse(value: unknown): RolimonsGame[] {
  const parsed = rolimonsResponseSchema.parse(value);
  if (!parsed.success) throw new Error("Rolimon's returned an unsuccessful response");
  return Object.entries(parsed.games).map(([placeId, [name, ccu, thumbnailUrl]]) => ({
    placeId,
    name,
    ccu,
    thumbnailUrl,
  }));
}

export async function getRolimonsGames(): Promise<RolimonsGame[]> {
  const value = await fetchJson<unknown>("https://api.rolimons.com/games/v1/gamelist", {
    timeoutMs: 15_000,
    cacheTtlMs: 5 * 60 * 1000,
  });
  return parseRolimonsResponse(value);
}
