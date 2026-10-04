import type { WatchQuietHours } from "./types.js";

export function watchClock(now: number, timeZone: string): { day: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}
export function quietMinute(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Quiet hour boundaries must use HH:mm");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
export function isWatchQuiet(now: number, timeZone: string, quiet?: WatchQuietHours): boolean {
  if (!quiet) return false;
  const minute = watchClock(now, timeZone).minute;
  const start = quietMinute(quiet.start);
  const end = quietMinute(quiet.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
/** Scan actual instants: repeated local hours are both quiet; skipped boundaries advance naturally. */
export function nextWatchDelivery(now: number, timeZone: string, quiet?: WatchQuietHours, nextDay = false): number {
  const day = watchClock(now, timeZone).day;
  if (!nextDay && !isWatchQuiet(now, timeZone, quiet)) return now;
  let at = Math.floor(now / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 30 * 60; minute++, at += 60_000)
    if ((!nextDay || watchClock(at, timeZone).day !== day) && !isWatchQuiet(at, timeZone, quiet)) return at;
  throw new Error("No allowed delivery instant within the bounded quiet-hour horizon");
}
