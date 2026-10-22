// Display formatting shared by `radar status` and the dashboard. Missing values show as a dash; times are UTC.
const dash = "—";
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function present(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function formatCount(value: number | null | undefined): string {
  return present(value) ? integer.format(Math.round(value)) : dash;
}

export function formatCompact(value: number | null | undefined): string {
  return present(value) ? compact.format(value) : dash;
}

// Growth ratios: two decimals below 1, one up to 10, none above.
export function formatMultiplier(value: number | null | undefined): string {
  if (!present(value)) return dash;
  return `×${value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0)}`;
}

export function formatPercent(share: number | null | undefined, digits = 1): string {
  return present(share) ? `${(share * 100).toFixed(digits)}%` : dash;
}

// Minutes up to 2 hours, hours up to 2 days, then days. A clock skew between two hosts never prints a negative age.
export function formatElapsed(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function formatHours(hours: number | null | undefined): string {
  if (!present(hours)) return dash;
  return hours < 48 ? `${Math.round(hours)}h` : `${(hours / 24).toFixed(1)}d`;
}

export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDay(date: Date): string {
  return day.format(date);
}
