import { addDays, eventAt, parseDate, type BoardEvent } from "../boardEvents";

/** Which reminder of an event is due: on its day (`0`) or `ahead` days before. */
export interface DueReminder {
  /** `eventId:YYYY-MM-DD:onDay` / `…:before<N>` / `morning:YYYY-MM-DD`, kept in `events-fired.json`. */
  key: string;
  event: BoardEvent;
  ahead: number;
}

const DAY = 86_400_000;
const startOfDay = (date: string) => parseDate(date).getTime();
const daysBetween = (from: string, to: string) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);

/**
 * The events whose reminder is due now and has not been shown on this Mac. A timed point waits for its
 * clock; a span or an untimed point fires from the start of the day. Days-before reminders fire on the
 * first check of that day, whenever bebe is allowed to speak.
 */
export function dueEventReminders(events: BoardEvent[], fired: readonly string[], today: string, now: number): DueReminder[] {
  const seen = new Set(fired);
  const due: DueReminder[] = [];
  for (const event of events) {
    if (event.done) continue;
    const days = daysBetween(today, event.date);
    if (days === 0 && event.remind.onDay) {
      const key = `${event.id}:${today}:onDay`;
      const timed = event.shape === "point" && event.time !== null;
      if (!seen.has(key) && (!timed || now >= eventAt(event))) due.push({ key, event, ahead: 0 });
    }
    for (const ahead of event.remind.daysBefore) {
      if (days !== ahead) continue;
      const key = `${event.id}:${today}:before${ahead}`;
      if (!seen.has(key)) due.push({ key, event, ahead });
    }
  }
  return due;
}

/** The morning digest: the next 7 days' events, once a day, within 4 hours of the day's start. */
export function morningDigest(events: BoardEvent[], fired: readonly string[], today: string, from: number, now: number) {
  const key = `morning:${today}`;
  if (fired.includes(key) || now < from || now >= from + 4 * 3_600_000) return null;
  const until = addDays(parseDate(today), 7).getTime();
  const items = events
    .filter((event) => !event.done && eventAt(event) >= from && eventAt(event) < until)
    .sort((a, b) => eventAt(a) - eventAt(b))
    .slice(0, 5);
  return items.length ? { key, items } : null;
}

/** Drops keys older than today so `events-fired.json` does not grow forever. */
export function pruneFired(fired: readonly string[], today: string): string[] {
  return fired.filter((key) => (key.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "") >= today);
}
