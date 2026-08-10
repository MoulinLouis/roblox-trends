import { describe, expect, it } from "vitest";
import { parseGameDetailsResponse, parseSortContentResponse, parseSortsResponse } from "./roblox";
import { parseRolimonsResponse } from "./rolimons";

describe("Roblox API response parsing", () => {
  it("parses current Charts sort and game fields", () => {
    const sort = parseSortContentResponse({ contentType: "Games", sortId: "top-trending", sortDisplayName: "Top Trending", games: [{ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345 }] });
    expect(sort.sortId).toBe("top-trending");
    expect(sort.games[0]).toEqual({ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345 });
  });

  it("filters non-game sort content from get-sorts", () => {
    const sorts = parseSortsResponse({ sorts: [{ contentType: "Filters", sortId: "filters_v5", sortDisplayName: "", games: [] }, { contentType: "Games", sortId: "top-playing-now", sortDisplayName: "Top Playing Now", games: [] }] });
    expect(sorts.map((sort) => sort.sortId)).toEqual(["top-playing-now"]);
  });

  it("parses game detail dates and creator metadata", () => {
    const [game] = parseGameDetailsResponse({ data: [{ id: 101, rootPlaceId: 202, name: "Game", description: "Description", creator: { id: 303, name: "Studio", type: "Group" }, playing: 450, visits: 12000, created: "2026-08-01T00:00:00Z", updated: "2026-08-09T00:00:00Z", favoritedCount: 90, genre: "All", genre_l1: "Simulation" }] });
    expect(game.created).toBeInstanceOf(Date);
    expect(game.creator.name).toBe("Studio");
    expect(game.favoritedCount).toBe(90);
  });

  it("rejects malformed required fields", () => {
    expect(() => parseGameDetailsResponse({ data: [{ id: "not-a-number" }] })).toThrow();
  });
});

describe("Rolimon's response parsing", () => {
  it("maps public Place ID tuples", () => {
    expect(parseRolimonsResponse({ success: true, game_count: 1, games: { "1818": ["Classic: Crossroads", 37, "https://example.com/icon.webp"] } })).toEqual([{ placeId: "1818", name: "Classic: Crossroads", ccu: 37, thumbnailUrl: "https://example.com/icon.webp" }]);
  });
});
