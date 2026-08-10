import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { getTrends, loadGameDataset } from "@/db/repository";
import { ideas, trendGames } from "@/db/schema";
import type { AppSettings, GeneratedIdea, GameTag } from "./types";

const generatedIdeaSchema = z.object({
  workingTitle: z.string(),
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

export async function generateDeterministicIdeas(settings: AppSettings): Promise<number> {
  const trendRows = (await getTrends())
    .filter((trend) => trend.stage !== "saturated" && trend.stage !== "declining")
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 4);
  let created = 0;
  for (const [index, trend] of trendRows.entries()) {
    const links = await getDatabase().select().from(trendGames).where(eq(trendGames.trendId, trend.id));
    const idea = deterministicTemplate(trend.id, trend.label, trend.tags, links.map((link) => link.universeId), settings, index);
    await storeIdea(`deterministic-${trend.id}`, idea);
    created += 1;
  }
  return created;
}

function deterministicTemplate(
  trendId: string,
  trendLabel: string,
  tags: GameTag[],
  supportingGameIds: string[],
  settings: AppSettings,
  index: number,
): GeneratedIdea {
  const mechanic = tags.find((tag) => tag.dimension !== "theme")?.tag ?? tags[0]?.tag ?? "Collection";
  const existingTheme = tags.find((tag) => tag.dimension === "theme")?.tag;
  const lowCompetitionThemes = ["Cozy Deep Sea", "Tiny Robots", "Kawaii Kitchen", "Pocket Dinosaurs"];
  const theme = existingTheme ?? lowCompetitionThemes[index % lowCompetitionThemes.length];
  const reusable = settings.developerProfile.reusableSystems.filter((system) =>
    ["simulator", "tycoon", mechanic.toLowerCase()].includes(system.toLowerCase()),
  );
  const systems = ["tap interaction", "inventory", "upgrade economy", "daily rewards"];
  if (/steal|theft/i.test(mechanic)) systems.push("base protection");
  if (/lucky|egg|roll|rng/i.test(mechanic)) systems.push("weighted reward table");
  return {
    workingTitle: `${theme} ${mechanic} Workshop`,
    pitch: `Turn the rising ${trendLabel} pattern into a mobile-first workshop where every reward visibly changes the player's tiny world.`,
    coreLoop: `Complete a ten-second ${mechanic.toLowerCase()} action, collect a visible reward, improve one station, and unlock the next compact zone.`,
    firstTwentySeconds:
      "The player sees one oversized objective, taps or drags once, receives a dramatic reward reveal, and buys a first upgrade without opening a menu.",
    progression:
      "Five short zones, permanent tool upgrades, a lightweight collection book, and one optional rebirth after the first complete run.",
    returnReason: "Daily collection variants and a rotating three-step challenge create a reason to return without live-ops overhead.",
    socialComponent: "Players can compare workshops, trigger a shared two-minute boost, and visit friends without synchronous dependency.",
    differentiator: `A ${theme.toLowerCase()} wrapper with a visible workspace replaces the common flat simulator lane and makes progress readable at a glance.`,
    estimatedScope: `${settings.developerProfile.preferredWeeksMin}-${settings.developerProfile.preferredWeeksMax} weeks for one developer`,
    requiredSystems: systems,
    requiredAssets: ["one modular environment kit", "six reward models", "four simple character animations", "UI icon set"],
    reusableSystems: reusable.length ? reusable : ["simulator economy", "tycoon purchase pads"],
    risks: [
      "The source trend may cool before launch",
      "Reward pacing needs device testing",
      existingTheme === "Brainrot" ? "The wrapper is meme-dependent and needs an original fallback theme" : "The theme must read clearly in thumbnails",
    ],
    relevance: `${trendLabel} is currently credible, but the concept narrows the scope and adds a lower-competition wrapper suitable for a solo launch.`,
    supportingTrendIds: [trendId],
    supportingGameIds: supportingGameIds.slice(0, 4),
    generationMode: "deterministic",
  };
}

export async function generateOpenAIIdeas(settings: AppSettings): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const trends = (await getTrends()).slice(0, 8);
  const games = (await loadGameDataset())
    .sort((a, b) => (b.analysis?.momentumScore ?? 0) - (a.analysis?.momentumScore ?? 0))
    .slice(0, 12)
    .map((item) => ({ id: item.game.universeId, name: item.game.name, tags: item.tags }));
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
        "Generate scoped Roblox game concepts for a solo developer. Use only supplied trend and game IDs. Avoid licensed IP. Keep every idea feasible in two to four weeks and mobile-first.",
      input: JSON.stringify({ profile: settings.developerProfile, trends, games }),
      text: { format: { type: "json_schema", name: "roblox_game_ideas", strict: true, schema } },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`OpenAI request failed with ${response.status}`);
  const payload = (await response.json()) as {
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
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
