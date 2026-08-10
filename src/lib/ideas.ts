import { and, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { getTrends, loadGameDataset, type GameDatasetItem, type TrendRow } from "@/db/repository";
import { ideas } from "@/db/schema";
import { IDEA_EVIDENCE_CONFIG } from "./config";
import { buildIdeaGameEvidence, type IdeaGameEvidence } from "./idea-evidence";
import type { AppSettings, GeneratedIdea } from "./types";

const generatedIdeaSchema = z.object({
  workingTitle: z.string(),
  alternativeTitles: z.array(z.string()).min(2).max(3),
  recommendationScore: z.number().int().min(0).max(100),
  pitch: z.string(),
  coreLoop: z.string(),
  firstTwentySeconds: z.string(),
  progression: z.string(),
  returnReason: z.string(),
  socialComponent: z.string(),
  differentiator: z.string(),
  estimatedScope: z.string(),
  requiredSystems: z.array(z.string()),
  requiredAssets: z.array(z.string()),
  reusableSystems: z.array(z.string()),
  risks: z.array(z.string()),
  relevance: z.string(),
  supportingTrendIds: z.array(z.string()),
  supportingGameIds: z.array(z.string()),
});

const generatedIdeasSchema = z.object({ ideas: z.array(generatedIdeaSchema).min(1).max(5) });

interface EvidenceCandidate {
  item: GameDatasetItem;
  evidence: IdeaGameEvidence;
  searchableText: string;
}

interface ConceptBlueprint {
  id: string;
  trendTerms: string[];
  soloFit: number;
  riskPenalty: number;
  matches: (candidate: EvidenceCandidate) => boolean;
}

interface RankedBlueprint {
  blueprint: ConceptBlueprint;
  evidence: EvidenceCandidate[];
  trends: TrendRow[];
  recommendationScore: number;
}

const conceptBlueprints: ConceptBlueprint[] = [
  {
    id: "cooperative-construction",
    trendTerms: ["tycoon", "cooperation", "build", "upgrade"],
    soloFit: 94,
    riskPenalty: 0,
    matches: (candidate) => {
      const collaborative =
        hasTag(candidate.item, "Cooperation") || /\b(2 player|two player|together|team up|friends)\b/.test(candidate.searchableText);
      const construction =
        hasTag(candidate.item, "Tycoon") || /\b(build|factory|tycoon|construction|base)\b/.test(candidate.searchableText);
      return collaborative && construction;
    },
  },
  {
    id: "mass-collection",
    trendTerms: ["collection", "grow", "animals", "upgrade"],
    soloFit: 90,
    riskPenalty: 4,
    matches: (candidate) => /\b(catch|collect|hunt|grow|fish|harvest|raise)\b/.test(candidate.item.game.normalizedTitle.toLowerCase()),
  },
  {
    id: "camouflage-rounds",
    trendTerms: ["survival", "hide", "paint", "chameleon", "cooperation"],
    soloFit: 80,
    riskPenalty: 2,
    matches: (candidate) => /\b(chameleon|camouflage|blend|paint and seek|paint & seek|hide-and-seek)\b/.test(candidate.searchableText),
  },
  {
    id: "visible-restoration",
    trendTerms: ["build", "upgrade", "cooperation"],
    soloFit: 84,
    riskPenalty: 7,
    matches: (candidate) => /\b(wash|clean|repair|restore|build a house|fix the)\b/.test(candidate.searchableText),
  },
  {
    id: "simple-party",
    trendTerms: ["duels", "arena", "race", "cooperation"],
    soloFit: 72,
    riskPenalty: 9,
    matches: (candidate) => /\b(bingo|duels?|arena|party|50 player)\b/.test(candidate.item.game.normalizedTitle.toLowerCase()),
  },
  {
    id: "progression-escape",
    trendTerms: ["keyboard escape", "+1 per second", "obby", "race"],
    soloFit: 88,
    riskPenalty: 23,
    matches: (candidate) => /\b(keyboard escape|pickaxe swing escape|\+1 .* escape)\b/.test(candidate.searchableText),
  },
];

export async function generateDeterministicIdeas(settings: AppSettings): Promise<number> {
  const [trendRows, dataset] = await Promise.all([getTrends(), loadGameDataset()]);
  const recommendations = buildDeterministicRecommendations(settings, trendRows, dataset).slice(0, 3);
  for (const recommendation of recommendations) await storeIdea(recommendation.id, recommendation.idea);
  if (recommendations.length) await removeObsoleteUnreviewedIdeas(recommendations.map((recommendation) => recommendation.id));
  return recommendations.length;
}

export function buildDeterministicRecommendations(
  settings: AppSettings,
  trendRows: TrendRow[],
  dataset: GameDatasetItem[],
): Array<{ id: string; idea: GeneratedIdea }> {
  const evidenceCandidates = dataset
    .map((item) => {
      const evidence = buildIdeaGameEvidence(item);
      if (!evidence?.algorithmProof) return null;
      return {
        item,
        evidence,
        searchableText: `${item.game.normalizedTitle} ${item.game.description}`.toLowerCase(),
      } satisfies EvidenceCandidate;
    })
    .filter((candidate): candidate is EvidenceCandidate => Boolean(candidate));

  return conceptBlueprints
    .map((blueprint) => rankBlueprint(blueprint, evidenceCandidates, trendRows))
    .filter((candidate): candidate is RankedBlueprint => Boolean(candidate))
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, 3)
    .map((candidate) => ({
      id: `deterministic-blueprint-${candidate.blueprint.id}`,
      idea: createBlueprintIdea(candidate, settings),
    }));
}

function rankBlueprint(
  blueprint: ConceptBlueprint,
  candidates: EvidenceCandidate[],
  trendRows: TrendRow[],
): RankedBlueprint | null {
  const evidence = candidates
    .filter((candidate) => blueprint.matches(candidate))
    .sort((a, b) => b.evidence.evidenceScore - a.evidence.evidenceScore)
    .slice(0, IDEA_EVIDENCE_CONFIG.maximumSupportingGames);
  if (!evidence.length) return null;

  const trends = trendRows
    .filter((trend) => {
      const trendText = `${trend.label} ${trend.tags.map((tag) => tag.tag).join(" ")}`.toLowerCase();
      return blueprint.trendTerms.some((term) => trendText.includes(term));
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 4);
  const strongestEvidence = average(evidence.slice(0, 2).map((candidate) => candidate.evidence.evidenceScore));
  const durabilityEvidence = average(
    evidence.slice(0, 2).map((candidate) => {
      const statusAdjustment = candidate.evidence.durabilityStatus === "durable"
        ? 10
        : candidate.evidence.durabilityStatus === "fragile"
          ? -25
          : 0;
      const eventAdjustment = candidate.evidence.eventRisk ? -10 : 0;
      return Math.max(0, Math.min(100, candidate.evidence.durabilityConfidence + statusAdjustment + eventAdjustment));
    }),
  );
  const proofBreadth = Math.min(100, (evidence.length / 3) * 100);
  const trendOpportunity = trends.length ? average(trends.map((trend) => trend.opportunityScore)) : 40;
  const lowSaturation = trends.length ? 100 - average(trends.map((trend) => trend.saturationScore)) : 50;
  const weights = IDEA_EVIDENCE_CONFIG.recommendationWeights;
  const weightedScore =
    strongestEvidence * weights.algorithmEvidence +
    durabilityEvidence * weights.durability +
    proofBreadth * weights.proofBreadth +
    trendOpportunity * weights.trendOpportunity +
    lowSaturation * weights.lowSaturation +
    blueprint.soloFit * weights.soloFit;
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const recommendationScore = Math.max(0, Math.min(100, Math.round(weightedScore / totalWeight - blueprint.riskPenalty)));
  return { blueprint, evidence, trends, recommendationScore };
}

function createBlueprintIdea(candidate: RankedBlueprint, settings: AppSettings): GeneratedIdea {
  const common = {
    recommendationScore: candidate.recommendationScore,
    estimatedScope: `${settings.developerProfile.preferredWeeksMin}-${settings.developerProfile.preferredWeeksMax} weeks for one developer`,
    relevance: buildRelevance(candidate),
    supportingTrendIds: candidate.trends.map((trend) => trend.id),
    supportingGameIds: candidate.evidence.map(({ evidence }) => evidence.universeId),
    generationMode: "deterministic" as const,
  };
  const reusableEconomy = reusableSystems(settings, ["simulator economy", "tycoon purchase and unlock flow"]);

  switch (candidate.blueprint.id) {
    case "cooperative-construction":
      return {
        ...common,
        workingTitle: "2 Player Build a Rocket",
        alternativeTitles: ["Build a Spaceship Together", "2 Player Rocket Factory"],
        pitch: "Two players gather materials, operate complementary machines, and build one visible rocket piece by piece before launching to a richer planet.",
        coreLoop: "Collect scrap, refine it at two player stations, place a visible rocket module, upgrade the shared base, and launch when the ship is complete.",
        firstTwentySeconds: "The player picks up three glowing scrap pieces, feeds the first machine, and watches the rocket cockpit appear while a second station invites a friend or helper robot.",
        progression: "Each launch unlocks a planet with a new resource, one machine upgrade, and a larger rocket layout; permanent research shortens future builds.",
        returnReason: "Daily planet conditions, rotating rocket parts, and a shared launch streak create retention without requiring constant live content.",
        socialComponent: "Partners control different stations and can swap roles; a helper robot keeps the complete loop playable when the player is alone.",
        differentiator: "Progress is a shared physical object that visibly grows, rather than a line of anonymous tycoon buttons or two players working on separate bases.",
        requiredSystems: ["shared two-player plot", "resource collection", "machine processing", "modular rocket construction", "planet unlocks", "solo helper robot"],
        requiredAssets: ["one modular launch site", "eight rocket modules", "three small planet kits", "resource and machine props", "simple launch effects"],
        reusableSystems: reusableEconomy,
        risks: [
          "The cooperative tycoon signal currently depends heavily on one breakout game",
          "The solo helper must make an empty server enjoyable without removing the benefit of a friend",
          "Confirm that the recent-game growth persists after a verified 72-hour window",
        ],
      };
    case "mass-collection":
      return {
        ...common,
        workingTitle: "Catch 1 Billion Bugs",
        alternativeTitles: ["Catch Every Bug!", "Build a Bug Museum"],
        pitch: "Catch dense bug swarms, improve a simple tool, and turn every discovery into a permanent exhibit inside a museum that visibly grows.",
        coreLoop: "Catch a nearby swarm, choose what to sell or display, buy one tool upgrade, and open a compact habitat with rarer species.",
        firstTwentySeconds: "A large bug swarm crosses the spawn path, the player catches five bugs with one drag, fills the first museum case, and buys a wider net.",
        progression: "Unlock habitats, tool capacity, museum rooms, and a species book; rare weather changes which bugs can appear without relying on egg-opening RNG.",
        returnReason: "Weather-specific species, a rotating rare migration, and museum completion give players concrete reasons to return.",
        socialComponent: "The server cooperates during giant swarm events and players can visit one another's museums without requiring trading at launch.",
        differentiator: "Every capture builds a readable permanent museum, separating the game from generic catch-sell-upgrade simulators and pet inventories.",
        requiredSystems: ["swarm spawning", "mobile catch interaction", "inventory and selling", "museum placement", "tool upgrades", "weather events"],
        requiredAssets: ["twenty low-poly bug models", "three compact habitat kits", "modular museum cases", "three catching tools", "simple swarm effects"],
        reusableSystems: reusableSystems(settings, ["simulator economy", "inventory", "zone unlocks"]),
        risks: [
          "Collection has meaningful competition, so the museum must be central rather than cosmetic",
          "Too many species at launch would expand the art scope beyond a solo schedule",
          "Confirm that the supporting recent games retain demand over 72 hours",
        ],
      };
    case "camouflage-rounds":
      return {
        ...common,
        workingTitle: "Paint to Hide!",
        alternativeTitles: ["Match the Room!", "Color Camouflage"],
        pitch: "Hiders copy a surface color to disappear into the room while seekers inspect suspicious shapes before the safe colors change.",
        coreLoop: "Sample a color, choose a hiding position, survive a short search phase, then spend round rewards on new paint effects and abilities.",
        firstTwentySeconds: "The player taps a bright wall, instantly changes color, hides beside matching furniture, and sees the seeker enter as the timer begins.",
        progression: "Unlock cosmetic paint finishes, small situational abilities, mastery goals, and two increasingly interactive maps without adding combat complexity.",
        returnReason: "Daily camouflage challenges, rotating safe colors, and short mastery tracks vary the same understandable round structure.",
        socialComponent: "Players rotate between hider and seeker roles; a basic AI seeker keeps low-population servers playable.",
        differentiator: "Color sampling creates an immediate visual skill test instead of another prop-hunt inventory or static hiding game.",
        requiredSystems: ["round manager", "surface color sampling", "hider and seeker roles", "visibility checks", "AI seeker fallback", "cosmetic progression"],
        requiredAssets: ["two color-readable room maps", "modular furniture kit", "paint materials", "round UI", "simple reveal effects"],
        reusableSystems: reusableSystems(settings, ["mobile interaction UI", "persistent cosmetic unlocks"]),
        risks: [
          "This is a strong individual breakout rather than a trend confirmed across several creators",
          "Poor map contrast would make hiding feel random instead of skillful",
          "The AI fallback must be tested before relying on multiplayer discovery",
        ],
      };
    case "visible-restoration":
      return {
        ...common,
        workingTitle: "Restore the Giant Castle",
        alternativeTitles: ["Fix the Castle Together", "Build Back the Kingdom"],
        pitch: "Collect scattered materials and repair one ruined castle room by room until the entire kingdom visibly returns to life.",
        coreLoop: "Find a damaged object, complete a short repair action, deliver materials, and unlock the next visible section of the castle.",
        firstTwentySeconds: "The player repairs a broken gate with three pieces and immediately sees villagers return and a new courtyard open.",
        progression: "Permanent tools speed up repairs while restored rooms unlock new material sources, helpers, and cosmetic castle styles.",
        returnReason: "A rotating damaged room and long-term castle completion provide clear return goals.",
        socialComponent: "Players contribute to the same restoration milestone but every task remains possible alone.",
        differentiator: "The whole environment transforms permanently, making progress legible without a generic simulator lane.",
        requiredSystems: ["repair interactions", "material inventory", "environment state changes", "tool upgrades", "shared milestones"],
        requiredAssets: ["one modular ruined castle", "restored variants", "repair props", "three tools", "simple villagers"],
        reusableSystems: reusableSystems(settings, ["simulator economy", "tycoon unlock states"]),
        risks: ["Environment variants increase art work", "Tasks can feel repetitive without strong transformation feedback", "Validate 72-hour demand before expanding beyond one castle"],
      };
    case "simple-party":
      return {
        ...common,
        workingTitle: "50 Player Treasure Hunt",
        alternativeTitles: ["Find It First!", "The Giant Treasure Race"],
        pitch: "A crowd receives one simple picture clue and races through a compact map to touch the matching treasure first.",
        coreLoop: "Read one visual clue, search a small map, claim the object, and spend winnings on clue effects and movement cosmetics.",
        firstTwentySeconds: "A giant treasure icon appears, the map opens immediately, and the player follows a visible crowd toward possible matches.",
        progression: "Unlock clue categories, compact maps, cosmetic trails, and a personal discovery streak.",
        returnReason: "Daily clue sets and short competitive streaks create variety with little content overhead.",
        socialComponent: "Rounds scale from small lobbies to large crowds, with bots filling only the minimum population required for readable competition.",
        differentiator: "Every round uses a child-readable visual objective instead of trivia text or complex party-game rules.",
        requiredSystems: ["round manager", "visual clue selection", "object validation", "scalable spawn logic", "bot fillers", "cosmetic rewards"],
        requiredAssets: ["two compact search maps", "forty reusable objects", "clue icons", "simple reward effects"],
        reusableSystems: reusableSystems(settings, ["round rewards", "mobile HUD"]),
        risks: ["Large-player wording can create a poor first impression in empty servers", "Bots must not make wins feel fake", "The evidence currently comes from a narrow set of recent games"],
      };
    default:
      return {
        ...common,
        workingTitle: "Build the Escape Path",
        alternativeTitles: ["Every Step Builds the Bridge", "Run to Build!"],
        pitch: "Movement creates the path ahead, so players must improve speed while deciding where to build the safest route to the finish.",
        coreLoop: "Move to generate path pieces, place a route choice, reach a checkpoint, and upgrade speed or path stability.",
        firstTwentySeconds: "The first three steps create visible bridge tiles and the player immediately chooses between a safe route and a faster risky shortcut.",
        progression: "New path materials, route abilities, compact worlds, and time-trial mastery replace a flat speed multiplier grind.",
        returnReason: "Daily route layouts and personal best rewards create repeat play without excessive content.",
        socialComponent: "Players can race or combine their generated paths, while every course remains completable alone.",
        differentiator: "Movement changes the level itself, adding a visible decision to the familiar progression-escape loop.",
        requiredSystems: ["movement progression", "runtime path placement", "checkpoints", "route choices", "time trials"],
        requiredAssets: ["three modular course kits", "path materials", "checkpoint effects", "mobile HUD"],
        reusableSystems: reusableSystems(settings, ["simulator progression", "zone unlocks"]),
        risks: ["The source format already has clone-wave characteristics", "Runtime paths require careful mobile performance testing", "Do not proceed unless several independent games sustain growth"],
      };
  }
}

function buildRelevance(candidate: RankedBlueprint): string {
  const lead = candidate.evidence[0].evidence;
  const proofCount = candidate.evidence.length;
  const rankEvidence = lead.rankMovement24h > 0
    ? ` and improved ${lead.rankMovement24h} chart place${lead.rankMovement24h === 1 ? "" : "s"}`
    : " while remaining in a tracked chart";
  const trendEvidence = candidate.trends.length
    ? ` Related signals include ${candidate.trends.slice(0, 3).map((trend) => `${trend.label} (${trend.opportunityScore}/100 opportunity)`).join(", ")}.`
    : "";
  const durabilityEvidence = lead.durabilityStatus === "durable"
    ? `Durability is supported across ${lead.observedDailyWindows} daily windows with ${lead.positiveDailyWindows} positive windows and a ${lead.peakDrawdownPercent.toFixed(1)}% drawdown from peak.`
    : `Durability is ${lead.durabilityStatus}: only ${Math.round(lead.historyHours)} hours are observed, with ${lead.observedDailyWindows} complete daily window${lead.observedDailyWindows === 1 ? "" : "s"}. Treat this as discovery evidence until at least 72 hours are verified.`;
  return `${proofCount} recent supporting game${proofCount === 1 ? " passes" : "s pass"} the discovery-breakout gate. ${lead.name} launched ${Math.round(lead.ageDays)} days ago, reached ${formatCount(lead.currentCcu)} CCU, gained ${formatCount(lead.gain24h)} players (${formatPercent(lead.growth24h)}) in a verified 24-hour window${rankEvidence}. This shows that Roblox discovery can surface the loop, not that demand will persist. ${durabilityEvidence}${trendEvidence}`;
}

function reusableSystems(settings: AppSettings, conceptSystems: string[]): string[] {
  const profileSystems = settings.developerProfile.reusableSystems.map((system) => `${system} systems`);
  return [...new Set([...profileSystems, ...conceptSystems])];
}

function hasTag(item: GameDatasetItem, tag: string): boolean {
  return item.tags.some((candidate) => candidate.tag.toLowerCase() === tag.toLowerCase());
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

async function removeObsoleteUnreviewedIdeas(currentIds: string[]): Promise<void> {
  await getDatabase()
    .delete(ideas)
    .where(
      and(
        eq(ideas.generationMode, "deterministic"),
        notInArray(ideas.id, currentIds),
        eq(ideas.saved, false),
        eq(ideas.rejected, false),
        isNull(ideas.rating),
        eq(ideas.comment, ""),
      ),
    );
}

export async function generateOpenAIIdeas(settings: AppSettings): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const [trends, dataset] = await Promise.all([getTrends(), loadGameDataset()]);
  const games = dataset
    .map((item) => ({ item, evidence: buildIdeaGameEvidence(item) }))
    .filter((entry): entry is { item: GameDatasetItem; evidence: IdeaGameEvidence } => Boolean(entry.evidence))
    .sort((a, b) => b.evidence.evidenceScore - a.evidence.evidenceScore)
    .slice(0, 12)
    .map(({ item, evidence }) => ({
      id: item.game.universeId,
      name: item.game.name,
      tags: item.tags,
      evidence,
    }));
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(generatedIdeaSchema.shape),
          properties: {
            workingTitle: { type: "string" },
            alternativeTitles: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
            recommendationScore: { type: "integer", minimum: 0, maximum: 100 },
            pitch: { type: "string" },
            coreLoop: { type: "string" },
            firstTwentySeconds: { type: "string" },
            progression: { type: "string" },
            returnReason: { type: "string" },
            socialComponent: { type: "string" },
            differentiator: { type: "string" },
            estimatedScope: { type: "string" },
            requiredSystems: { type: "array", items: { type: "string" } },
            requiredAssets: { type: "array", items: { type: "string" } },
            reusableSystems: { type: "array", items: { type: "string" } },
            risks: { type: "array", items: { type: "string" } },
            relevance: { type: "string" },
            supportingTrendIds: { type: "array", items: { type: "string" } },
            supportingGameIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions:
        "Generate ranked Roblox game recommendations for a solo developer, not generic tag combinations. Prioritize recently released games that pass the supplied algorithmProof gate. Provide two or three clear child-readable title alternatives, measured supporting evidence, one meaningful differentiator, and a mobile-first two-to-four-week scope. Use only supplied trend and game IDs. Avoid licensed IP and clone concepts.",
      input: JSON.stringify({ profile: settings.developerProfile, trends: trends.slice(0, 10), games }),
      text: { format: { type: "json_schema", name: "roblox_game_ideas", strict: true, schema } },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`OpenAI request failed with ${response.status}`);
  const payload = (await response.json()) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = payload.output
    ?.flatMap((output) => output.content ?? [])
    .find((content) => content.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI returned no structured output");
  const parsed = generatedIdeasSchema.parse(JSON.parse(text));
  for (const [index, idea] of parsed.ideas.entries()) {
    await storeIdea(`openai-${Date.now()}-${index}`, { ...idea, generationMode: "openai" });
  }
  return parsed.ideas.length;
}

async function storeIdea(id: string, idea: GeneratedIdea): Promise<void> {
  await getDatabase()
    .insert(ideas)
    .values({ id, ...idea })
    .onConflictDoUpdate({
      target: ideas.id,
      set: {
        workingTitle: idea.workingTitle,
        alternativeTitles: idea.alternativeTitles,
        recommendationScore: idea.recommendationScore,
        pitch: idea.pitch,
        coreLoop: idea.coreLoop,
        firstTwentySeconds: idea.firstTwentySeconds,
        progression: idea.progression,
        returnReason: idea.returnReason,
        socialComponent: idea.socialComponent,
        differentiator: idea.differentiator,
        estimatedScope: idea.estimatedScope,
        requiredSystems: idea.requiredSystems,
        requiredAssets: idea.requiredAssets,
        reusableSystems: idea.reusableSystems,
        risks: idea.risks,
        relevance: idea.relevance,
        supportingTrendIds: idea.supportingTrendIds,
        supportingGameIds: idea.supportingGameIds,
        generationMode: idea.generationMode,
        updatedAt: new Date(),
      },
    });
}
