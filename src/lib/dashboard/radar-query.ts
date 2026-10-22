import { RADAR_SORTS, type RadarSort } from "@/db/radar";
import { RADAR_CONFIG } from "@/lib/config";

export interface RadarQuery {
  maxAgeDays: number;
  minimumCcu: number;
  sort: RadarSort;
  // Null means now.
  asOf: Date | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function option(value: string | undefined, options: readonly number[], fallback: number): number {
  const parsed = Number(value);
  return options.includes(parsed) ? parsed : fallback;
}

// The Radar filters come from a GET form; anything outside the configured options falls back to the default.
export function parseRadarQuery(params: SearchParams, now: Date, config = RADAR_CONFIG): RadarQuery {
  const sort = first(params.sort);
  return {
    maxAgeDays: option(first(params.age), config.ageOptionsDays, config.defaultAgeDays),
    minimumCcu: option(first(params.minCcu), config.minimumCcuOptions, config.defaultMinimumCcu),
    sort: RADAR_SORTS.find((candidate) => candidate === sort) ?? "growth",
    asOf: parseAsOf(first(params.asOf), now),
  };
}

// A datetime-local value, read as UTC like every time the dashboard shows. A day that does not exist rolls over in
// Date.UTC, so the parsed fields must round-trip.
function parseAsOf(value: string | undefined, now: Date): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (toDateTimeInput(date) !== value) return null;
  return date < now ? date : null;
}

export function toDateTimeInput(date: Date): string {
  return date.toISOString().slice(0, 16);
}
