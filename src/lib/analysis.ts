import { eq, notInArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { loadGameDataset, type GameDatasetItem } from "@/db/repository";
import { gameAnalyses, trendGames, trendHistory, trends } from "@/db/schema";
import {
  calculateGameMetrics,
  calculateOpportunity,
  calculateSaturation,
  calculateTrendScore,
  calculateTrendStage,
  protectedGrowth,
} from "./scoring";
import type { AppSettings, GameTag, TrendMetrics } from "./types";
import { generateDeterministicIdeas } from "./ideas";
import { logger } from "./logger";
import { normalizeTitle } from "./classification";
import { ROBLOX_EVENT_MARKERS } from "./config";

interface TrendCandidate {
  id: string;
  label: string;
  tags: GameTag[];
  games: GameDatasetItem[];
}

export async function analyzeTrends(settings: AppSettings, now = new Date()): Promise<{ games: number; trends: number }> {
  const database = getDatabase();
  const dataset = await loadGameDataset();
  const analysisByGame = new Map<string, ReturnType<typeof calculateGameMetrics>>();
  for (const item of dataset) {
    const recentMetadataCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const recentTitles = item.metadataHistory
      .filter((entry) => entry.observedAt.getTime() >= recentMetadataCutoff)
      .map((entry) => entry.name.toLowerCase());
    const metadataEventRisk = recentTitles.some((title) =>
      ROBLOX_EVENT_MARKERS.some((marker) => title.includes(marker)),
    );
    const metrics = calculateGameMetrics(item.snapshots, item.game.createdAt, settings, now, {
      metadataEventRisk,
    });
    analysisByGame.set(item.game.universeId, metrics);
    await database
      .insert(gameAnalyses)
      .values({
        universeId: item.game.universeId,
        metrics,
        momentumScore: metrics.momentum.score,
        analyzedAt: now,
      })
      .onConflictDoUpdate({
        target: gameAnalyses.universeId,
        set: { metrics, momentumScore: metrics.momentum.score, analyzedAt: now },
      });
  }

  const candidates = buildTrendCandidates(dataset, analysisByGame, settings, now);
  for (const candidate of candidates) {
    const metrics = calculateTrendMetricsAt(candidate.games, now, settings);
    const stage = calculateTrendStage(metrics, settings);
    const trendScore = calculateTrendScore(metrics);
    const saturationScore = calculateSaturation(metrics);
    const opportunity = calculateOpportunity(
      trendScore,
      saturationScore,
      candidate.tags,
      settings.developerProfile,
      settings,
    );
    await database
      .insert(trends)
      .values({
        id: candidate.id,
        label: candidate.label,
        tags: candidate.tags,
        stage,
        trendScore,
        saturationScore,
        opportunityScore: opportunity.score,
        metrics,
        scoreBreakdown: opportunity.breakdown,
        saturationExplanation: saturationExplanation(metrics, saturationScore),
        analyzedAt: now,
      })
      .onConflictDoUpdate({
        target: trends.id,
        set: {
          label: candidate.label,
          tags: candidate.tags,
          stage,
          trendScore,
          saturationScore,
          opportunityScore: opportunity.score,
          metrics,
          scoreBreakdown: opportunity.breakdown,
          saturationExplanation: saturationExplanation(metrics, saturationScore),
          analyzedAt: now,
        },
      });
    await database.delete(trendGames).where(eq(trendGames.trendId, candidate.id));
    if (candidate.games.length) {
      await database.insert(trendGames).values(
        candidate.games.map((item) => ({ trendId: candidate.id, universeId: item.game.universeId })),
      );
    }
    for (let daysAgo = 7; daysAgo >= 0; daysAgo -= 1) {
      const dayAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      dayAt.setUTCHours(0, 0, 0, 0);
      const historicalMetrics = calculateTrendMetricsAt(candidate.games, dayAt, settings);
      const historicalStage = calculateTrendStage(historicalMetrics, settings);
      await database
        .insert(trendHistory)
        .values({
          trendId: candidate.id,
          dayAt,
          stage: historicalStage,
          trendScore: calculateTrendScore(historicalMetrics),
          saturationScore: calculateSaturation(historicalMetrics),
          combinedCcu: historicalMetrics.combinedCcu,
          gameCount: historicalMetrics.gameCount,
        })
        .onConflictDoUpdate({
          target: [trendHistory.trendId, trendHistory.dayAt],
          set: {
            stage: historicalStage,
            trendScore: calculateTrendScore(historicalMetrics),
            saturationScore: calculateSaturation(historicalMetrics),
            combinedCcu: historicalMetrics.combinedCcu,
            gameCount: historicalMetrics.gameCount,
          },
        });
    }
  }
  if (candidates.length) {
    await database.delete(trends).where(notInArray(trends.id, candidates.map((candidate) => candidate.id)));
  } else {
    await database.delete(trends);
  }
  await generateDeterministicIdeas(settings);
  logger.info("Analysis completed", { games: dataset.length, trends: candidates.length });
  return { games: dataset.length, trends: candidates.length };
}

function buildTrendCandidates(
  dataset: GameDatasetItem[],
  analysisByGame: Map<string, ReturnType<typeof calculateGameMetrics>>,
  settings: AppSettings,
  now: Date,
): TrendCandidate[] {
  const groups = new Map<string, { tags: GameTag[]; games: Set<GameDatasetItem> }>();
  for (const item of dataset) {
    for (const tag of item.tags) addGroup(groups, [tag], item);
    const themes = item.tags.filter((tag) => tag.dimension === "theme");
    const mechanics = item.tags.filter((tag) => tag.dimension !== "theme");
    for (const mechanic of mechanics) {
      for (const theme of themes) addGroup(groups, [mechanic, theme], item);
    }
  }
  addRisingPhraseGroups(groups, dataset, settings, now);
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: group.tags.map((tag) => tag.tag).join(" + "),
      tags: group.tags,
      games: [...group.games],
    }))
    .filter((candidate) => {
      const bestMomentum = Math.max(
        0,
        ...candidate.games.map((item) => analysisByGame.get(item.game.universeId)?.momentum.score ?? 0),
      );
      const combinedCcu = candidate.games.reduce((sum, item) => sum + (item.snapshots.at(-1)?.ccu ?? 0), 0);
      return (
        combinedCcu >= settings.thresholds.minimumBaselineCcu &&
        (candidate.games.length >= 2 || bestMomentum >= settings.thresholds.breakoutMomentum)
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const PHRASE_STOP_WORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "is", "my", "of", "on", "or", "the", "to", "with", "your",
  "game", "new", "update", "updated", "event", "codes", "official", "beta", "alpha", "free",
]);

export function extractTitlePhrases(title: string): string[] {
  const tokens = normalizeTitle(title)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => token.length >= 3 && !PHRASE_STOP_WORDS.has(token));
  const phrases = new Set<string>();
  for (const token of tokens) phrases.add(token);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return [...phrases];
}

function addRisingPhraseGroups(
  groups: Map<string, { tags: GameTag[]; games: Set<GameDatasetItem> }>,
  dataset: GameDatasetItem[],
  settings: AppSettings,
  now: Date,
): void {
  const knownTerms = new Set(
    Object.values(settings.taxonomy)
      .flat()
      .flatMap((entry) => [entry.tag, ...entry.aliases])
      .map((term) => term.toLowerCase()),
  );
  const phraseGames = new Map<string, Set<GameDatasetItem>>();
  for (const item of dataset) {
    for (const phrase of extractTitlePhrases(item.game.normalizedTitle)) {
      if (knownTerms.has(phrase)) continue;
      const matches = phraseGames.get(phrase) ?? new Set<GameDatasetItem>();
      matches.add(item);
      phraseGames.set(phrase, matches);
    }
  }
  for (const [phrase, matches] of phraseGames) {
    const items = [...matches];
    const creators = new Set(items.map((item) => item.game.creatorId)).size;
    const newCount = items.filter(
      (item) => now.getTime() - item.game.firstSeenAt.getTime() <= 7 * 24 * 60 * 60 * 1000,
    ).length;
    const olderCount = items.length - newCount;
    if (items.length < 2 || creators < 2 || newCount < 2 || newCount < olderCount * 1.5) continue;
    const label = phrase.replace(/\b\w/g, (letter) => letter.toUpperCase());
    const tag: GameTag = { dimension: "theme", tag: label, source: "automatic" };
    groups.set(`phrase--${slugify(phrase)}`, { tags: [tag], games: matches });
  }
}

function addGroup(
  groups: Map<string, { tags: GameTag[]; games: Set<GameDatasetItem> }>,
  inputTags: GameTag[],
  item: GameDatasetItem,
): void {
  const tags = [...inputTags].sort((a, b) => `${a.dimension}:${a.tag}`.localeCompare(`${b.dimension}:${b.tag}`));
  const id = tags.map((tag) => `${tag.dimension}-${slugify(tag.tag)}`).join("--");
  const existing = groups.get(id) ?? { tags, games: new Set<GameDatasetItem>() };
  existing.games.add(item);
  groups.set(id, existing);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function calculateTrendMetricsAt(
  items: GameDatasetItem[],
  at: Date,
  settings: AppSettings,
): TrendMetrics {
  const atTime = at.getTime();
  const visible = items
    .map((item) => ({
      item,
      current: [...item.snapshots].reverse().find((point) => point.collectedAt.getTime() <= atTime),
      baseline: [...item.snapshots]
        .reverse()
        .find((point) => point.collectedAt.getTime() <= atTime - 72 * 60 * 60 * 1000),
    }))
    .filter((entry) => entry.current);
  const combinedCcu = visible.reduce((sum, entry) => sum + (entry.current?.ccu ?? 0), 0);
  const baselineCcu = visible.reduce((sum, entry) => sum + (entry.baseline?.ccu ?? entry.current?.ccu ?? 0), 0);
  const growing = visible.filter((entry) => {
    if (!entry.current || !entry.baseline) return false;
    return (
      protectedGrowth(
        entry.baseline.ccu,
        entry.current.ccu,
        settings.thresholds.minimumBaselineCcu,
        settings.thresholds.minimumAbsoluteGain,
      ) > 5
    );
  }).length;
  const historicalEntries = visible.filter((entry) => entry.baseline).length;
  const leader = Math.max(0, ...visible.map((entry) => entry.current?.ccu ?? 0));
  return {
    gameCount: visible.length,
    creatorCount: new Set(visible.map((entry) => entry.item.game.creatorId)).size,
    combinedCcu,
    combinedGrowth72h: protectedGrowth(
      baselineCcu,
      combinedCcu,
      settings.thresholds.minimumBaselineCcu,
      settings.thresholds.minimumAbsoluteGain,
    ),
    newGames7d: visible.filter(
      (entry) => atTime - entry.item.game.firstSeenAt.getTime() <= 7 * 24 * 60 * 60 * 1000,
    ).length,
    growingShare: visible.length ? (growing / visible.length) * 100 : 0,
    leaderShare: combinedCcu ? (leader / combinedCcu) * 100 : 0,
    historyCoverage: visible.length ? (historicalEntries / visible.length) * 100 : 0,
  };
}

function saturationExplanation(metrics: TrendMetrics, score: number): string {
  if (score >= 70) {
    return `${metrics.newGames7d} new entrants are competing across ${metrics.gameCount} games while demand moved ${Math.round(metrics.combinedGrowth72h)}% in 72 hours.`;
  }
  if (score >= 45) {
    return `Supply is building: ${metrics.gameCount} games and ${metrics.creatorCount} creators now share the format.`;
  }
  if (metrics.historyCoverage < 50) {
    return `The signal is still gathering history: ${Math.round(metrics.historyCoverage)}% of related games have a 72-hour baseline, so saturation is not inferred yet.`;
  }
  return `Competition remains limited and ${Math.round(metrics.growingShare)}% of related games are still growing.`;
}
