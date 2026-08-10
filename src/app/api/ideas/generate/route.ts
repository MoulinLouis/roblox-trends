import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings } from "@/db/repository";
import { ensureAppReady } from "@/lib/app-ready";
import { generateDeterministicIdeas, generateOpenAIIdeas } from "@/lib/ideas";

const requestSchema = z.object({ mode: z.enum(["deterministic", "openai"]) });

export async function POST(request: Request) {
  try {
    await ensureAppReady();
    const { mode } = requestSchema.parse(await request.json());
    const settings = await getSettings();
    const count = mode === "openai" ? await generateOpenAIIdeas(settings) : await generateDeterministicIdeas(settings);
    return NextResponse.json({ count });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Idea generation failed" }, { status: 400 });
  }
}
