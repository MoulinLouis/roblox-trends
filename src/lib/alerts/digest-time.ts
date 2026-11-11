import { ALERT_CONFIG } from "../config";

export interface LocalTime {
  day: string;
  hour: number;
}

// The calendar day (YYYY-MM-DD) and hour of an instant in a time zone, from Intl so daylight saving is handled.
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

// The daily digest is due once the local clock reaches digestHour, unless one already went out in the current local day
// at or after that hour (an earlier send of the same day, made before the hour, does not count).
export function digestDue(
  now: Date,
  lastSentAt: Date | null,
  config: Pick<typeof ALERT_CONFIG, "digestHour" | "digestTimeZone"> = ALERT_CONFIG,
): boolean {
  const local = localTime(now, config.digestTimeZone);
  if (local.hour < config.digestHour) return false;
  if (lastSentAt === null) return true;
  const sent = localTime(lastSentAt, config.digestTimeZone);
  return !(sent.day === local.day && sent.hour >= config.digestHour);
}
