import { describe, expect, it } from "vitest";
import { chunk, uniqueBy } from "./arrays";

describe("chunk", () => {
  it("splits items into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no groups for an empty list", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("uniqueBy", () => {
  it("keeps the first item for each key", () => {
    expect(uniqueBy([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 1, v: "c" }], (item) => item.id)).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);
  });

  it("deduplicates by a composite string key", () => {
    const rows = [
      { chart: "top", game: 1, rank: 3 },
      { chart: "top", game: 2, rank: 4 },
      { chart: "top", game: 1, rank: 9 },
      { chart: "new", game: 1, rank: 1 },
    ];
    expect(uniqueBy(rows, (row) => `${row.chart}:${row.game}`)).toEqual([
      { chart: "top", game: 1, rank: 3 },
      { chart: "top", game: 2, rank: 4 },
      { chart: "new", game: 1, rank: 1 },
    ]);
  });
});
