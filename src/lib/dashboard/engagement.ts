import type { ChartPresence, EngagementWindow, VoteReading } from "@/db/game-view";
import { GAME_VIEW_CONFIG } from "@/lib/config";

export interface EngagementSignals {
  windowHours: number | null;
  newVisits: number | null;
  sessionMinutes: number | null;
  favoritesPerThousandVisits: number | null;
  likeRatio: number | null;
  upVotes: number | null;
  downVotes: number | null;
  // Best ranks over the recent hours: earning above playing means the game earns more than its popularity.
  earningRank: number | null;
  playingRank: number | null;
  revisitedRank: number | null;
  revisitedHours: number;
}

type UsageSignals = Pick<EngagementSignals, "windowHours" | "newVisits" | "sessionMinutes" | "favoritesPerThousandVisits">;

// Average concurrent players × minutes gives player-minutes; divided by the visits started over the same time, it is
// the average session (Little's law).
function usageSignals(window: EngagementWindow | null, config: typeof GAME_VIEW_CONFIG): UsageSignals {
  if (!window) return { windowHours: null, newVisits: null, sessionMinutes: null, favoritesPerThousandVisits: null };
  const windowHours = (window.lastAt.getTime() - window.firstAt.getTime()) / 3_600_000;
  const newVisits = window.lastVisits - window.firstVisits;
  if (windowHours < config.engagementMinimumHours || newVisits <= 0) {
    return { windowHours, newVisits, sessionMinutes: null, favoritesPerThousandVisits: null };
  }
  return {
    windowHours,
    newVisits,
    sessionMinutes: window.ccuAverage === null ? null : (window.ccuAverage * windowHours * 60) / newVisits,
    favoritesPerThousandVisits: ((window.lastFavorites - window.firstFavorites) / newVisits) * 1_000,
  };
}

export function engagementSignals(
  window: EngagementWindow | null,
  votes: VoteReading | null,
  charts: readonly ChartPresence[],
  config = GAME_VIEW_CONFIG,
): EngagementSignals {
  const totalVotes = votes ? votes.upVotes + votes.downVotes : 0;
  const chart = (sortId: string) => charts.find((row) => row.sortId === sortId);
  return {
    ...usageSignals(window, config),
    likeRatio: votes && totalVotes > 0 ? votes.upVotes / totalVotes : null,
    upVotes: votes?.upVotes ?? null,
    downVotes: votes?.downVotes ?? null,
    earningRank: chart("top-earning")?.bestRankRecent ?? null,
    playingRank: chart("top-playing-now")?.bestRankRecent ?? null,
    revisitedRank: chart("top-revisited")?.bestRankRecent ?? null,
    revisitedHours: chart("top-revisited")?.hoursRecent ?? 0,
  };
}
