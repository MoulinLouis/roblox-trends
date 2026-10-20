export function floorToSlot(date: Date, minutes: number): Date {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`Invalid slot size: ${minutes}`);
  const size = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / size) * size);
}
