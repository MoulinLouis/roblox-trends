import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorMessage, logger } from "@/lib/logger";
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

const gameVoteSchema = z.object({
  id: z.number(),
  upVotes: z.number().int().nonnegative(),
  downVotes: z.number().int().nonnegative(),
});
// Items are validated one by one so that a single malformed game cannot discard the whole batch.
const itemsResponseSchema = z.object({ data: z.array(z.unknown()) });
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
// Items are validated one by one so that a single malformed universe cannot discard the whole batch.
const gameThumbnailsResponseSchema = z.object({ data: z.array(z.unknown()) });
const gameThumbnailSchema = z.object({ targetId: z.number().nullish(), state: z.string(), imageUrl: z.string().nullish() });
const gameThumbnailItemSchema = z.object({
  universeId: z.number(),
  error: z.unknown().optional(),
  thumbnails: z.array(gameThumbnailSchema).nullish(),
});
const pendingThumbnailStates = new Set(["Pending", "InReview", "TemporarilyUnavailable"]);

export type RobloxChartGame = z.infer<typeof chartGameSchema>;
export type RobloxSort = z.infer<typeof sortSchema>;
export type RobloxGameDetail = z.infer<typeof gameDetailSchema>;
export type RobloxGameVote = z.infer<typeof gameVoteSchema>;

export interface GameThumbnail {
  imageUrl: string;
  // The thumbnail's targetId: the id of the game media asset shown.
  mediaId: number | null;
}

// "pending": Roblox is still processing or reviewing the image; retry later. It is an answer, not a failure.
// null: no usable custom thumbnail (none uploaded, or blocked by moderation).
export type GameThumbnailAnswer = GameThumbnail | null | "pending";

export function parseSortsResponse(value: unknown): RobloxSort[] {
  return sortsResponseSchema.parse(value).sorts.filter((sort) => sort.contentType === "Games" || sort.games.length > 0);
}

export function parseSortContentResponse(value: unknown): RobloxSort {
  return sortContentSchema.parse(value);
}

export function parseGameDetailsResponse(value: unknown): RobloxGameDetail[] {
  return parseItems(itemsResponseSchema.parse(value).data, gameDetailSchema, "game details");
}

export function parseGameVotesResponse(value: unknown): RobloxGameVote[] {
  return parseItems(itemsResponseSchema.parse(value).data, gameVoteSchema, "game votes");
}

// Malformed items are skipped with one warning per batch, so a format change that breaks every item cannot flood
// the logs. The warning names the skipped universes and the first issues of the first one.
function parseItems<T>(items: unknown[], schema: z.ZodType<T>, label: string): T[] {
  const parsed: T[] = [];
  const skippedUniverseIds: unknown[] = [];
  let issues: string[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      parsed.push(result.data);
      continue;
    }
    if (!skippedUniverseIds.length) {
      issues = result.error.issues.slice(0, 3).map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);
    }
    skippedUniverseIds.push(typeof item === "object" && item !== null && "id" in item ? item.id : null);
  }
  if (skippedUniverseIds.length) {
    logger.warn(`Skipped malformed ${label}`, { skipped: skippedUniverseIds.length, universeIds: skippedUniverseIds, issues });
  }
  return parsed;
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

// A universe without an entry is unknown: its item was malformed or carried an error, or its thumbnails are in a
// state that is neither usable, pending nor blocked (for example Error).
export function parseGameThumbnailsResponse(value: unknown): Map<string, GameThumbnailAnswer> {
  const answers = new Map<string, GameThumbnailAnswer>();
  for (const raw of gameThumbnailsResponseSchema.parse(value).data) {
    const item = gameThumbnailItemSchema.safeParse(raw);
    if (!item.success || item.data.error != null) continue;
    const answer = gameThumbnailAnswer(item.data.thumbnails ?? []);
    if (answer !== undefined) answers.set(String(item.data.universeId), answer);
  }
  return answers;
}

function gameThumbnailAnswer(thumbnails: z.infer<typeof gameThumbnailSchema>[]): GameThumbnailAnswer | undefined {
  if (thumbnails.length === 0) return null;
  const completed = thumbnails.find((thumbnail) => thumbnail.state === "Completed" && thumbnail.imageUrl);
  if (completed?.imageUrl) return { imageUrl: completed.imageUrl, mediaId: completed.targetId ?? null };
  if (thumbnails.some((thumbnail) => pendingThumbnailStates.has(thumbnail.state))) return "pending";
  if (thumbnails.every((thumbnail) => thumbnail.state === "Blocked")) return null;
  return undefined;
}

// Thumbnails are best-effort: a failed batch leaves its universes unknown instead of discarding the other batches.
// Returns undefined when the request failed after its retries.
async function fetchThumbnailBatch(url: URL, universeIds: string[], kind: "icon" | "game thumbnail"): Promise<unknown> {
  try {
    return await fetchJson(url.toString(), { cacheTtlMs: 60 * 60 * 1000 });
  } catch (error) {
    logger.warn("Thumbnail batch failed; its universes stay unknown", {
      kind,
      universes: universeIds.length,
      firstUniverseId: universeIds[0],
      error: errorMessage(error),
    });
    return undefined;
  }
}

export interface RobloxApi {
  getSortContent(sortId: string): Promise<RobloxSort>;
  getGameDetails(universeIds: string[]): Promise<RobloxGameDetail[]>;
  getGameVotes(universeIds: string[]): Promise<RobloxGameVote[]>;
  getRecommendations(universeId: string, maximumRows?: number): Promise<RobloxChartGame[]>;
  searchGames(query: string): Promise<RobloxChartGame[]>;
  resolveUniverseId(placeId: string): Promise<string>;
  getThumbnails(universeIds: string[]): Promise<Map<string, string>>;
  getGameThumbnails(universeIds: string[]): Promise<Map<string, GameThumbnailAnswer>>;
}

export class RobloxClient implements RobloxApi {
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
      const response = await fetchThumbnailBatch(url, chunk, "icon");
      if (response === undefined) continue;
      const parsed = thumbnailsResponseSchema.parse(response);
      for (const item of parsed.data) if (item.imageUrl) thumbnails.set(String(item.targetId), item.imageUrl);
    }
    return thumbnails;
  }

  // Without defaults, games that have no media of their own return no thumbnail instead of a shared generic image.
  // Three per universe, so an approved image is used while the first one is still in review.
  async getGameThumbnails(universeIds: string[]): Promise<Map<string, GameThumbnailAnswer>> {
    const answers = new Map<string, GameThumbnailAnswer>();
    for (let index = 0; index < universeIds.length; index += 50) {
      const chunk = universeIds.slice(index, index + 50);
      const url = new URL("https://thumbnails.roblox.com/v1/games/multiget/thumbnails");
      url.searchParams.set("universeIds", chunk.join(","));
      url.searchParams.set("countPerUniverse", "3");
      url.searchParams.set("defaults", "false");
      url.searchParams.set("size", "768x432");
      url.searchParams.set("format", "Png");
      url.searchParams.set("isCircular", "false");
      const response = await fetchThumbnailBatch(url, chunk, "game thumbnail");
      if (response === undefined) continue;
      for (const [universeId, answer] of parseGameThumbnailsResponse(response)) answers.set(universeId, answer);
    }
    return answers;
  }
}
