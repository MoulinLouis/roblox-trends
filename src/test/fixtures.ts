import type { RobloxGameDetail } from "@/lib/api/roblox";

// Test-only game details. Used exclusively with disposable test databases.
export function gameDetail(id: number, overrides: Partial<RobloxGameDetail> = {}): RobloxGameDetail {
  return {
    id,
    rootPlaceId: id + 1_000_000,
    name: `Game ${id}`,
    description: "",
    creator: { id: 1, name: "Studio", type: "Group" },
    playing: 100,
    visits: 10_000,
    created: new Date("2026-10-01T00:00:00Z"),
    updated: new Date("2026-10-19T00:00:00Z"),
    favoritedCount: 50,
    genre: "All",
    genre_l1: "Simulation",
    ...overrides,
  };
}
