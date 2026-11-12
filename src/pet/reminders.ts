import { periodForHour } from "../boardLogic";
import type { Habit, PeriodSetting, QuietHours, Weekday } from "../types";

export function localDateKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isSleepPeriod(now: Date, periods: PeriodSetting[]): boolean {
  return periods.length > 0 && periodForHour(now.getHours(), periods) === "sleep";
}

export interface ReminderSlot {
  /** One reminder per local hour: `YYYY-MM-DDTHH`. */
  key: string;
  habits: Habit[];
}

/**
 * P1 rule: every hour, remind the unfinished to-dos placed on that hour; in the hour a period
 * starts, also remind that period's unfinished period-level to-dos. Nothing during sleep.
 */
export function reminderSlot(now: Date, items: Habit[], periods: PeriodSetting[]): ReminderSlot | null {
  if (periods.length === 0 || isSleepPeriod(now, periods)) return null;
  const hour = now.getHours();
  const period = periods.find((candidate) => candidate.id === periodForHour(hour, periods))!;
  const pending = items
    .filter((item) => !item.done)
    .filter(({ placement }) =>
      placement.kind === "hour"
        ? placement.hour === hour
        : placement.period === period.id && period.startHour === hour,
    )
    .sort((a, b) => (a.placement.kind === b.placement.kind ? a.order - b.order : a.placement.kind === "hour" ? -1 : 1));
  if (pending.length === 0) return null;
  return { key: `${localDateKey(now)}T${String(hour).padStart(2, "0")}`, habits: pending };
}

/** The default lead of bebe's evening summary before the sleep period (Settings → bebe). */
export const SUMMARY_LEAD_MS = 30 * 60_000;

/**
 * The day (`YYYY-MM-DD`) to summarize when `now` falls within `leadMs` before sleep, else null.
 * A sleep period starting after midnight (1:00–11:00) closes the previous calendar day.
 */
export function summaryDay(now: Date, periods: PeriodSetting[], leadMs = SUMMARY_LEAD_MS): string | null {
  const sleep = periods.find((period) => period.id === "sleep");
  if (!sleep) return null;
  for (const offset of [0, 1]) {
    const sleepAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, sleep.startHour);
    const from = sleepAt.getTime() - leadMs;
    if (now.getTime() < from || now.getTime() >= sleepAt.getTime()) continue;
    const day = new Date(from);
    if (sleep.startHour > 0 && sleep.startHour < 12) day.setDate(day.getDate() - 1);
    return localDateKey(day);
  }
  return null;
}

/** Monday first, as Settings lists them; `Date.getDay()` is Sunday first. */
export const WEEKDAYS: Array<{ id: Weekday; label: string }> = [
  { id: "mon", label: "周一" },
  { id: "tue", label: "周二" },
  { id: "wed", label: "周三" },
  { id: "thu", label: "周四" },
  { id: "fri", label: "周五" },
  { id: "sat", label: "周六" },
  { id: "sun", label: "周日" },
];
const weekdayOf = (date: Date): Weekday => WEEKDAYS[(date.getDay() + 6) % 7].id;

function clockMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Inside one of bebe's quiet hours; a range ending before it starts runs into the next day. */
export function inQuietHours(now: Date, quietHours: QuietHours[]): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  const today = weekdayOf(now);
  const yesterday = weekdayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return quietHours.some(({ days, start, end }) => {
    const from = clockMinutes(start);
    const to = clockMinutes(end);
    if (from < to) return days.includes(today) && minute >= from && minute < to;
    return (days.includes(today) && minute >= from) || (days.includes(yesterday) && minute < to);
  });
}

export function quietHoursText({ days, start, end }: QuietHours): string {
  return `${WEEKDAYS.filter((day) => days.includes(day.id)).map((day) => day.label).join("、")} ${start}–${end}`;
}
