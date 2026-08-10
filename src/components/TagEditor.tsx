"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import type { GameTag, TagDimension } from "@/lib/types";

const dimensions: Array<{ key: TagDimension; label: string }> = [
  { key: "coreLoop", label: "Core loop" },
  { key: "progression", label: "Progression" },
  { key: "reward", label: "Reward" },
  { key: "social", label: "Social / pressure" },
  { key: "theme", label: "Theme" },
];

export function TagEditor({ universeId, tags }: { universeId: string; tags: GameTag[] }) {
  const [values, setValues] = useState<Record<TagDimension, string>>(() => Object.fromEntries(dimensions.map(({ key }) => [key, tags.filter((tag) => tag.dimension === key && tag.source === "manual").map((tag) => tag.tag).join(", ")])) as Record<TagDimension, string>);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setStatus("");
    const manualTags = dimensions.flatMap(({ key }) => values[key].split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => ({ dimension: key, tag, source: "manual" as const })));
    const response = await fetch(`/api/games/${universeId}/tags`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: manualTags }) });
    setStatus(response.ok ? "Manual corrections saved. Refresh to see the updated classification." : "Could not save tag corrections.");
    setSaving(false);
  }
  return <div><div className="settings-fields">{dimensions.map(({ key, label }) => <div className="field" key={key}><label htmlFor={`tags-${key}`}>{label}</label><input className="input" id={`tags-${key}`} value={values[key]} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} placeholder="Comma-separated manual tags" /></div>)}</div><div className="form-actions" style={{ marginTop: 14 }}>{status ? <span className="trend-meta">{status}</span> : null}<button className="button" type="button" onClick={save} disabled={saving}><Save size={14} />{saving ? "Saving…" : "Save corrections"}</button></div></div>;
}
