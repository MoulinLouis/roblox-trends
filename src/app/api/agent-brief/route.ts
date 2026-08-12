import { getGeneratedArtifact } from "@/db/repository";
import { ensureAppReady } from "@/lib/app-ready";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureAppReady();
  const artifact = await getGeneratedArtifact("agent-decision-brief");
  if (!artifact) return Response.json({ error: "No agent decision brief has been generated yet." }, { status: 404 });

  const format = new URL(request.url).searchParams.get("format");
  if (format === "markdown") {
    return new Response(artifact.textContent ?? "", {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json(artifact.jsonContent, {
    headers: { "Cache-Control": "no-store" },
  });
}
