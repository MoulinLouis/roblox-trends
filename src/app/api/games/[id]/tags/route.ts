import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppReady } from "@/lib/app-ready";
import { replaceManualTags } from "@/db/repository";

const payloadSchema = z.object({
  tags: z.array(z.object({
    dimension: z.enum(["coreLoop", "progression", "reward", "social", "theme"]),
    tag: z.string().trim().min(1).max(50),
    source: z.literal("manual"),
  })).max(30),
});

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureAppReady();
    const { tags } = payloadSchema.parse(await request.json());
    await replaceManualTags((await params).id, tags);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid tags" }, { status: 400 });
  }
}
