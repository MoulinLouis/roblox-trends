import { describe, expect, it } from "vitest";
import { diagnose, summarize } from "./diagnosis";
import type { ConceptAttempt } from "./types";

// The stone-skipping check of 2026-10-26.
function attempt(universeId: number, name: string, created: string, values: Partial<ConceptAttempt> & { peak?: number }): ConceptAttempt {
  const { peak, ...rest } = values;
  const upVotes = rest.upVotes ?? 0;
  const downVotes = rest.downVotes ?? 0;
  return {
    universeId,
    name,
    description: "",
    creatorName: "Studio",
    created: new Date(`${created}T00:00:00Z`),
    updated: new Date("2026-10-20T00:00:00Z"),
    visits: 0,
    playing: 0,
    favorites: 0,
    upVotes,
    downVotes,
    likeRatio: upVotes + downVotes ? upVotes / (upVotes + downVotes) : null,
    matchedPhrases: ["stone skipping"],
    history:
      peak === undefined
        ? null
        : { firstObservedAt: new Date(`${created}T12:00:00Z`), peakCcu: peak, peakDay: new Date(`${created}T00:00:00Z`), daily: [], earlierNames: [], sources: ["search"] },
    labels: [],
    ...rest,
  };
}

const a = attempt(1, "Skip a Rock!", "2026-01-05", { visits: 37_605, upVotes: 75, downVotes: 33 });
const b = attempt(2, "Skip A Stone", "2026-04-05", { visits: 6_720, upVotes: 18, downVotes: 9 });
const c = attempt(3, "Skip a Stone!", "2026-09-02", { visits: 9_308, upVotes: 21, downVotes: 3 });
const d = attempt(4, "+1 Stone Skipping", "2026-09-05", { visits: 67_362_222, playing: 17_579, upVotes: 90_073, downVotes: 3_057, peak: 41_000 });
const e = attempt(5, "🏞️ Skip a stone", "2026-09-05", { visits: 40_182, upVotes: 633, downVotes: 48 });
const f = attempt(6, "+1 TNT Skipping", "2026-10-13", { visits: 141_743, playing: 65, upVotes: 33, downVotes: 13, peak: 1_200 });
const g = attempt(7, "Skip Stones For Eggs", "2026-10-06", { visits: 1_366 });

describe("diagnose", () => {
  it("labels the stone-skipping attempts", () => {
    const labels = Object.fromEntries(diagnose([a, b, c, d, e, f, g]).map((row) => [row.name, row.labels]));
    expect(labels).toEqual({
      "Skip a Rock!": [],
      "Skip A Stone": ["no audience"],
      "Skip a Stone!": ["liked but stuck"],
      "+1 Stone Skipping": ["leader"],
      "🏞️ Skip a stone": ["liked but stuck"],
      "+1 TNT Skipping": ["fading"],
      "Skip Stones For Eggs": ["no audience"],
    });
  });

  it("never calls a game without votes liked", () => {
    const [row] = diagnose([a, g]).filter((item) => item.universeId === g.universeId);
    expect(row.likeRatio).toBeNull();
    expect(row.labels).toEqual(["no audience"]);
  });

  it("names the most-visited attempt leader when none has players", () => {
    const leaders = diagnose([a, b, { ...d, playing: 0 }]).filter((row) => row.labels.includes("leader"));
    expect(leaders.map((row) => row.universeId)).toEqual([d.universeId]);
  });

  it("lets a leader fade", () => {
    const keyboard = attempt(8, "+1 Speed Keyboard Escape", "2026-01-18", { visits: 900_000_000, playing: 20_000, peak: 268_000 });
    expect(diagnose([keyboard])[0].labels).toEqual(["leader", "fading"]);
  });
});

describe("summarize", () => {
  const now = new Date("2026-10-26T18:00:00Z");

  it("names the first attempt, the leader and the recent ones", () => {
    const summary = summarize(diagnose([g, f, e, d, c, b, a]), { hidden: 40, unavailable: 1 }, now);
    expect(summary).toEqual({
      attempts: 7,
      hidden: 40,
      unavailable: 1,
      firstAttempt: { universeId: 1, name: "Skip a Rock!", created: new Date("2026-01-05T00:00:00Z") },
      leader: { universeId: 4, name: "+1 Stone Skipping", playing: 17_579, visits: 67_362_222, fading: false },
      recent: [{ universeId: 6, name: "+1 TNT Skipping", created: new Date("2026-10-13T00:00:00Z") }],
    });
  });

  it("has no leader and no first attempt without attempts", () => {
    expect(summarize([], { hidden: 3, unavailable: 0 }, now)).toEqual({
      attempts: 0,
      hidden: 3,
      unavailable: 0,
      firstAttempt: null,
      leader: null,
      recent: [],
    });
  });
});
