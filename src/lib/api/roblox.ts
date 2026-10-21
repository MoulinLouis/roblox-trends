import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorMessage, logger } from "@/lib/logger";
import { fetchJson } from "./http";
import { describeIssue } from "./schema-issues";

// Vote totals and the sponsored flag may be null: no collector relies on the totals, and a null flag means unknown.
const chartGameSchema = z.object({
  universeId: z.number(),
  rootPlaceId: z.number(),
  name: z.string(),
  playerCount: z.number().nonnegative().default(0),
  totalUpVotes: z.number().int().nonnegative().nullish(),
  totalDownVotes: z.number().int().nonnegative().nullish(),
  isSponsored: z.boolean().nullish(),
});

// Games are validated one by one so that a single malformed entry cannot discard the whole sort.
const sortSchema = z.object({
  contentType: z.string().optional(),
  sortId: z.string(),
  sortDisplayName: z.string().default("Unknown chart"),
  games: z.array(z.unknown()).default([]),
});

const sortsResponseSchema = z.object({ sorts: z.array(sortSchema) });

const gameDetailSchema = z.object({
  // A moderated or deleted game comes back as a placeholder with id 0 ("[TITLE UNAVAILABLE]", creator id 0): it is
  // skipped as malformed, so it never becomes a game, and the game it stands for counts as not returned.
  id: z.number().int().positive(),
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
const recommendationSchema = chartGameSchema.omit({ rootPlaceId: true }).extend({ placeId: z.number() });
// Items are validated one by one so that a single malformed game cannot discard the whole response.
const recommendationResponseSchema = z.object({ games: z.array(z.unknown()).default([]) });
// Other content types (avatars, for example) have other fields, so only the type is read before an item is validated.
const searchContentTypeSchema = z.object({ contentType: z.string().nullish() });
const searchResponseSchema = z.object({
  searchResults: z.array(
    z.object({ contents: z.array(z.unknown()).default([]) }),
  ).default([]),
});
const universeResponseSchema = z.object({ universeId: z.number().nullable() });
// Icon and thumbnail items are validated one by one so that a single malformed universe cannot discard the whole batch.
const thumbnailEnvelopeSchema = z.object({ data: z.array(z.unknown()) });
const gameIconSchema = z.object({ targetId: z.number(), state: z.string(), imageUrl: z.string().nullish() });
const gameThumbnailSchema = z.object({ targetId: z.number().nullish(), state: z.string(), imageUrl: z.string().nullish() });
const gameThumbnailItemSchema = z.object({
  universeId: z.number(),
  error: z.unknown().optional(),
  thumbnails: z.array(gameThumbnailSchema).nullish(),
});
const pendingThumbnailStates = new Set(["Pending", "InReview", "TemporarilyUnavailable"]);

// Universe ids per request to the Games, votes, thumbnail and icon endpoints. A longer list is split into several
// requests; for game details and votes, a failure of a later one discards the answers of the earlier ones, so the
// collector batches fit in one request.
export const ROBLOX_MAXIMUM_IDS_PER_REQUEST = 50;

export type RobloxChartGame = z.infer<typeof chartGameSchema>;

export interface RobloxSortGame extends RobloxChartGame {
  // 1-based place in the sort as Roblox listed it. Malformed entries count too, so a skipped one leaves a gap.
  position: number;
}

export interface RobloxSort {
  contentType?: string;
  sortId: string;
  sortDisplayName: string;
  games: RobloxSortGame[];
  // Entries skipped as malformed.
  skipped: number;
}
export type RobloxGameDetail = z.infer<typeof gameDetailSchema>;
export type RobloxGameVote = z.infer<typeof gameVoteSchema>;

export interface GameThumbnail {
  imageUrl: string;
  // The thumbnail's targetId: the id of the game media asset shown.
  mediaId: number | null;
}

// "pending": Roblox is still processing or reviewing the image; retry later. It is an answer, not a failure.
// "error": Roblox reported an error for the universe or its image; retry later. Also an answer, not a failure.
// null: no usable custom thumbnail (none uploaded, or blocked by moderation).
export type GameThumbnailAnswer = GameThumbnail | null | "pending" | "error";

export function parseSortsResponse(value: unknown): RobloxSort[] {
  return sortsResponseSchema
    .parse(value)
    .sorts.filter((sort) => sort.contentType === "Games" || sort.games.length > 0)
    .map(toSort);
}

export function parseSortContentResponse(value: unknown): RobloxSort {
  return toSort(sortSchema.parse(value));
}

function toSort({ games, ...sort }: z.infer<typeof sortSchema>): RobloxSort {
  const { parsed, skipped } = parseEachItem(games, chartGameSchema, { label: "chart games", idKey: "universeId", details: { sortId: sort.sortId } });
  return { ...sort, games: parsed.map(({ value, position }) => ({ ...value, position })), skipped };
}

export function parseGameDetailsResponse(value: unknown): RobloxGameDetail[] {
  return parseItems(itemsResponseSchema.parse(value).data, gameDetailSchema, "game details");
}

export function parseGameVotesResponse(value: unknown): RobloxGameVote[] {
  return parseItems(itemsResponseSchema.parse(value).data, gameVoteSchema, "game votes");
}

function parseItems<T>(items: unknown[], schema: z.ZodType<T>, label: string, idKey = "id"): T[] {
  return parseEachItem(items, schema, { label, idKey }).parsed.map(({ value }) => value);
}

// Malformed items are skipped with one warning per response, so a format change that breaks every item cannot flood
// the logs. The warning names the skipped universes (read from idKey) and the first issues of the first one. Each
// parsed item keeps its 1-based position among all the items.
function parseEachItem<T>(
  items: unknown[],
  schema: z.ZodType<T>,
  options: { label: string; idKey: string; details?: Record<string, unknown> },
): { parsed: { value: T; position: number }[]; skipped: number } {
  const parsed: { value: T; position: number }[] = [];
  const skippedUniverseIds: unknown[] = [];
  let issues: string[] = [];
  items.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) {
      parsed.push({ value: result.data, position: index + 1 });
      return;
    }
    if (!skippedUniverseIds.length) {
      issues = result.error.issues.slice(0, 3).map(describeIssue);
    }
    skippedUniverseIds.push(typeof item === "object" && item !== null && options.idKey in item ? item[options.idKey as keyof typeof item] : null);
  });
  if (skippedUniverseIds.length) {
    logger.warn(`Skipped malformed ${options.label}`, {
      ...options.details,
      skipped: skippedUniverseIds.length,
      universeIds: skippedUniverseIds,
      issues,
    });
  }
  return { parsed, skipped: skippedUniverseIds.length };
}

export function parseRecommendationsResponse(value: unknown): RobloxChartGame[] {
  const games = recommendationResponseSchema.parse(value).games;
  return parseItems(games, recommendationSchema, "recommendations", "universeId").map(({ placeId, ...game }) => ({ ...game, rootPlaceId: placeId }));
}

export function parseSearchResponse(value: unknown): RobloxChartGame[] {
  const contents = searchResponseSchema
    .parse(value)
    .searchResults.flatMap((result) => result.contents)
    .filter((item) => {
      // An item that is not even an object is kept here and reported as malformed below.
      const type = searchContentTypeSchema.safeParse(item);
      return !type.success || !type.data.contentType || type.data.contentType === "Game";
    });
  return parseItems(contents, chartGameSchema, "search results", "universeId").map((game) => ({
    universeId: game.universeId,
    rootPlaceId: game.rootPlaceId,
    name: game.name,
    playerCount: game.playerCount,
    ...(game.totalUpVotes == null ? {} : { totalUpVotes: game.totalUpVotes }),
    ...(game.totalDownVotes == null ? {} : { totalDownVotes: game.totalDownVotes }),
    ...(game.isSponsored == null ? {} : { isSponsored: game.isSponsored }),
  }));
}

// A universe without an entry is unknown: its item was malformed, or its thumbnails are in a state that is neither
// usable, pending, blocked nor an error.
export function parseGameThumbnailsResponse(value: unknown): Map<string, GameThumbnailAnswer> {
  const answers = new Map<string, GameThumbnailAnswer>();
  for (const raw of thumbnailEnvelopeSchema.parse(value).data) {
    const item = gameThumbnailItemSchema.safeParse(raw);
    if (!item.success) continue;
    const answer = item.data.error != null ? "error" : gameThumbnailAnswer(item.data.thumbnails ?? []);
    if (answer !== undefined) answers.set(String(item.data.universeId), answer);
  }
  return answers;
}

// Only a completed icon is the game's own: the placeholder return policy fills the other states with a generic image.
export function parseGameIconsResponse(value: unknown): Map<string, string> {
  const icons = new Map<string, string>();
  for (const raw of thumbnailEnvelopeSchema.parse(value).data) {
    const item = gameIconSchema.safeParse(raw);
    if (item.success && item.data.state === "Completed" && item.data.imageUrl) icons.set(String(item.data.targetId), item.data.imageUrl);
  }
  return icons;
}

function gameThumbnailAnswer(thumbnails: z.infer<typeof gameThumbnailSchema>[]): GameThumbnailAnswer | undefined {
  if (thumbnails.length === 0) return null;
  const completed = thumbnails.find((thumbnail) => thumbnail.state === "Completed" && thumbnail.imageUrl);
  if (completed?.imageUrl) return { imageUrl: completed.imageUrl, mediaId: completed.targetId ?? null };
  if (thumbnails.some((thumbnail) => pendingThumbnailStates.has(thumbnail.state))) return "pending";
  if (thumbnails.every((thumbnail) => thumbnail.state === "Blocked")) return null;
  if (thumbnails.some((thumbnail) => thumbnail.state === "Error")) return "error";
  return undefined;
}

// Thumbnails are best-effort: a batch whose request failed after its retries, or whose envelope is malformed, leaves
// its universes unknown instead of discarding the other batches. Returns undefined for such a batch.
async function fetchThumbnailBatch<T>(
  url: URL,
  universeIds: string[],
  kind: "icon" | "game thumbnail",
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  try {
    return parse(await fetchJson(url.toString(), { cacheTtlMs: 60 * 60 * 1000 }));
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
  // null: Roblox knows no universe for this place. The endpoint answers a missing place with HTTP 200 and
  // { "universeId": null }; it returns 404 only for an empty id.
  resolveUniverseId(placeId: string): Promise<string | null>;
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
    for (let index = 0; index < universeIds.length; index += ROBLOX_MAXIMUM_IDS_PER_REQUEST) {
      const chunk = universeIds.slice(index, index + ROBLOX_MAXIMUM_IDS_PER_REQUEST);
      const url = new URL("https://games.roblox.com/v1/games");
      url.searchParams.set("universeIds", chunk.join(","));
      results.push(...parseGameDetailsResponse(await fetchJson(url.toString(), { cacheTtlMs: 2 * 60 * 1000 })));
    }
    return results;
  }

  async getGameVotes(universeIds: string[]): Promise<RobloxGameVote[]> {
    const results: RobloxGameVote[] = [];
    for (let index = 0; index < universeIds.length; index += ROBLOX_MAXIMUM_IDS_PER_REQUEST) {
      const chunk = universeIds.slice(index, index + ROBLOX_MAXIMUM_IDS_PER_REQUEST);
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

  async resolveUniverseId(placeId: string): Promise<string | null> {
    const value = universeResponseSchema.parse(
      await fetchJson(`https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`, {
        cacheTtlMs: 24 * 60 * 60 * 1000,
      }),
    );
    return value.universeId === null ? null : String(value.universeId);
  }

  async getThumbnails(universeIds: string[]): Promise<Map<string, string>> {
    const thumbnails = new Map<string, string>();
    for (let index = 0; index < universeIds.length; index += ROBLOX_MAXIMUM_IDS_PER_REQUEST) {
      const chunk = universeIds.slice(index, index + ROBLOX_MAXIMUM_IDS_PER_REQUEST);
      const url = new URL("https://thumbnails.roblox.com/v1/games/icons");
      url.searchParams.set("universeIds", chunk.join(","));
      url.searchParams.set("returnPolicy", "PlaceHolder");
      url.searchParams.set("size", "150x150");
      url.searchParams.set("format", "Webp");
      url.searchParams.set("isCircular", "false");
      const icons = await fetchThumbnailBatch(url, chunk, "icon", parseGameIconsResponse);
      for (const [universeId, imageUrl] of icons ?? []) thumbnails.set(universeId, imageUrl);
    }
    return thumbnails;
  }

  // Without defaults, games that have no media of their own return no thumbnail instead of a shared generic image.
  // Three per universe, so an approved image is used while the first one is still in review.
  async getGameThumbnails(universeIds: string[]): Promise<Map<string, GameThumbnailAnswer>> {
    const answers = new Map<string, GameThumbnailAnswer>();
    for (let index = 0; index < universeIds.length; index += ROBLOX_MAXIMUM_IDS_PER_REQUEST) {
      const chunk = universeIds.slice(index, index + ROBLOX_MAXIMUM_IDS_PER_REQUEST);
      const url = new URL("https://thumbnails.roblox.com/v1/games/multiget/thumbnails");
      url.searchParams.set("universeIds", chunk.join(","));
      url.searchParams.set("countPerUniverse", "3");
      url.searchParams.set("defaults", "false");
      url.searchParams.set("size", "768x432");
      url.searchParams.set("format", "Png");
      url.searchParams.set("isCircular", "false");
      const parsed = await fetchThumbnailBatch(url, chunk, "game thumbnail", parseGameThumbnailsResponse);
      for (const [universeId, answer] of parsed ?? []) answers.set(universeId, answer);
    }
    return answers;
  }
}
