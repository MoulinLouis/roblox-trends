import type { Metadata } from "next";
import { IdeaLab } from "@/components/IdeaLab";
import { PageHeading } from "@/components/ui";
import { loadApplicationData } from "@/lib/view-data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Idea Lab" };

export default async function IdeasPage() {
  const { ideas } = await loadApplicationData();
  return <div className="content"><PageHeading eyebrow="Concept generator" title="Idea Lab" subtitle="Each concept combines a growing mechanic, a lower-competition wrapper, a clear differentiator, and a realistic solo-development scope. Deterministic generation always works; OpenAI is optional." /><IdeaLab initialIdeas={ideas} openAIEnabled={Boolean(process.env.OPENAI_API_KEY)} /></div>;
}
