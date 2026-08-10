import type { Metadata } from "next";
import { IdeaLab } from "@/components/IdeaLab";
import { PageHeading } from "@/components/ui";
import { buildIdeaGameEvidence } from "@/lib/idea-evidence";
import { loadApplicationData } from "@/lib/view-data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Idea Lab" };

export default async function IdeasPage() {
  const { ideas, dataset } = await loadApplicationData();
  const gameEvidence = Object.fromEntries(
    dataset
      .map(buildIdeaGameEvidence)
      .filter((evidence) => evidence !== null)
      .map((evidence) => [evidence.universeId, evidence]),
  );
  return <div className="content"><PageHeading eyebrow="Evidence-ranked concepts" title="Idea Lab" subtitle="Recommendations prioritize recently released games that proved Roblox discovery can surface the loop, then balance propagation, saturation, differentiation, and a realistic solo-development scope. Deterministic generation always works; OpenAI is optional." /><IdeaLab initialIdeas={ideas} gameEvidence={gameEvidence} openAIEnabled={Boolean(process.env.OPENAI_API_KEY)} /></div>;
}
