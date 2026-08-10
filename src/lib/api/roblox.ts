import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchJson } from "./http";

const chartGameSchema = z.object({
  universeId: z.number(),
  rootPlaceId: z.number(),
  name: z.string(),
  playerCount: z.number().nonnegative().default(0),
  totalUpVotes: z.number().int().nonnegative().optional(),
  totalDownVotes: z.number().int().nonnegative().optional(),
  isSponsored: z.boolean().optional(),
});

const sortSchema = z.object({
  contentType: z.string().optional(),
  sortId: z.string(),
  sortDisplayName: z.string().default("Unknown chart"),
  games: z.array(chartGameSchema).default([]),
});

const sortsResponseSchema = z.object({ sorts: z.array(sortSchema) });
const sortContentSchema = sortSchema;

const gameDetailSchema = z.object({
  id: z.number(),
  rootPlaceId: z.number(),
  name: z.string(),
  description: z.string().nullish().transform((value) => value ?? ""),
  creator: z.object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
  }),
  playing: z.number().nonnegative().default(0),
  visits: z.number().nonnegative().default(0),
  created: z.coerce.date(),
  updated: z.coerce.date(),
  favoritedCount: z.number().nonnegative().default(0),
  genre: z.string().nullish(),
  genre_l1: z.string().nullish(),
});

const gameDetailsResponseSchema = z.object({ data: z.array(gameDetailSchema) });
const gameVotesResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.number(),
      upVotes: z.number().int().nonnegative(),
      downVotes: z.number().int().nonnegative(),
    }),
  ),
});
const recommendationResponseSchema = z.object({
  games: z.array(
    z.object({
      universeId: z.number(),
      placeId: z.number(),
      name: z.string(),
      playerCount: z.number().nonnegative().default(0),
      totalUpVotes: z.number().int().nonnegative().optional(),
      totalDownVotes: z.number().int().nonnegative().optional(),
      isSponsored: z.boolean().optional(),
    }),
  ).default([]),
});
const searchContentSchema = z.object({
  universeId: z.number(),
  rootPlaceId: z.number(),
  name: z.string(),
  playerCount: z.number().nonnegative().default(0),
  totalUpVotes: z.number().int().nonnegative().optional(),
  totalDownVotes: z.number().int().nonnegative().optional(),
  isSponsored: z.boolean().optional(),
  contentType: z.string().optional(),
});
const searchResponseSchema = z.object({
  searchResults: z.array(
    z.object({ contents: z.array(searchContentSchema).default([]) }),
  ).default([]),
});
const universeResponseSchema = z.object({ universeId: z.number() });
const thumbnailsResponseSchema = z.object({
  data: z.array(
    z.object({
      targetId: z.number(),
      state: z.string(),
      imageUrl: z.string().nullable(),
    }),
  ),
});

export type RobloxChartGame = z.infer<typeof chartGameSchema>;
export type RobloxSort = z.infer<typeof sortSchema>;
export type RobloxGameDetail = z.infer<typeof gameDetailSchema>;
export type RobloxGameVote = z.infer<typeof gameVotesResponseSchema>["data"][number];

export function parseSortsResponse(value: unknown): RobloxSort[] {
  return sortsResponseSchema.parse(value).sorts.filter((sort) => sort.contentType === "Games" || sort.games.length > 0);
}

export function parseSortContentResponse(value: unknown): RobloxSort {
  return sortContentSchema.parse(value);
}

export function parseGameDetailsResponse(value: unknown): RobloxGameDetail[] {
  return gameDetailsResponseSchema.parse(value).data;
}

export function parseGameVotesResponse(value: unknown): RobloxGameVote[] {
  return gameVotesResponseSchema.parse(value).data;
}

export function parseRecommendationsResponse(value: unknown): RobloxChartGame[] {
  return recommendationResponseSchema.parse(value).games.map((game) => ({
    universeId: game.universeId,
    rootPlaceId: game.placeId,
    name: game.name,
    playerCount: game.playerCount,
    totalUpVotes: game.totalUpVotes,
    totalDownVotes: game.totalDownVotes,
    isSponsored: game.isSponsored,
  }));
}

export function parseSearchResponse(value: unknown): RobloxChartGame[] {
  return searchResponseSchema
    .parse(value)
    .searchResults.flatMap((result) => result.contents)
    .filter((game) => !game.contentType || game.contentType === "Game")
    .map((game) => ({
      universeId: game.universeId,
      rootPlaceId: game.rootPlaceId,
      name: game.name,
      playerCount: game.playerCount,
      ...(game.totalUpVotes === undefined ? {} : { totalUpVotes: game.totalUpVotes }),
      ...(game.totalDownVotes === undefined ? {} : { totalDownVotes: game.totalDownVotes }),
      ...(game.isSponsored === undefined ? {} : { isSponsored: game.isSponsored }),
    }));
}

export class RobloxClient {
  private readonly sessionId = randomUUID();

  constructor(
    private readonly country = "all",
    private readonly device = "computer",
  ) {}

  async getSorts(): Promise<RobloxSort[]> {
    const url = new URL("https://apis.roblox.com/explore-api/v1/get-sorts");
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("device", this.device);
    url.searchParams.set("country", this.country);
    return parseSortsResponse(await fetchJson(url.toString(), { cacheTtlMs: 10 * 60 * 1000 }));
  }

  async getSortContent(sortId: string): Promise<RobloxSort> {
    const url = new URL("https://apis.roblox.com/explore-api/v1/get-sort-content");
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("sortId", sortId);
    url.searchParams.set("device", this.device);
    url.searchParams.set("country", this.country);
    return parseSortContentResponse(await fetchJson(url.toString(), { cacheTtlMs: 10 * 60 * 1000 }));
  }

  async getGameDetails(universeIds: string[]): Promise<RobloxGameDetail[]> {
    const results: RobloxGameDetail[] = [];
    for (let index = 0; index < universeIds.length; index += 50) {
      const chunk = universeIds.slice(index, index + 50);
      const url = new URL("https://games.roblox.com/v1/games");
      url.searchParams.set("universeIds", chunk.join(","));
      results.push(...parseGameDetailsResponse(await fetchJson(url.toString(), { cacheTtlMs: 2 * 60 * 1000 })));
    }
    return results;
  }

  async getGameVotes(universeIds: string[]): Promise<RobloxGameVote[]> {
    const results: RobloxGameVote[] = [];
    for (let index = 0; index < universeIds.length; index += 50) {
      const chunk = universeIds.slice(index, index + 50);
      const url = new URL("https://games.roblox.com/v1/games/votes");
      url.searchParams.set("universeIds", chunk.join(","));
      results.push(...parseGameVotesResponse(await fetchJson(url.toString(), { cacheTtlMs: 2 * 60 * 1000 })));
    }
    return results;
  }

  async getRecommendations(universeId: string, maximumRows = 20): Promise<RobloxChartGame[]> {
    const url = new URL(`https://games.roblox.com/v1/games/recommendations/game/${encodeURIComponent(universeId)}`);
    url.searchParams.set("maxRows", String(maximumRows));
    return parseRecommendationsResponse(await fetchJson(url.toString(), { cacheTtlMs: 30 * 60 * 1000 }));
  }

  async searchGames(query: string): Promise<RobloxChartGame[]> {
    const url = new URL("https://apis.roblox.com/search-api/omni-search");
    url.searchParams.set("searchQuery", query);
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("pageType", "all");
    return parseSearchResponse(await fetchJson(url.toString(), { cacheTtlMs: 30 * 60 * 1000 }));
  }

  async resolveUniverseId(placeId: string): Promise<string> {
    const value = universeResponseSchema.parse(
      await fetchJson(`https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`, {
        cacheTtlMs: 24 * 60 * 60 * 1000,
      }),
    );
    return String(value.universeId);
  }

  async getThumbnails(universeIds: string[]): Promise<Map<string, string>> {
    const thumbnails = new Map<string, string>();
    for (let index = 0; index < universeIds.length; index += 50) {
      const chunk = universeIds.slice(index, index + 50);
      const url = new URL("https://thumbnails.roblox.com/v1/games/icons");
      url.searchParams.set("universeIds", chunk.join(","));
      url.searchParams.set("returnPolicy", "PlaceHolder");
      url.searchParams.set("size", "150x150");
      url.searchParams.set("format", "Webp");
      url.searchParams.set("isCircular", "false");
      const parsed = thumbnailsResponseSchema.parse(await fetchJson(url.toString(), { cacheTtlMs: 60 * 60 * 1000 }));
      for (const item of parsed.data) if (item.imageUrl) thumbnails.set(String(item.targetId), item.imageUrl);
    }
    return thumbnails;
  }
}
