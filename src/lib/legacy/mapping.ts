import { ROBLOX_DISCOVERY_CHARTS, type RobloxDiscoveryChart } from "@/lib/config";
import type { DiscoverySource } from "@/lib/jobs/types";

const DISCOVERY_CHARTS: ReadonlySet<string> = new Set(ROBLOX_DISCOVERY_CHARTS);

// v1 stored the chart's display name ("Trending in Sports & Racing"); v2 stores the sort id it was read from.
export function sortIdFromLegacyChartLabel(label: string): RobloxDiscoveryChart | null {
  const slug = label
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return DISCOVERY_CHARTS.has(slug) ? (slug as RobloxDiscoveryChart) : null;
}

// Direct tracking re-polled known games, so it discovered nothing.
export function legacyDiscovery(source: string, chart: string): { source: DiscoverySource; detail: string } | null {
  if (source === "roblox-charts") {
    const sortId = sortIdFromLegacyChartLabel(chart);
    return sortId ? { source: "chart", detail: sortId } : null;
  }
  if (source === "roblox-search") return chart.startsWith("Search: ") ? { source: "search", detail: chart.slice("Search: ".length) } : null;
  if (source === "roblox-recommendations") {
    const match = /^Recommendations from (\d+)$/.exec(chart);
    return match ? { source: "recommendation", detail: match[1] } : null;
  }
  if (source === "rolimons") return { source: "rolimons", detail: "" };
  return null;
}

// v1 stored Roblox ids as text. Number() would also accept "", " 1" or "1e3", and silently round ids past 2^53.
export function parseLegacyId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
