import { describe, expect, it } from "vitest";
import type { ChartPresence, VersionRecord } from "@/db/game-view";
import { buildTimeline } from "./timeline";

const at = (day: number) => new Date(Date.UTC(2026, 9, day));

describe("buildTimeline", () => {
  it("lists renames, description and thumbnail changes and chart entries, newest first", () => {
    const versions: VersionRecord[] = [
      { kind: "metadata", name: "Fake an Egg", observedAt: at(10) },
      { kind: "thumbnail", name: null, observedAt: at(11) },
      { kind: "metadata", name: "Fake an Egg", observedAt: at(12) },
      { kind: "metadata", name: "[UPD] Fake an Egg", observedAt: at(14) },
      { kind: "thumbnail", name: null, observedAt: at(15) },
    ];
    const charts: ChartPresence[] = [
      { sortId: "up-and-coming", firstSeenAt: at(13), lastSeenAt: at(20), bestRank: 4, bestRankRecent: null, hoursRecent: 0 },
    ];
    expect(buildTimeline(versions, charts)).toEqual([
      { at: at(15), label: "Thumbnail changed" },
      { at: at(14), label: "Renamed “[UPD] Fake an Egg”" },
      { at: at(13), label: "Entered Up & Coming (best #4)" },
      { at: at(12), label: "Description changed" },
      { at: at(10), label: "Tracked as “Fake an Egg”" },
    ]);
  });
});
