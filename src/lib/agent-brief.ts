import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getRecentSourceRuns,
  getSettings,
  getTrendLinks,
  getTrends,
  loadGameDataset,
  saveGeneratedArtifact,
  type GameDatasetItem,
  type SourceRunRow,
  type TrendRow,
} from "@/db/repository";
import { protectedGrowth } from "./scoring";
import { IDEA_EVIDENCE_CONFIG } from "./config";
import { calculateDurabilityAssessment, type DurabilityAssessment } from "./idea-evidence";
import type { AppSettings, GameSnapshotPoint, GameTag } from "./types";

const HOUR = 60 * 60 * 1000;
const REPORT_DIRECTORY = ".data/reports";

export type DecisionReadinessLevel = "collecting" | "preliminary" | "actionable" | "strong";

export interface DecisionReadiness {
  level: DecisionReadinessLevel;
  confidenceCap: number;
  explanation: string;
}

export interface CoverageSummary {
  oneHour: number;
  twentyFourHours: number;
  seventyTwoHours: number;
  sevenDays: number;
}

export interface WindowChange {
  hours: number;
  baselineAt: string;
  currentAt: string;
  baselineCcu: number;
  currentCcu: number;
  gain: number;
  growth: number;
  visitsGain: number;
  favoritesGain: number;
  rankImprovement: number;
}

interface GameEvidence {
  universeId: string;
  rootPlaceId: string;
  url: string;
  name: string;
  creator: string;
  createdAt: string;
  firstSeenAt: string;
  ageDays: number;
  currentCcu: number;
  currentRank: number | null;
  currentChart: string | null;
  snapshotCount: number;
  historyHours: number;
  durability: DurabilityAssessment;
  tags: GameTag[];
  verifiedWindows: {
    oneHour: WindowChange | null;
    twentyFourHours: WindowChange | null;
    seventyTwoHours: WindowChange | null;
    sevenDays: WindowChange | null;
  };
}

interface TrendEvidence {
  id: string;
  label: string;
  tags: GameTag[];
  stage: TrendRow["stage"];
  trendScore: number;
  opportunityScore: number;
  saturationScore: number;
  evidenceRank: number;
  confidence: number;
  metrics: TrendRow["metrics"];
  risks: string[];
  supportingGames: GameEvidence[];
}

export interface AgentDecisionBrief {
  schemaVersion: 1;
  generatedAt: string;
  decisionReadiness: DecisionReadiness;
  dataQuality: {
    latestCollectionAt: string | null;
    latestSnapshotBucketAt: string | null;
    earliestSnapshotAt: string | null;
    freshnessMinutes: number | null;
    historyHours: number;
    trackedGames: number;
    snapshotPoints: number;
    collectionIntervalMinutes: number;
    coverage: CoverageSummary;
    warnings: string[];
    recentSourceRuns: Array<{
      source: string;
      status: string;
      items: number;
      error: string | null;
      startedAt: string;
      finishedAt: string | null;
    }>;
  };
  marketWindows: {
    oneHour: AggregateWindow;
    twentyFourHours: AggregateWindow;
    seventyTwoHours: AggregateWindow;
    sevenDays: AggregateWindow;
  };
  formatSignals: TrendEvidence[];
  themeSignals: TrendEvidence[];
  titlePhraseSignals: TrendEvidence[];
  combinations: TrendEvidence[];
  saturationWatch: TrendEvidence[];
  recentAlgorithmBreakouts: Array<GameEvidence & { evidence: WindowChange }>;
  verifiedMovers: Array<
    GameEvidence & { evidenceWindowHours: number; marketRelativeGrowth: number; evidence: WindowChange }
  >;
  humanReviewQuestions: string[];
}

interface AggregateWindow {
  hours: number;
  coveredGames: number;
  baselineCcu: number;
  currentCcu: number;
  gain: number;
  growth: number | null;
}

export function assessDecisionReadiness(input: {
  historyHours: number;
  coverage: CoverageSummary;
  freshnessMinutes: number | null;
  collectionIntervalMinutes: number;
}): DecisionReadiness {
  const stale = input.freshnessMinutes === null || input.freshnessMinutes > input.collectionIntervalMinutes * 3;
  if (!stale && input.historyHours >= 168 && input.coverage.sevenDays >= 30) {
    return {
      level: "strong",
      confidenceCap: 100,
      explanation: "At least seven days of history and meaningful seven-day coverage support persistence and saturation decisions.",
    };
  }
  if (!stale && input.historyHours >= 72 && input.coverage.seventyTwoHours >= 35) {
    return {
      level: "actionable",
      confidenceCap: 85,
      explanation: "At least 72 hours of history support directional recommendations, while a full week is still needed for strong conviction.",
    };
  }
  if (!stale && input.historyHours >= 24 && input.coverage.twentyFourHours >= 35) {
    return {
      level: "preliminary",
      confidenceCap: 60,
      explanation: "A complete daily cycle is available, but acceleration, persistence, and saturation remain provisional.",
    };
  }
  return {
    level: "collecting",
    confidenceCap: stale ? 15 : 30,
    explanation: stale
      ? "The latest snapshot is stale, so no current production recommendation should be made."
      : "Less than one complete daily cycle is covered; treat every signal as a hypothesis rather than a production recommendation.",
  };
}

export function calculateVerifiedWindow(
  points: GameSnapshotPoint[],
  hours: number,
  settings: AppSettings,
): WindowChange | null {
  const current = points.at(-1);
  if (!current) return null;
  const target = current.collectedAt.getTime() - hours * HOUR;
  const baseline = [...points].reverse().find((point) => point.collectedAt.getTime() <= target);
  if (!baseline) return null;
  return {
    hours,
    baselineAt: baseline.collectedAt.toISOString(),
    currentAt: current.collectedAt.toISOString(),
    baselineCcu: baseline.ccu,
    currentCcu: current.ccu,
    gain: current.ccu - baseline.ccu,
    growth: protectedGrowth(
      baseline.ccu,
      current.ccu,
      settings.thresholds.minimumBaselineCcu,
      settings.thresholds.minimumAbsoluteGain,
    ),
    visitsGain: Math.max(0, current.visits - baseline.visits),
    favoritesGain: Math.max(0, current.favorites - baseline.favorites),
    rankImprovement:
      current.rank && baseline.rank ? Math.max(0, baseline.rank - current.rank) : 0,
  };
}

export async function generateAgentDecisionBrief(now = new Date()): Promise<{
  brief: AgentDecisionBrief;
  markdownPath: string;
  jsonPath: string;
}> {
  const [dataset, trendRows, trendLinks, sourceRuns, settings] = await Promise.all([
    loadGameDataset(),
    getTrends(),
    getTrendLinks(),
    getRecentSourceRuns(12),
    getSettings(),
  ]);
  const brief = buildAgentDecisionBrief(dataset, trendRows, trendLinks, sourceRuns, settings, now);
  const directory = resolve(REPORT_DIRECTORY);
  const markdownPath = resolve(directory, "latest-agent-brief.md");
  const jsonPath = resolve(directory, "latest-agent-brief.json");
  const markdown = renderAgentDecisionBrief(brief);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeAtomically(jsonPath, `${JSON.stringify(brief, null, 2)}\n`),
    writeAtomically(markdownPath, markdown),
    saveGeneratedArtifact({
      key: "agent-decision-brief",
      contentType: "application/json",
      textContent: markdown,
      jsonContent: brief as unknown as Record<string, unknown>,
      generatedAt: now,
    }),
  ]);
  return { brief, markdownPath, jsonPath };
}

function buildAgentDecisionBrief(
  dataset: GameDatasetItem[],
  trendRows: TrendRow[],
  trendLinks: Array<{ trendId: string; universeId: string }>,
  sourceRuns: SourceRunRow[],
  settings: AppSettings,
  now: Date,
): AgentDecisionBrief {
  const allPoints = dataset.flatMap((item) => item.snapshots);
  const earliest = minimumDate(allPoints.map((point) => point.collectedAt));
  const latestSnapshot = maximumDate(allPoints.map((point) => point.collectedAt));
  const latestCollection = maximumDate(dataset.map((item) => item.game.lastSeenAt));
  const historyHours = earliest && latestSnapshot
    ? Math.max(0, (latestSnapshot.getTime() - earliest.getTime()) / HOUR)
    : 0;
  const freshnessMinutes = latestCollection
    ? Math.max(0, (now.getTime() - latestCollection.getTime()) / 60_000)
    : null;
  const coverage = coverageSummary(dataset);
  const decisionReadiness = assessDecisionReadiness({
    historyHours,
    coverage,
    freshnessMinutes,
    collectionIntervalMinutes: settings.collection.intervalMinutes,
  });
  const gameEvidence = new Map(
    dataset.map((item) => [item.game.universeId, toGameEvidence(item, settings)]),
  );
  const gameIdsByTrend = new Map<string, string[]>();
  for (const link of trendLinks) {
    const ids = gameIdsByTrend.get(link.trendId) ?? [];
    ids.push(link.universeId);
    gameIdsByTrend.set(link.trendId, ids);
  }
  const evidence = trendRows
    .map((trend) => toTrendEvidence(trend, gameIdsByTrend.get(trend.id) ?? [], gameEvidence, decisionReadiness))
    .sort((a, b) => b.evidenceRank - a.evidenceRank || b.metrics.combinedCcu - a.metrics.combinedCcu);
  const sourceErrors = sourceRuns.filter((run) => run.status === "error" || run.status === "partial");
  const marketWindows = {
    oneHour: aggregateWindow(dataset, 1, settings),
    twentyFourHours: aggregateWindow(dataset, 24, settings),
    seventyTwoHours: aggregateWindow(dataset, 72, settings),
    sevenDays: aggregateWindow(dataset, 168, settings),
  };
  const knownThemes = new Set(settings.taxonomy.theme.map((entry) => entry.tag));
  const warnings = [
    decisionReadiness.explanation,
    ...(sourceErrors.length
      ? [`${sourceErrors.length} recent source runs were partial or failed; inspect source health before trusting coverage.`]
      : []),
    ...(coverage.twentyFourHours < 35
      ? ["Fewer than 35% of tracked games have a verified 24-hour baseline; model 24-hour metrics may describe shorter observation windows."]
      : []),
    ...(coverage.seventyTwoHours < 35
      ? ["Fewer than 35% of tracked games have a verified 72-hour baseline; propagation stages remain low-confidence."]
      : []),
  ];
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    decisionReadiness,
    dataQuality: {
      latestCollectionAt: latestCollection?.toISOString() ?? null,
      latestSnapshotBucketAt: latestSnapshot?.toISOString() ?? null,
      earliestSnapshotAt: earliest?.toISOString() ?? null,
      freshnessMinutes: freshnessMinutes === null ? null : round(freshnessMinutes, 1),
      historyHours: round(historyHours, 1),
      trackedGames: dataset.length,
      snapshotPoints: allPoints.length,
      collectionIntervalMinutes: settings.collection.intervalMinutes,
      coverage,
      warnings,
      recentSourceRuns: sourceRuns.map(serializeSourceRun),
    },
    marketWindows,
    formatSignals: evidence.filter((trend) => trend.tags.length === 1 && trend.tags[0]?.dimension !== "theme").slice(0, 15),
    themeSignals: evidence
      .filter((trend) => trend.tags.length === 1 && knownThemes.has(trend.tags[0]?.tag ?? ""))
      .slice(0, 12),
    titlePhraseSignals: evidence
      .filter(
        (trend) =>
          trend.tags.length === 1 &&
          trend.tags[0]?.dimension === "theme" &&
          !knownThemes.has(trend.tags[0].tag),
      )
      .slice(0, 15),
    combinations: evidence.filter((trend) => trend.tags.length > 1).slice(0, 15),
    saturationWatch: evidence
      .filter(
        (trend) =>
          trend.metrics.historyCoverage >= 35 &&
          (trend.stage === "saturated" || trend.stage === "copy_wave" || trend.saturationScore >= 60),
      )
      .sort((a, b) => b.saturationScore - a.saturationScore)
      .slice(0, 12),
    recentAlgorithmBreakouts: buildRecentAlgorithmBreakouts([...gameEvidence.values()]),
    verifiedMovers: buildVerifiedMovers([...gameEvidence.values()], settings, marketWindows),
    humanReviewQuestions: [
      "Can a child understand the core action and objective from one thumbnail and the first ten seconds?",
      "What specific differentiator prevents the concept from being a replaceable clone?",
      "Can one developer ship the first retention-complete version within two to four weeks?",
      "Does the concept remain viable without licensed intellectual property or a short-lived meme?",
      "Which evidence would falsify the recommendation during a one-room or one-loop vertical-slice test?",
    ],
  };
}

function buildRecentAlgorithmBreakouts(
  games: GameEvidence[],
): AgentDecisionBrief["recentAlgorithmBreakouts"] {
  const config = IDEA_EVIDENCE_CONFIG;
  return games
    .map((game) => {
      const evidence = game.verifiedWindows.twentyFourHours;
      return evidence ? { ...game, evidence } : null;
    })
    .filter((game): game is GameEvidence & { evidence: WindowChange } => Boolean(game))
    .filter(
      (game) =>
        game.ageDays <= config.recentGameMaxAgeDays &&
        game.historyHours >= config.minimumHistoryHours &&
        game.currentCcu >= config.minimumCurrentCcu &&
        game.evidence.gain >= config.minimumGain24h &&
        game.evidence.growth >= config.minimumGrowth24h &&
        game.evidence.visitsGain >= config.minimumNewVisits24h,
    )
    .sort((a, b) => b.evidence.growth - a.evidence.growth || b.evidence.gain - a.evidence.gain)
    .slice(0, 20);
}

function toGameEvidence(item: GameDatasetItem, settings: AppSettings): GameEvidence {
  const current = item.snapshots.at(-1);
  const first = item.snapshots[0];
  return {
    universeId: item.game.universeId,
    rootPlaceId: item.game.rootPlaceId,
    url: `https://www.roblox.com/games/${item.game.rootPlaceId}`,
    name: item.game.name,
    creator: item.game.creatorName,
    createdAt: item.game.createdAt.toISOString(),
    firstSeenAt: item.game.firstSeenAt.toISOString(),
    ageDays: current
      ? round(Math.max(0, (current.collectedAt.getTime() - item.game.createdAt.getTime()) / (24 * HOUR)), 1)
      : 0,
    currentCcu: current?.ccu ?? 0,
    currentRank: current?.rank ?? null,
    currentChart: current?.chart ?? null,
    snapshotCount: item.snapshots.length,
    historyHours: first && current ? round((current.collectedAt.getTime() - first.collectedAt.getTime()) / HOUR, 1) : 0,
    durability: calculateDurabilityAssessment(item.snapshots, item.game.name),
    tags: item.tags,
    verifiedWindows: {
      oneHour: calculateVerifiedWindow(item.snapshots, 1, settings),
      twentyFourHours: calculateVerifiedWindow(item.snapshots, 24, settings),
      seventyTwoHours: calculateVerifiedWindow(item.snapshots, 72, settings),
      sevenDays: calculateVerifiedWindow(item.snapshots, 168, settings),
    },
  };
}

function toTrendEvidence(
  trend: TrendRow,
  supportingIds: string[],
  games: Map<string, GameEvidence>,
  readiness: DecisionReadiness,
): TrendEvidence {
  const breadth = Math.min(100, trend.metrics.gameCount * 20);
  const creatorBreadth = Math.min(100, trend.metrics.creatorCount * 25);
  const rawConfidence =
    trend.metrics.historyCoverage * 0.45 +
    breadth * 0.15 +
    creatorBreadth * 0.25 +
    trend.metrics.growingShare * 0.15;
  const confidence = Math.round(Math.min(readiness.confidenceCap, rawConfidence));
  const evidenceRank = Math.round(trend.opportunityScore * 0.35 + trend.trendScore * 0.3 + confidence * 0.35);
  const risks: string[] = [];
  if (trend.metrics.historyCoverage < 50) risks.push("Less than half of related games have a verified 72-hour baseline");
  if (trend.metrics.gameCount < 3) risks.push("Too few games to establish propagation");
  if (trend.metrics.creatorCount < 3) risks.push("Creator breadth is still limited");
  if (trend.metrics.leaderShare >= 70) risks.push("One leading game holds at least 70% of combined demand");
  if (trend.metrics.growingShare < 50) risks.push("Fewer than half of related games are growing");
  if (trend.saturationScore >= 60 && trend.metrics.historyCoverage >= 35) {
    risks.push("Supply pressure or flat demand indicates saturation risk");
  }
  if (trend.tags.some((tag) => ["Anime", "Brainrot"].includes(tag.tag))) {
    risks.push("The wrapper may depend on licensed IP or a short-lived meme");
  }
  return {
    id: trend.id,
    label: trend.label,
    tags: trend.tags,
    stage: trend.stage,
    trendScore: trend.trendScore,
    opportunityScore: trend.opportunityScore,
    saturationScore: trend.saturationScore,
    evidenceRank,
    confidence,
    metrics: trend.metrics,
    risks,
    supportingGames: supportingIds
      .map((id) => games.get(id))
      .filter((game): game is GameEvidence => Boolean(game))
      .sort((a, b) => b.currentCcu - a.currentCcu)
      .slice(0, 8),
  };
}

function buildVerifiedMovers(
  games: GameEvidence[],
  settings: AppSettings,
  marketWindows: AgentDecisionBrief["marketWindows"],
): AgentDecisionBrief["verifiedMovers"] {
  return games
    .map((game) => {
      const evidence = game.verifiedWindows.twentyFourHours ?? game.verifiedWindows.oneHour;
      const marketGrowth = evidence?.hours === 24
        ? marketWindows.twentyFourHours.growth
        : marketWindows.oneHour.growth;
      return evidence
        ? {
            ...game,
            evidenceWindowHours: evidence.hours,
            marketRelativeGrowth: round(evidence.growth - (marketGrowth ?? 0), 1),
            evidence,
          }
        : null;
    })
    .filter(
      (
        game,
      ): game is GameEvidence & {
        evidenceWindowHours: number;
        marketRelativeGrowth: number;
        evidence: WindowChange;
      } => Boolean(game),
    )
    .filter(
      (game) =>
        game.ageDays <= 365 &&
        game.evidence.gain >= settings.thresholds.minimumAbsoluteGain &&
        game.marketRelativeGrowth > 0,
    )
    .sort((a, b) => {
      const aSignal = a.marketRelativeGrowth + Math.log10(a.evidence.gain + 1) * 20 + Math.max(0, 180 - a.ageDays) / 9;
      const bSignal = b.marketRelativeGrowth + Math.log10(b.evidence.gain + 1) * 20 + Math.max(0, 180 - b.ageDays) / 9;
      return bSignal - aSignal;
    })
    .slice(0, 20);
}

function coverageSummary(dataset: GameDatasetItem[]): CoverageSummary {
  return {
    oneHour: coverageForWindow(dataset, 1),
    twentyFourHours: coverageForWindow(dataset, 24),
    seventyTwoHours: coverageForWindow(dataset, 72),
    sevenDays: coverageForWindow(dataset, 168),
  };
}

function coverageForWindow(dataset: GameDatasetItem[], hours: number): number {
  if (!dataset.length) return 0;
  const covered = dataset.filter((item) => {
    const current = item.snapshots.at(-1);
    if (!current) return false;
    const target = current.collectedAt.getTime() - hours * HOUR;
    return item.snapshots.some((point) => point.collectedAt.getTime() <= target);
  }).length;
  return round((covered / dataset.length) * 100, 1);
}

function aggregateWindow(dataset: GameDatasetItem[], hours: number, settings: AppSettings): AggregateWindow {
  const changes = dataset
    .map((item) => calculateVerifiedWindow(item.snapshots, hours, settings))
    .filter((change): change is WindowChange => Boolean(change));
  const baselineCcu = changes.reduce((sum, change) => sum + change.baselineCcu, 0);
  const currentCcu = changes.reduce((sum, change) => sum + change.currentCcu, 0);
  return {
    hours,
    coveredGames: changes.length,
    baselineCcu,
    currentCcu,
    gain: currentCcu - baselineCcu,
    growth: baselineCcu > 0 ? round(((currentCcu - baselineCcu) / baselineCcu) * 100, 1) : null,
  };
}

function serializeSourceRun(run: SourceRunRow): AgentDecisionBrief["dataQuality"]["recentSourceRuns"][number] {
  return {
    source: run.source,
    status: run.status,
    items: run.items,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export function renderAgentDecisionBrief(brief: AgentDecisionBrief): string {
  const lines = [
    "# Roblox Trend Radar - Agent Decision Brief",
    "",
    `Generated: ${brief.generatedAt}`,
    "",
    "## Decision gate",
    "",
    `**${brief.decisionReadiness.level.toUpperCase()}** - confidence capped at ${brief.decisionReadiness.confidenceCap}/100.`,
    "",
    brief.decisionReadiness.explanation,
    "",
    "Do not present a final production recommendation above this confidence cap. Separate measured facts, inferences, and human judgment.",
    "",
    "## Data quality",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Latest collection | ${brief.dataQuality.latestCollectionAt ?? "None"} |`,
    `| Latest snapshot bucket | ${brief.dataQuality.latestSnapshotBucketAt ?? "None"} |`,
    `| Freshness | ${formatNullable(brief.dataQuality.freshnessMinutes, " minutes")} |`,
    `| History | ${formatNumber(brief.dataQuality.historyHours)} hours |`,
    `| Games | ${formatNumber(brief.dataQuality.trackedGames)} |`,
    `| Snapshot points | ${formatNumber(brief.dataQuality.snapshotPoints)} |`,
    `| 1h coverage | ${formatCoverage(brief.dataQuality.coverage.oneHour)} |`,
    `| 24h coverage | ${formatCoverage(brief.dataQuality.coverage.twentyFourHours)} |`,
    `| 72h coverage | ${formatCoverage(brief.dataQuality.coverage.seventyTwoHours)} |`,
    `| 7d coverage | ${formatCoverage(brief.dataQuality.coverage.sevenDays)} |`,
    "",
    ...brief.dataQuality.warnings.map((warning) => `- ${warning}`),
    "",
    "## Verified market windows",
    "",
    "| Window | Covered games | CCU gain | Growth |",
    "| --- | ---: | ---: | ---: |",
    ...Object.values(brief.marketWindows).map(
      (window) => `| ${window.hours}h | ${window.coveredGames} | ${formatSigned(window.gain)} | ${formatPercent(window.growth)} |`,
    ),
    "",
    "## Broad format signals",
    "",
    renderTrendTable(brief.formatSignals),
    "",
    "## Theme signals",
    "",
    renderTrendTable(brief.themeSignals),
    "",
    "## Rising title words and phrases",
    "",
    renderTrendTable(brief.titlePhraseSignals),
    "",
    "## Mechanic and theme combinations",
    "",
    renderTrendTable(brief.combinations),
    "",
    "## Recent discovery breakouts and durability review",
    "",
    "These games were released within 90 days and reached meaningful scale with a verified 24-hour gain. This demonstrates discovery, not medium-term demand. Durability requires at least 72 hours, several positive daily windows, limited drawdown from peak, and no sharp reversal; seven days provide strong confidence.",
    "",
    renderAlgorithmBreakoutTable(brief.recentAlgorithmBreakouts),
    "",
    "## Verified movers",
    "",
    renderMoverTable(brief.verifiedMovers),
    "",
    "## Saturation watch",
    "",
    renderTrendTable(brief.saturationWatch),
    "",
    "## Human review questions",
    "",
    ...brief.humanReviewQuestions.map((question) => `- ${question}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderAlgorithmBreakoutTable(games: AgentDecisionBrief["recentAlgorithmBreakouts"]): string {
  if (!games.length) return "No recent game passes the complete algorithm-breakout evidence gate yet.";
  return [
    "| Game | Released / age | CCU | 24h growth | Gain | New visits | Rank movement | Durability | Event risk |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...games.map(
      (game) =>
        `| [${escapeCell(game.name)}](${game.url}) | ${game.createdAt.slice(0, 10)} / ${Math.round(game.ageDays)}d | ${formatNumber(game.currentCcu)} | ${formatPercent(game.evidence.growth)} | ${formatSigned(game.evidence.gain)} | ${formatSigned(game.evidence.visitsGain)} | ${game.evidence.rankImprovement > 0 ? `+${game.evidence.rankImprovement}` : "0"} | ${game.durability.durabilityStatus} · ${game.durability.durabilityConfidence}/100 · ${game.historyHours}h | ${game.durability.eventRisk ? "Possible" : "Not detected"} |`,
    ),
  ].join("\n");
}

function renderTrendTable(trends: TrendEvidence[]): string {
  if (!trends.length) return "No qualifying evidence yet.";
  return [
    "| Signal | Stage | Confidence | Opportunity | Saturation | CCU | Games / creators | 72h growth / coverage | Main risk |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...trends.map((trend) => {
      const growth = trend.metrics.historyCoverage >= 35
        ? formatPercent(trend.metrics.combinedGrowth72h)
        : "Not verified";
      return `| ${escapeCell(trend.label)} | ${trend.stage} | ${trend.confidence} | ${trend.opportunityScore} | ${trend.saturationScore} | ${formatNumber(trend.metrics.combinedCcu)} | ${trend.metrics.gameCount} / ${trend.metrics.creatorCount} | ${growth} / ${formatCoverage(trend.metrics.historyCoverage)} | ${escapeCell(trend.risks[0] ?? "No primary risk detected")} |`;
    }),
  ].join("\n");
}

function renderMoverTable(games: AgentDecisionBrief["verifiedMovers"]): string {
  if (!games.length) return "No mover has a verified baseline and minimum absolute gain yet.";
  return [
    "| Game | Released | CCU | Verified window | Growth | Vs market | Gain | Creator |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...games.map((game) => {
      const change = game.evidence;
      return `| [${escapeCell(game.name)}](${game.url}) | ${game.createdAt.slice(0, 10)} | ${formatNumber(game.currentCcu)} | ${game.evidenceWindowHours}h | ${formatPercent(change?.growth ?? null)} | ${formatPercent(game.marketRelativeGrowth)} | ${formatSigned(change?.gain ?? 0)} | ${escapeCell(game.creator)} |`;
    }),
  ].join("\n");
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

function minimumDate(dates: Date[]): Date | null {
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}

function maximumDate(dates: Date[]): Date | null {
  return dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "Not available" : `${value >= 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatCoverage(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatNullable(value: number | null, suffix: string): string {
  return value === null ? "Not available" : `${formatNumber(value)}${suffix}`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
