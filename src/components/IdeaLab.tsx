"use client";

import { Lightbulb, RefreshCw, Save, Sparkles, Star, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { IdeaRow } from "@/db/repository";

export function IdeaLab({ initialIdeas, openAIEnabled }: { initialIdeas: IdeaRow[]; openAIEnabled: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<"active" | "saved" | "rejected">("active");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const visible = useMemo(() => initialIdeas.filter((idea) => filter === "saved" ? idea.saved : filter === "rejected" ? idea.rejected : !idea.rejected), [initialIdeas, filter]);
  async function patchIdea(id: string, patch: Record<string, unknown>) {
    const response = await fetch(`/api/ideas/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!response.ok) setMessage("The idea could not be updated.");
    router.refresh();
  }
  async function generate(mode: "deterministic" | "openai") {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/ideas/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    const result = await response.json() as { count?: number; error?: string };
    setMessage(response.ok ? `${result.count ?? 0} data-supported concepts generated.` : result.error || "Idea generation failed.");
    setBusy(false);
    router.refresh();
  }
  return <><div className="page-heading"><div className="status-cluster"><button className={`button ${filter === "active" ? "primary" : ""}`} onClick={() => setFilter("active")}>Active</button><button className={`button ${filter === "saved" ? "primary" : ""}`} onClick={() => setFilter("saved")}>Saved</button><button className={`button ${filter === "rejected" ? "primary" : ""}`} onClick={() => setFilter("rejected")}>Rejected</button></div><div className="status-cluster"><button className="button" disabled={busy} onClick={() => generate("deterministic")}><RefreshCw size={14} />Refresh deterministic ideas</button>{openAIEnabled ? <button className="button primary" disabled={busy} onClick={() => generate("openai")}><Sparkles size={14} />Generate with OpenAI</button> : null}</div></div>{message ? <div className="alert" style={{ marginBottom: 16 }}><Lightbulb size={16} />{message}</div> : null}<div className="grid">{visible.map((idea) => <article className={`card idea-card ${idea.saved ? "saved-card" : ""} ${idea.rejected ? "rejected-card" : ""}`} key={idea.id}><div className="idea-top"><div className="idea-kicker"><span>{idea.generationMode} concept · {idea.estimatedScope}</span><span>{idea.supportingTrendIds.length} supporting trend{idea.supportingTrendIds.length === 1 ? "" : "s"}</span></div><h2>{idea.workingTitle}</h2><p>{idea.pitch}</p></div><div className="idea-body"><IdeaSection title="Core loop" text={idea.coreLoop} /><IdeaSection title="First 20 seconds" text={idea.firstTwentySeconds} /><IdeaSection title="Progression" text={idea.progression} /><IdeaSection title="Reason to return" text={idea.returnReason} /><IdeaSection title="Social component" text={idea.socialComponent} /><IdeaSection title="Differentiator" text={idea.differentiator} /><IdeaList title="Required systems" items={idea.requiredSystems} /><IdeaList title="Assets" items={idea.requiredAssets} /><IdeaList title="Reusable systems" items={idea.reusableSystems} /><IdeaList title="Risks" items={idea.risks} /><div className="idea-section" style={{ gridColumn: "1 / -1" }}><h3>Why now</h3><p>{idea.relevance}</p></div></div><div className="idea-controls"><button className={`button ${idea.saved ? "primary" : ""}`} onClick={() => patchIdea(idea.id, { saved: !idea.saved, rejected: false })}><Save size={13} />{idea.saved ? "Saved" : "Save"}</button><button className="button danger" onClick={() => patchIdea(idea.id, { rejected: !idea.rejected, saved: false })}><X size={13} />{idea.rejected ? "Restore" : "Reject"}</button><input className="input" aria-label="Idea comment" placeholder="Add a decision note…" defaultValue={idea.comment} onBlur={(event) => patchIdea(idea.id, { comment: event.target.value })} /><div className="rating" aria-label="Idea rating">{[1, 2, 3, 4, 5].map((rating) => <button className={(idea.rating ?? 0) >= rating ? "active" : ""} aria-label={`Rate ${rating} stars`} key={rating} onClick={() => patchIdea(idea.id, { rating })}><Star size={16} fill={(idea.rating ?? 0) >= rating ? "currentColor" : "none"} /></button>)}</div></div></article>)}</div>{!visible.length ? <div className="card empty">No concepts in this view. Generate from the current opportunity signals or change the filter.</div> : null}</>;
}

function IdeaSection({ title, text }: { title: string; text: string }) { return <div className="idea-section"><h3>{title}</h3><p>{text}</p></div>; }
function IdeaList({ title, items }: { title: string; items: string[] }) { return <div className="idea-section"><h3>{title}</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>; }
