import { describe, expect, it } from "vitest";
import { collectionIdentity, deduplicateCollection, floorToBucket } from "./repository";
import type { CollectedGame } from "@/lib/types";

describe("collection idempotency", () => {
  const game: CollectedGame = {
    universeId: "123",
    rootPlaceId: "456",
    name: "Test Game",
    description: "",
    creatorId: "789",
    creatorName: "Studio",
    creatorType: "Group",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ccu: 500,
    visits: 10000,
    favorites: 100,
    thumbnailUrl: null,
    genre: "Simulation",
    chart: "Top Trending",
    rank: 8,
    source: "roblox-charts",
  };

  it("uses the same bucket identity for repeated collection runs", () => {
    const first = floorToBucket(new Date("2026-08-09T12:02:00Z"), 60);
    const retry = floorToBucket(new Date("2026-08-09T12:59:59Z"), 60);
    expect(collectionIdentity(game, first)).toBe(collectionIdentity(game, retry));
  });

  it("deduplicates the same game, source, and chart in a period", () => {
    const bucket = new Date("2026-08-09T12:00:00Z");
    const updated = { ...game, ccu: 620 };
    const deduplicated = deduplicateCollection([game, updated], bucket);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0].ccu).toBe(620);
  });

  it("keeps independent chart observations", () => {
    const bucket = new Date("2026-08-09T12:00:00Z");
    expect(deduplicateCollection([game, { ...game, chart: "Top Playing Now" }], bucket)).toHaveLength(2);
  });
});
