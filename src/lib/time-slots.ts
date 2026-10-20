export function floorToSlot(date: Date, minutes: number): Date {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`Invalid slot size: ${minutes}`);
  const size = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / size) * size);
}
