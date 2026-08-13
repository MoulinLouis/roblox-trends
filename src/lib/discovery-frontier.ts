import {
  getDiscoveryFrontierStates,
  saveDiscoveryFrontierStates,
  type DiscoveryFrontierRow,
} from "@/db/repository";
import { RISING_GAMES_CONFIG } from "./config";
import { getRolimonsGames, type RolimonsGame } from "./api/rolimons";
import type { DiscoveryFrontierState } from "./rising-game-types";

const HOUR = 60 * 60 * 1_000;

export async function scanDiscoveryFrontier(now = new Date()): Promise<{
  scanned: number;
  stored: number;
  candidates: number;
}> {
  const [games, existingRows] = await Promise.all([
    getRolimonsGames(),
    getDiscoveryFrontierStates(),
  ]);
  const existingByPlace = new Map(existingRows.map((row) => [row.placeId, row]));
  const states = games
    .filter((game) => game.ccu >= RISING_GAMES_CONFIG.frontier.minimumStoredCcu)
    .map((game) => evaluateDiscoveryFrontierGame(game, existingByPlace.get(game.placeId), now));
  await saveDiscoveryFrontierStates(states);
  return {
    scanned: games.length,
    stored: states.length,
    candidates: states.filter((state) => state.qualifies).length,
  };
}

export function evaluateDiscoveryFrontierGame(
  game: RolimonsGame,
  existing: Pick<
    DiscoveryFrontierRow,
    "currentCcu" | "peakCcu" | "history" | "firstSeenAt" | "observations"
  > | undefined,
  now: Date,
): DiscoveryFrontierState {
  const cutoff = now.getTime() - RISING_GAMES_CONFIG.frontier.maximumHistoryHours * HOUR;
  const history = (existing?.history ?? [])
    .filter((point) => new Date(point.at).getTime() >= cutoff && new Date(point.at).getTime() < now.getTime());
  history.push({ at: now.toISOString(), ccu: game.ccu });

  const oneHour = frontierWindow(history, 1);
  const threeHours = frontierWindow(history, 3);
  const sixHours = frontierWindow(history, 6);
  const previousCcu = existing?.currentCcu ?? game.ccu;
  const priorPeak = existing?.peakCcu ?? 0;
  const crossedMilestone = [...RISING_GAMES_CONFIG.ccuMilestones]
    .reverse()
    .find((milestone) => previousCcu < milestone && game.ccu >= milestone) ?? null;
  const newHigh =
    priorPeak > 0 &&
    game.ccu >= priorPeak * RISING_GAMES_CONFIG.frontier.minimumNewHighRatio &&
    game.ccu - priorPeak >= RISING_GAMES_CONFIG.frontier.minimumNewHighGain;
  const hasMomentum = Boolean(
    (oneHour &&
      oneHour.gain >= RISING_GAMES_CONFIG.frontier.minimumGain1h &&
      oneHour.growth >= RISING_GAMES_CONFIG.frontier.minimumGrowth1h) ||
    (threeHours &&
      threeHours.gain >= RISING_GAMES_CONFIG.frontier.minimumGain3h &&
      threeHours.growth >= RISING_GAMES_CONFIG.frontier.minimumGrowth3h) ||
    (sixHours &&
      sixHours.gain >= RISING_GAMES_CONFIG.frontier.minimumGain6h &&
      sixHours.growth >= RISING_GAMES_CONFIG.frontier.minimumGrowth6h),
  );
  const immediateDiscovery =
    game.ccu >= RISING_GAMES_CONFIG.frontier.immediateDiscoveryCcu &&
    (!existing || existing.observations <= 1);
  const qualifies =
    immediateDiscovery ||
    (game.ccu >= RISING_GAMES_CONFIG.frontier.minimumCandidateCcu &&
      (hasMomentum || crossedMilestone !== null || newHigh));
  const strongestGain = Math.max(0, oneHour?.gain ?? 0, threeHours?.gain ?? 0, sixHours?.gain ?? 0);
  const strongestGrowth = Math.max(0, oneHour?.growth ?? 0, threeHours?.growth ?? 0, sixHours?.growth ?? 0);
  const weights = RISING_GAMES_CONFIG.frontier.scoreWeights;
  let score = Math.min(
    weights.currentCcuMaximum,
    Math.log10(game.ccu / RISING_GAMES_CONFIG.frontier.minimumStoredCcu + 1) *
      weights.currentCcuLogMultiplier,
  );
  score += Math.min(weights.gainMaximum, Math.log10(strongestGain + 1) * weights.gainLogMultiplier);
  score += Math.min(weights.growthMaximum, strongestGrowth / weights.growthDivisor);
  if (crossedMilestone) score += weights.milestone;
  if (newHigh) score += weights.newHigh;
  if (immediateDiscovery) {
    score += weights.immediateDiscovery;
  }

  return {
    placeId: game.placeId,
    name: game.name,
    thumbnailUrl: game.thumbnailUrl || null,
    currentCcu: game.ccu,
    previousCcu,
    peakCcu: Math.max(priorPeak, game.ccu),
    score: Math.min(100, Math.round(score)),
    qualifies,
    gain1h: oneHour?.gain ?? null,
    growth1h: oneHour?.growth ?? null,
    gain3h: threeHours?.gain ?? null,
    growth3h: threeHours?.growth ?? null,
    gain6h: sixHours?.gain ?? null,
    growth6h: sixHours?.growth ?? null,
    crossedMilestone,
    newHigh,
    history,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    observations: (existing?.observations ?? 0) + 1,
  };
}

function frontierWindow(
  history: Array<{ at: string; ccu: number }>,
  hours: 1 | 3 | 6,
): { gain: number; growth: number } | null {
  const current = history.at(-1);
  if (!current) return null;
  const currentAt = new Date(current.at).getTime();
  const target = currentAt - hours * HOUR;
  const baseline = [...history].reverse().find((point) => new Date(point.at).getTime() <= target);
  if (!baseline) return null;
  const actualHours = (currentAt - new Date(baseline.at).getTime()) / HOUR;
  if (actualHours > hours + RISING_GAMES_CONFIG.frontier.windowToleranceHours) return null;
  const gain = current.ccu - baseline.ccu;
  return {
    gain,
    growth: baseline.ccu > 0 ? Math.round((gain / baseline.ccu) * 1_000) / 10 : 0,
  };
}
