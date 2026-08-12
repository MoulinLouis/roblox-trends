import { getDataFreshness } from "@/db/repository";
import { ensureAppReady } from "@/lib/app-ready";
import { evaluateDataHealth } from "@/lib/data-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureAppReady();
    const health = evaluateDataHealth(await getDataFreshness());
    return Response.json(health, {
      status: health.status === "healthy" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({
      status: "critical",
      checkedAt: new Date().toISOString(),
      error: "Health check failed.",
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
