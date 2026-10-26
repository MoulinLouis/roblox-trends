import { describe, expect, it } from "vitest";
import type { RobloxApi, RobloxChartGame, RobloxGameDetail, RobloxSearchPage } from "@/lib/api/roblox";
import { runConceptCheck, type ConceptCheckDependencies } from "./check";
import type { ConceptHistory } from "./types";

const now = new Date("2026-10-26T18:00:00Z");

function found(universeId: number): RobloxChartGame {
  return { universeId, rootPlaceId: universeId + 1_000, name: `Game ${universeId}`, playerCount: 0 };
}

function detail(id: number, name: string): RobloxGameDetail {
  return {
    id,
    rootPlaceId: id + 1_000,
    name,
    description: "",
    creator: { id: 1, name: "Studio", type: "Group" },
    playing: 0,
    visits: 5_000,
    created: new Date("2026-09-01T00:00:00Z"),
    updated: new Date("2026-10-01T00:00:00Z"),
    favoritedCount: 10,
  };
}

// Search pages by phrase, then by page token ("" for the first page); a function rejects that request.
type Pages = Record<string, Record<string, RobloxSearchPage | (() => Promise<never>)>>;

function fakeApi(pages: Pages, details: RobloxGameDetail[]) {
  const requested: string[] = [];
  const api: Pick<RobloxApi, "searchGames" | "getGameDetails" | "getGameVotes"> = {
    async searchGames(query, pageToken) {
      requested.push(`${query}:${pageToken ?? ""}`);
      const page = pages[query]?.[pageToken ?? ""] ?? { games: [], nextPageToken: null };
      return typeof page === "function" ? page() : page;
    },
    async getGameDetails(universeIds) {
      return details.filter((item) => universeIds.includes(String(item.id)));
    },
    async getGameVotes(universeIds) {
      return universeIds.map((id) => ({ id: Number(id), upVotes: 9, downVotes: 1 }));
    },
  };
  return { api, requested };
}

function dependencies(api: ConceptCheckDependencies["api"], extra: Partial<ConceptCheckDependencies> = {}): ConceptCheckDependencies {
  return { api, now, historySkippedReason: "DATABASE_URL is not set", ...extra };
}

describe("runConceptCheck", () => {
  it("merges results across phrases and pages", async () => {
    const { api, requested } = fakeApi(
      {
        "stone skipping": {
          "": { games: [found(1), found(2)], nextPageToken: "p2" },
          p2: { games: [found(2), found(3)], nextPageToken: "p3" },
        },
        "skip stones": { "": { games: [found(1)], nextPageToken: null } },
      },
      [detail(1, "Skip a Stone"), detail(2, "Egg Tycoon"), detail(4, "Skip Stones Elsewhere")],
    );
    const report = await runConceptCheck(["stone skipping", "skip stones"], dependencies(api));
    expect(requested).toEqual(["stone skipping:", "stone skipping:p2", "skip stones:"]);
    expect(report.attempts.map((attempt) => [attempt.universeId, attempt.matchedPhrases])).toEqual([
      [1, ["stone skipping", "skip stones"]],
    ]);
    expect(report.attempts[0]).toMatchObject({ upVotes: 9, downVotes: 1, likeRatio: 0.9, labels: ["leader", "no audience"] });
    expect(report.summary).toMatchObject({ attempts: 1, hidden: 1, unavailable: 1 });
  });

  it("reports a failed search and keeps the other phrases", async () => {
    const { api } = fakeApi(
      {
        "stone skipping": { "": () => Promise.reject(new Error("HTTP 429")) },
        "skip stones": { "": { games: [found(1)], nextPageToken: null } },
      },
      [detail(1, "Skip a Stone")],
    );
    const report = await runConceptCheck(["stone skipping", "skip stones"], dependencies(api));
    expect(report.failures).toEqual([{ phrase: "stone skipping", error: "HTTP 429" }]);
    expect(report.attempts.map((attempt) => attempt.universeId)).toEqual([1]);
  });

  it("keeps every result of a phrase with no usable words", async () => {
    const { api } = fakeApi(
      {
        "stone skipping": { "": { games: [found(1)], nextPageToken: null } },
        io: { "": { games: [found(5)], nextPageToken: null } },
      },
      [detail(1, "Skip a Stone"), detail(5, "Arena Royale")],
    );
    const report = await runConceptCheck(["stone skipping", "io"], dependencies(api));
    expect(report.attempts.map((attempt) => attempt.name)).toEqual(["Skip a Stone", "Arena Royale"]);
    expect(report.summary.hidden).toBe(0);
  });

  it("keeps the results of a phrase in another language beside English ones", async () => {
    const { api } = fakeApi(
      {
        "tile sequence": { "": { games: [found(1)], nextPageToken: null } },
        타일: { "": { games: [found(5)], nextPageToken: null } },
      },
      [detail(1, "Tile Sequence Obby"), detail(5, "시퀀스 타일")],
    );
    const report = await runConceptCheck(["tile sequence", "타일"], dependencies(api));
    expect(report.attempts.map((attempt) => attempt.name)).toEqual(["Tile Sequence Obby", "시퀀스 타일"]);
  });

  it("reports history it could not read", async () => {
    const { api } = fakeApi({ "skip stones": { "": { games: [found(1)], nextPageToken: null } } }, [detail(1, "Skip a Stone")]);
    const report = await runConceptCheck(
      ["skip stones"],
      dependencies(api, { readHistory: () => Promise.reject(new Error("connect ECONNREFUSED")) }),
    );
    expect(report.history).toEqual({ status: "failed", error: "connect ECONNREFUSED" });
    expect(report.attempts[0].history).toBeNull();
  });

  it("adds the history of tracked attempts, read since the history window", async () => {
    const { api } = fakeApi({ "skip stones": { "": { games: [found(1)], nextPageToken: null } } }, [detail(1, "Skip a Stone")]);
    const tracked: ConceptHistory = {
      firstObservedAt: new Date("2026-10-22T00:00:00Z"),
      peakCcu: 2_000,
      peakDay: new Date("2026-10-23T00:00:00Z"),
      daily: [],
      earlierNames: [],
      sources: ["search"],
    };
    const calls: [number[], Date][] = [];
    const report = await runConceptCheck(
      ["skip stones"],
      dependencies(api, {
        readHistory: async (ids, since) => {
          calls.push([ids, since]);
          return new Map([[1, tracked]]);
        },
      }),
    );
    expect(calls).toEqual([[[1], new Date("2026-08-27T18:00:00Z")]]);
    expect(report.history).toEqual({ status: "read" });
    expect(report.attempts[0].history).toEqual(tracked);
    expect(report.attempts[0].labels).toContain("fading");
  });

  it("skips history without a reader", async () => {
    const { api } = fakeApi({}, []);
    const report = await runConceptCheck(["skip stones"], dependencies(api));
    expect(report.history).toEqual({ status: "skipped", reason: "DATABASE_URL is not set" });
  });

  it("finds no attempt", async () => {
    const { api } = fakeApi({}, []);
    const report = await runConceptCheck(["stone skipping"], dependencies(api));
    expect(report.attempts).toEqual([]);
    expect(report.summary.leader).toBeNull();
    expect(report.failures).toEqual([]);
  });
});
