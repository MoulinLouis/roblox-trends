import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppReady } from "@/lib/app-ready";
import { getSettings, saveSettings } from "@/db/repository";

const taxonomyEntrySchema = z.object({ tag: z.string().min(1), aliases: z.array(z.string().min(1)) });
const settingsSchema = z.object({
  thresholds: z.object({
    minimumBaselineCcu: z.number().min(0),
    minimumAbsoluteGain: z.number().min(0),
    breakoutMomentum: z.number().min(0).max(100),
    saturationMinGames: z.number().int().min(2),
    saturationNewGames7d: z.number().int().min(1),
    saturationFlatGrowth: z.number(),
    hourlyRetentionDays: z.number().int().min(1),
  }),
  momentumWeights: z.object({ ccuGrowth: z.number().min(0), acceleration: z.number().min(0), absoluteGain: z.number().min(0), visitGrowth: z.number().min(0), rankImprovement: z.number().min(0), freshness: z.number().min(0), persistence: z.number().min(0) }),
  opportunityWeights: z.object({ trendStrength: z.number().min(0), differentiation: z.number().min(0), feasibility: z.number().min(0), mobileClarity: z.number().min(0), reusePotential: z.number().min(0), retention: z.number().min(0), durability: z.number().min(0) }),
  collection: z.object({ intervalMinutes: z.literal(60), country: z.string().min(2).max(8), device: z.string().min(2).max(30), charts: z.array(z.string().min(1)).min(1), rolimonsEnabled: z.boolean(), rolimonsCandidates: z.number().int().min(0).max(100) }),
  taxonomy: z.object({ coreLoop: z.array(taxonomyEntrySchema), progression: z.array(taxonomyEntrySchema), reward: z.array(taxonomyEntrySchema), social: z.array(taxonomyEntrySchema), theme: z.array(taxonomyEntrySchema) }),
  developerProfile: z.object({ teamSize: z.number().int().min(1).max(20), robloxExperience: z.enum(["recent", "intermediate", "expert"]), webProductSkill: z.number().min(1).max(5), uiUxSkill: z.number().min(1).max(5), budget: z.enum(["limited", "moderate", "high"]), preferredWeeksMin: z.number().min(1).max(52), preferredWeeksMax: z.number().min(1).max(52), mobileFirst: z.boolean(), prefersClearLoops: z.boolean(), reusableSystems: z.array(z.string()) }),
  discordWebhook: z.union([z.literal(""), z.string().url().startsWith("https://")]),
});

export async function GET() {
  await ensureAppReady();
  return NextResponse.json(await getSettings());
}

export async function PUT(request: Request) {
  try {
    await ensureAppReady();
    const value = settingsSchema.parse(await request.json());
    if (value.developerProfile.preferredWeeksMax < value.developerProfile.preferredWeeksMin) {
      return NextResponse.json({ error: "Maximum production time must be at least the minimum." }, { status: 400 });
    }
    await saveSettings(value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid settings" }, { status: 400 });
  }
}
