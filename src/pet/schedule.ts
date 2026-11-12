import { ASK_LEAD_MS, periodEndHour } from "../habitLogic";
import type { PeriodSetting, PetSettings, QuietHours } from "../types";
import { WEEKDAYS } from "./reminders";

/** bebe's fixed times on the board's bebe tab; they follow the periods and Settings → bebe. */
export interface FixedTime {
  /** Minutes after local midnight. */
  minute: number;
  kind: "ask" | "summary" | "archive";
  label: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The board's day starts with the morning period, as its columns do. */
export function dayStartHour(periods: PeriodSetting[]): number {
  return periods.find((period) => period.id === "morning")?.startHour ?? 0;
}

/** The three 「为什么没完成」 questions, the evening summary and the 0:00 archive (same rules as `periodCheck`). */
export function fixedTimes(periods: PeriodSetting[], pet: PetSettings): FixedTime[] {
  const lead = ASK_LEAD_MS / MINUTE;
  const times: FixedTime[] = [];
  for (const period of periods) {
    if (period.id === "sleep") continue;
    const end = periodEndHour(period, periods);
    if (end < period.startHour && end * 60 - lead >= 0) continue;
    times.push({ minute: (end * 60 - lead + 1440) % 1440, kind: "ask", label: `问${period.label}没完成的习惯` });
  }
  const sleep = periods.find((period) => period.id === "sleep");
  if (sleep) times.push({ minute: (sleep.startHour * 60 - pet.summaryLeadMinutes + 1440) % 1440, kind: "summary", label: "晚间总结" });
  times.push({ minute: 0, kind: "archive", label: "存档习惯 + 写日记" });
  return times;
}

const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

function midnight(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Each local midnight from the day before `from` to `to`. */
function midnights(from: number, to: number): Date[] {
  const days: Date[] = [];
  const first = midnight(from);
  for (let day = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1); day.getTime() < to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) days.push(day);
  return days;
}

const atMinute = (day: Date, minute: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute).getTime();

/** Fixed times between `from` and `to` (Unix ms). */
export function fixedBetween(times: FixedTime[], from: number, to: number): Array<FixedTime & { at: number }> {
  return midnights(from, to)
    .flatMap((day) => times.map((time) => ({ ...time, at: atMinute(day, time.minute) })))
    .filter((time) => time.at >= from && time.at < to)
    .sort((a, b) => a.at - b.at);
}

/** Quiet hours between `from` and `to`, clipped; a range ending before it starts runs into the next day. */
export function quietBetween(quietHours: QuietHours[], from: number, to: number): Array<{ index: number; start: number; end: number }> {
  const ranges: Array<{ index: number; start: number; end: number }> = [];
  for (const day of midnights(from, to)) {
    const weekday = WEEKDAYS[(day.getDay() + 6) % 7].id;
    quietHours.forEach((quiet, index) => {
      if (!quiet.days.includes(weekday)) return;
      const startMinute = clockMinutes(quiet.start);
      const endMinute = clockMinutes(quiet.end);
      const start = atMinute(day, startMinute);
      const end = atMinute(day, endMinute + (endMinute <= startMinute ? 1440 : 0));
      if (end > from && start < to) ranges.push({ index, start: Math.max(start, from), end: Math.min(end, to) });
    });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The bebe-tab day containing `now`: from the morning start to the next one. */
export function dayWindow(now: number, periods: PeriodSetting[]): { from: number; to: number } {
  const hour = dayStartHour(periods);
  const today = midnight(now);
  let from = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).getTime();
  if (from > now) from -= DAY;
  return { from, to: from + DAY };
}

/** Monday to Sunday of the week containing `now`, each from the morning start. */
export function weekWindows(now: number, periods: PeriodSetting[]): Array<{ from: number; to: number }> {
  const { from } = dayWindow(now, periods);
  const start = new Date(from);
  const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - ((start.getDay() + 6) % 7), start.getHours());
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, monday.getHours()).getTime();
    return { from: day, to: day + DAY };
  });
}
