import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGameDetailsResponse,
  parseGameIconsResponse,
  parseGameThumbnailsResponse,
  parseGameVotesResponse,
  parseRecommendationsResponse,
  parseSearchResponse,
  parseSortContentResponse,
  parseSortsResponse,
} from "./roblox";
import { parseRolimonsResponse } from "./rolimons";

const gameDetailItem = {
  id: 101,
  rootPlaceId: 202,
  name: "Game",
  description: "Description",
  creator: { id: 303, name: "Studio", type: "Group" },
  playing: 450,
  visits: 12000,
  created: "2026-08-01T00:00:00Z",
  updated: "2026-08-09T00:00:00Z",
  favoritedCount: 90,
  genre: "All",
  genre_l1: "Simulation",
};

// The details of the single warning a parser logged.
function loggedDetails(warn: { mock: { calls: unknown[][] } }): unknown {
  expect(warn.mock.calls).toHaveLength(1);
  return JSON.parse(String(warn.mock.calls[0][0])).details;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Roblox API response parsing", () => {
  it("parses current Charts sort and game fields", () => {
    const sort = parseSortContentResponse({ contentType: "Games", sortId: "top-trending", sortDisplayName: "Top Trending", games: [{ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345, totalUpVotes: 90, totalDownVotes: 10, isSponsored: false }] });
    expect(sort.sortId).toBe("top-trending");
    expect(sort.skipped).toBe(0);
    expect(sort.games[0]).toEqual({ universeId: 101, rootPlaceId: 202, name: "Game", playerCount: 345, totalUpVotes: 90, totalDownVotes: 10, isSponsored: false, position: 1 });
  });

  it("skips a malformed chart game and keeps the listed position of the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sort = parseSortContentResponse({
      sortId: "top-trending",
      games: [
        { universeId: 101, rootPlaceId: 202, name: "First", playerCount: 50 },
        { universeId: 102, rootPlaceId: 203, name: 7, playerCount: 40 },
        // Vote totals and the sponsored flag may be null: charts never store the totals, and null means unknown.
        { universeId: 103, rootPlaceId: 204, name: "Third", playerCount: 30, totalUpVotes: null, totalDownVotes: null, isSponsored: null },
      ],
    });
    expect(sort.games.map((game) => [game.universeId, game.position])).toEqual([[101, 1], [103, 3]]);
    expect(sort.skipped).toBe(1);
    expect(loggedDetails(warn)).toEqual({ sortId: "top-trending", skipped: 1, universeIds: [102], issues: [expect.stringContaining("name")] });
  });

  it("rejects a malformed sort envelope", () => {
    expect(() => parseSortContentResponse({ sortId: "top-trending", games: "x" })).toThrow();
    expect(() => parseSortContentResponse({ games: [] })).toThrow();
  });

  it("filters non-game sort content from get-sorts", () => {
    const sorts = parseSortsResponse({ sorts: [{ contentType: "Filters", sortId: "filters_v5", sortDisplayName: "", games: [] }, { contentType: "Games", sortId: "top-playing-now", sortDisplayName: "Top Playing Now", games: [] }] });
    expect(sorts.map((sort) => sort.sortId)).toEqual(["top-playing-now"]);
  });

  it("parses game detail dates and creator metadata", () => {
    const [game] = parseGameDetailsResponse({ data: [gameDetailItem] });
    expect(game.created).toBeInstanceOf(Date);
    expect(game.creator.name).toBe("Studio");
    expect(game.favoritedCount).toBe(90);
  });

  it("skips a malformed game detail without dropping the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const games = parseGameDetailsResponse({ data: [{ id: 102, name: 7 }, gameDetailItem] });
    expect(games.map((game) => game.id)).toEqual([101]);
    expect(loggedDetails(warn)).toEqual({ skipped: 1, universeIds: [102], issues: [expect.any(String), expect.any(String), expect.any(String)] });
  });

  it("rejects a malformed game details envelope", () => {
    expect(() => parseGameDetailsResponse({ data: { id: 101 } })).toThrow();
  });

  it("parses public vote totals", () => {
    expect(parseGameVotesResponse({ data: [{ id: 101, upVotes: 900, downVotes: 100 }] })).toEqual([
      { id: 101, upVotes: 900, downVotes: 100 },
    ]);
  });

  it("describes an issue about the item itself without a path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseGameVotesResponse({ data: ["x", { id: 101, upVotes: 900, downVotes: 100 }] })).toHaveLength(1);
    expect(loggedDetails(warn)).toEqual({ skipped: 1, universeIds: [null], issues: ["Invalid input: expected object, received string"] });
  });

  it("skips a malformed vote item without dropping the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const votes = parseGameVotesResponse({ data: [{ id: 102, upVotes: -1, downVotes: 0 }, { id: 101, upVotes: 900, downVotes: 100 }] });
    expect(votes).toEqual([{ id: 101, upVotes: 900, downVotes: 100 }]);
    expect(loggedDetails(warn)).toEqual({ skipped: 1, universeIds: [102], issues: [expect.stringContaining("upVotes")] });
  });

  it("rejects a malformed votes envelope", () => {
    expect(() => parseGameVotesResponse({ games: [] })).toThrow();
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

  it("skips a malformed recommendation without dropping the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const games = parseRecommendationsResponse({ games: [
      { universeId: 101, placeId: "x", name: "Broken" },
      { universeId: 102, placeId: 203, name: "Recommended", playerCount: 5, totalUpVotes: null, isSponsored: null },
    ] });
    expect(games.map((game) => game.universeId)).toEqual([102]);
    expect(loggedDetails(warn)).toEqual({ skipped: 1, universeIds: [101], issues: [expect.stringContaining("placeId")] });
  });

  it("rejects a malformed recommendations envelope", () => {
    expect(() => parseRecommendationsResponse({ games: "x" })).toThrow();
  });

  it("flattens game contents from omni-search and ignores other content", () => {
    const games = parseSearchResponse({ searchResults: [{ contents: [
      { contentType: "Game", universeId: 101, rootPlaceId: 202, name: "Search result", playerCount: 75 },
      { contentType: "Avatar", universeId: 303, rootPlaceId: 404, name: "Ignored", playerCount: 0 },
    ] }] });
    expect(games).toEqual([{ universeId: 101, rootPlaceId: 202, name: "Search result", playerCount: 75 }]);
  });

  it("skips a malformed search result without dropping the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const games = parseSearchResponse({ searchResults: [
      { contents: [{ contentType: "Game", universeId: 101, rootPlaceId: "x", name: "Broken" }] },
      { contents: [
        // Other content types have other fields; they are ignored, not counted as malformed.
        { contentType: "Avatar", name: "Ignored" },
        { contentType: "Game", universeId: 102, rootPlaceId: 203, name: "Kept", playerCount: 9, totalUpVotes: null, isSponsored: null },
      ] },
    ] });
    expect(games).toEqual([{ universeId: 102, rootPlaceId: 203, name: "Kept", playerCount: 9 }]);
    expect(loggedDetails(warn)).toEqual({ skipped: 1, universeIds: [101], issues: [expect.stringContaining("rootPlaceId")] });
  });

  it("rejects a malformed search envelope", () => {
    expect(() => parseSearchResponse({ searchResults: [{ contents: "x" }] })).toThrow();
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

  it("reports thumbnails in the Error state as an error", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [
        { universeId: 101, error: null, thumbnails: [{ targetId: 9, state: "Error", imageUrl: null }] },
        { universeId: 102, error: null, thumbnails: [
          { targetId: 10, state: "Blocked", imageUrl: "https://t2.rbxcdn.com/UnapprovedImage" },
          { targetId: 11, state: "Error", imageUrl: null },
        ] },
      ],
    });
    expect([...thumbnails]).toEqual([["101", "error"], ["102", "error"]]);
  });

  it("reports universes answered with an error as an error", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: { code: 1, message: "Unavailable" }, thumbnails: [{ targetId: 9, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/768/432/Image/Png" }] }],
    });
    expect([...thumbnails]).toEqual([["101", "error"]]);
  });

  it("leaves thumbnails in an unknown state unknown", () => {
    const thumbnails = parseGameThumbnailsResponse({
      data: [{ universeId: 101, error: null, thumbnails: [{ targetId: 10, state: "Archived", imageUrl: null }] }],
    });
    expect(thumbnails.size).toBe(0);
  });

  it("rejects a malformed game thumbnails envelope", () => {
    expect(() => parseGameThumbnailsResponse({ data: "x" })).toThrow();
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

  it("keeps completed icons only: the placeholder policy fills other states with a generic image", () => {
    const icons = parseGameIconsResponse({
      data: [
        { targetId: 101, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/150/150/Image/Webp", version: "TN3" },
        { targetId: 102, state: "Pending", imageUrl: "https://t1.rbxcdn.com/PlaceholderImage" },
        { targetId: 103, state: "Blocked", imageUrl: "https://t2.rbxcdn.com/UnapprovedImage" },
        { targetId: 104, state: "Completed", imageUrl: null },
      ],
    });
    expect([...icons]).toEqual([["101", "https://tr.rbxcdn.com/a/150/150/Image/Webp"]]);
  });

  it("skips a malformed icon item without dropping the others", () => {
    const icons = parseGameIconsResponse({
      data: [
        { targetId: "x", state: "Completed", imageUrl: "https://tr.rbxcdn.com/a/150/150/Image/Webp" },
        { targetId: 102, state: "Completed", imageUrl: "https://tr.rbxcdn.com/b/150/150/Image/Webp" },
      ],
    });
    expect([...icons]).toEqual([["102", "https://tr.rbxcdn.com/b/150/150/Image/Webp"]]);
  });

  it("rejects a malformed icons envelope", () => {
    expect(() => parseGameIconsResponse({ data: "x" })).toThrow();
  });
});

describe("Rolimon's response parsing", () => {
  it("maps public Place ID tuples", () => {
    expect(parseRolimonsResponse({ success: true, game_count: 1, games: { "1818": ["Classic: Crossroads", 37, "https://example.com/icon.webp"] } })).toEqual({
      games: [{ placeId: "1818", name: "Classic: Crossroads", ccu: 37, thumbnailUrl: "https://example.com/icon.webp" }],
      rejected: 0,
    });
  });

  it("accepts tuples with extra elements", () => {
    const { games } = parseRolimonsResponse({ success: true, game_count: 1, games: { "1818": ["Crossroads", 37, "https://example.com/icon.webp", 99] } });
    expect(games).toEqual([{ placeId: "1818", name: "Crossroads", ccu: 37, thumbnailUrl: "https://example.com/icon.webp" }]);
  });

  it("rejects malformed entries and non-canonical keys without dropping the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = ["Game", 10, ""];
    const list = parseRolimonsResponse({
      success: true,
      game_count: 8,
      games: {
        "1818": ["Crossroads", 37, ""],
        "0123": entry,
        "-5": entry,
        "1.5": entry,
        "9007199254740993": entry,
        "77": ["Game", -1, ""],
        "88": "not a tuple",
        "99": ["Game", 10],
      },
    });
    expect(list).toEqual({ games: [{ placeId: "1818", name: "Crossroads", ccu: 37, thumbnailUrl: "" }], rejected: 7 });
    expect(loggedDetails(warn)).toEqual({ rejected: 7, placeIds: ["77", "88", "99"], issue: "1: Too small: expected number to be >=0" });
  });

  it("rejects a malformed envelope", () => {
    expect(() => parseRolimonsResponse({ success: true, game_count: 1, games: "x" })).toThrow();
    expect(() => parseRolimonsResponse({ success: false, game_count: 0, games: {} })).toThrow();
  });
});
