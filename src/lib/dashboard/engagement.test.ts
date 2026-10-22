import { describe, expect, it } from "vitest";
import type { ChartPresence, EngagementWindow } from "@/db/game-view";
import { engagementSignals } from "./engagement";

const window: EngagementWindow = {
  firstAt: new Date("2026-10-19T00:00:00Z"),
  lastAt: new Date("2026-10-21T00:00:00Z"),
  firstVisits: 100_000,
  lastVisits: 196_000,
  firstFavorites: 5_000,
  lastFavorites: 5_480,
  ccuAverage: 1_000,
};

function chart(sortId: string, bestRankRecent: number | null, hoursRecent: number): ChartPresence {
  const seen = new Date("2026-10-20T00:00:00Z");
  return { sortId, firstSeenAt: seen, lastSeenAt: seen, bestRank: 1, bestRankRecent, hoursRecent };
}

describe("engagementSignals", () => {
  it("estimates the session length and favorites per visit over the window", () => {
    // 1,000 players × 48 h × 60 min / 96,000 visits = 30 minutes; 480 favorites per 96,000 visits = 5 per 1,000.
    expect(engagementSignals(window, null, [])).toMatchObject({
      windowHours: 48,
      newVisits: 96_000,
      sessionMinutes: 30,
      favoritesPerThousandVisits: 5,
    });
  });

  it("needs enough hours and new visits", () => {
    const short = { ...window, lastAt: new Date("2026-10-19T20:00:00Z") };
    expect(engagementSignals(short, null, [])).toMatchObject({ sessionMinutes: null, favoritesPerThousandVisits: null });
    const idle = { ...window, lastVisits: window.firstVisits };
    expect(engagementSignals(idle, null, [])).toMatchObject({ newVisits: 0, sessionMinutes: null });
    expect(engagementSignals(null, null, [])).toMatchObject({ windowHours: null, newVisits: null, sessionMinutes: null });
  });

  it("reads the like ratio and the chart ranks", () => {
    const signals = engagementSignals(null, { upVotes: 950, downVotes: 50, observedAt: window.lastAt }, [
      chart("top-earning", 12, 20),
      chart("top-playing-now", 30, 24),
      chart("top-revisited", null, 40),
    ]);
    expect(signals).toMatchObject({
      likeRatio: 0.95,
      upVotes: 950,
      downVotes: 50,
      earningRank: 12,
      playingRank: 30,
      revisitedRank: null,
      revisitedHours: 40,
    });
    expect(engagementSignals(null, { upVotes: 0, downVotes: 0, observedAt: window.lastAt }, []).likeRatio).toBeNull();
    expect(engagementSignals(null, null, []).revisitedHours).toBe(0);
  });
});
