import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppReady } from "@/lib/app-ready";
import { updateIdea } from "@/db/repository";

const patchSchema = z.object({
  saved: z.boolean().optional(),
  rejected: z.boolean().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  comment: z.string().max(2000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureAppReady();
    await updateIdea((await params).id, patchSchema.parse(await request.json()));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid idea update" }, { status: 400 });
  }
}
