import type { ChartPresence, VersionRecord } from "@/db/game-view";
import { chartLabel } from "./labels";

export interface TimelineEntry {
  at: Date;
  label: string;
}

// Newest first. Versions arrive oldest first: the first metadata version is the game as first tracked, and a later
// one either renames it or changes its description. The first thumbnail is no change; each later one is (thumbnail
// A/B tests).
export function buildTimeline(versions: readonly VersionRecord[], charts: readonly ChartPresence[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let tracked = false;
  let previousName: string | null = null;
  let thumbnails = 0;
  for (const version of versions) {
    if (version.kind === "metadata") {
      if (!tracked) entries.push({ at: version.observedAt, label: `Tracked as “${version.name ?? ""}”` });
      else if (version.name !== previousName) entries.push({ at: version.observedAt, label: `Renamed “${version.name ?? ""}”` });
      else entries.push({ at: version.observedAt, label: "Description changed" });
      tracked = true;
      previousName = version.name;
    } else {
      if (thumbnails > 0) entries.push({ at: version.observedAt, label: "Thumbnail changed" });
      thumbnails += 1;
    }
  }
  for (const chart of charts) {
    entries.push({ at: chart.firstSeenAt, label: `Entered ${chartLabel(chart.sortId)} (best #${chart.bestRank})` });
  }
  return entries.sort((left, right) => right.at.getTime() - left.at.getTime());
}
