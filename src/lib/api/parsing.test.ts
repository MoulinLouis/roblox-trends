import { describe, expect, it } from "vitest";
import {
  parseGameDetailsResponse,
  parseGameThumbnailsResponse,
  parseGameVotesResponse,
  parseRecommendationsResponse,
  parseSearchResponse,
  parseSortContentResponse,
  parseSortsResponse,
} from "./roblox";
import { parseRolimonsResponse } from "./rolimons";

describe("Roblox API response parsing", () => {
  it("parses current Charts sort and game fields", () => {
    const sort = parseSortContentResponse({ contentType: "Games", sortId: "top-trending", sortDisplayName: "Top Trending", games: [{ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345, totalUpVotes: 90, totalDownVotes: 10, isSponsored: false }] });
    expect(sort.sortId).toBe("top-trending");
    expect(sort.games[0]).toEqual({ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345, totalUpVotes: 90, totalDownVotes: 10, isSponsored: false });
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

  it("parses public vote totals", () => {
    expect(parseGameVotesResponse({ data: [{ id: 101, upVotes: 900, downVotes: 100 }] })).toEqual([
      { id: 101, upVotes: 900, downVotes: 100 },
    ]);
  });

  it("maps recommendation place IDs into chart discoveries", () => {
    expect(parseRecommendationsResponse({ games: [{ universeId: 101, placeId: 202, name: "Recommended", playerCount: 50, totalUpVotes: 12, totalDownVotes: 2, isSponsored: false }] })[0]).toEqual({
      universeId: 101,
      rootPlaceId: 202,
      name: "Recommended",
      playerCount: 50,
      totalUpVotes: 12,
      totalDownVotes: 2,
      isSponsored: false,
    });
  });

  it("flattens game contents from omni-search and ignores other content", () => {
    const games = parseSearchResponse({ searchResults: [{ contents: [
      { contentType: "Game", universeId: 101, rootPlaceId: 202, name: "Search result", playerCount: 75 },
      { contentType: "Avatar", universeId: 303, rootPlaceId: 404, name: "Ignored", playerCount: 0 },
    ] }] });
    expect(games).toEqual([{ universeId: 101, rootPlaceId: 202, name: "Search result", playerCount: 75 }]);
  });

  it("maps a completed 16:9 game thumbnail to its image and media id", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: [{ targetId: 9, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/768/432/Image/Png", version: "TN3" }] },
        { universeId: 102, error: null, thumbnails: [{ state: "Completed", imageUrl: "https://tr.rbxcdn.com/b/768/432/Image/Png" }] },
      ],
    });
    expect([...thumbnails]).toEqual([
      ["101", { imageUrl: "https://tr.rbxcdn.com/a/768/432/Image/Png", mediaId: 9 }],
      ["102", { imageUrl: "https://tr.rbxcdn.com/b/768/432/Image/Png", mediaId: null }],
    ]);
  });

  it("records games without custom thumbnails as null", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: null },
        { universeId: 102, error: null, thumbnails: [] },
      ],
    });
    expect([...thumbnails]).toEqual([["101", null], ["102", null]]);
  });

  it("records thumbnails blocked by moderation as null", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: null, thumbnails: [{ targetId: 0, state: "Blocked", imageUrl: "https://t2.rbxcdn.com/UnapprovedImage", version: "TN3" }] }],
    });
    expect([...thumbnails]).toEqual([["101", null]]);
  });

  it.each(["Pending", "InReview", "TemporarilyUnavailable"])("reports the %s state as pending", (state) => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: null, thumbnails: [{ targetId: 9, state, imageUrl: null }] }],
    });
    expect([...thumbnails]).toEqual([["101", "pending"]]);
  });

  it("reports pending when a blocked image sits next to one still processing", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: null, thumbnails: [
        { targetId: 9, state: "Blocked", imageUrl: "https://t2.rbxcdn.com/UnapprovedImage" },
        { targetId: 10, state: "Pending", imageUrl: null },
      ] }],
    });
    expect([...thumbnails]).toEqual([["101", "pending"]]);
  });

  it("leaves thumbnails in an error or unknown state unknown", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: [{ targetId: 9, state: "Error", imageUrl: null }] },
        { universeId: 102, error: null, thumbnails: [{ targetId: 10, state: "Archived", imageUrl: null }] },
      ],
    });
    expect(thumbnails.size).toBe(0);
  });

  it("leaves universes reported with an error unknown", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: { code: 1, message: "Unavailable" }, thumbnails: [{ targetId: 9, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/768/432/Image/Png" }] }],
    });
    expect(thumbnails.size).toBe(0);
  });

  it("skips a malformed thumbnail item without dropping the others", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: "x" },
        { universeId: 102, error: null, thumbnails: [{ targetId: 10, state: "Completed", imageUrl: "https://tr.rbxcdn.com/b/768/432/Image/Png" }] },
      ],
    });
    expect([...thumbnails]).toEqual([["102", { imageUrl: "https://tr.rbxcdn.com/b/768/432/Image/Png", mediaId: 10 }]]);
  });

  it("keeps the first completed thumbnail when an earlier one is still in review", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, thumbnails: [
        { targetId: 9, state: "InReview", imageUrl: null },
        { targetId: 11, state: "Completed", imageUrl: "https://tr.rbxcdn.com/c/768/432/Image/Png" },
      ] }],
    });
    expect([...thumbnails]).toEqual([["101", { imageUrl: "https://tr.rbxcdn.com/c/768/432/Image/Png", mediaId: 11 }]]);
  });
});

describe("Rolimon's response parsing", () => {
  it("maps public Place ID tuples", () => {
    expect(parseRolimonsResponse({ success: true, game_count: 1, games: { "1818": ["Classic: Crossroads", 37, "https://example.com/icon.webp"] } })).toEqual([{ placeId: "1818", name: "Classic: Crossroads", ccu: 37, thumbnailUrl: "https://example.com/icon.webp" }]);
  });
});
