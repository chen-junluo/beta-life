import { periodForHour } from "../boardLogic";
import type { Habit, PeriodSetting } from "../types";

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
