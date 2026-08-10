import type { Metadata } from "next";
import { SettingsForm } from "@/components/SettingsForm";
import { PageHeading } from "@/components/ui";
import { ensureAppReady } from "@/lib/app-ready";
import { getSettings } from "@/db/repository";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await ensureAppReady();
  const settings = await getSettings();
  return <div className="content"><PageHeading eyebrow="Model controls" title="Settings" subtitle="Tune signal thresholds, score weights, collection behavior, taxonomy aliases, and the developer profile used for feasibility." /><SettingsForm initialSettings={settings} /></div>;
}
