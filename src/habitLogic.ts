import { cyclicDistance, hourLabel, periodForHour } from "./boardLogic";
import { localDateKey } from "./pet/reminders";
import type { Habit, HabitObstacle, HabitRecord, PeriodId, PeriodSetting } from "./types";

/** Done / recorded days of one habit; `total` 0 means no archived day yet (a new habit). */
export interface HabitRate {
  done: number;
  total: number;
}

/** bebe asks why a period's habits were not done this long before the period ends. */
export const ASK_LEAD_MS = 15 * 60_000;
/** A habit needs this many recorded days before its rate counts as low. */
export const LOW_RATE_MIN_DAYS = 3;
/** The completion rate on the cards and in the diary covers this many days. */
export const RATE_DAYS = 7;

/** `YYYY-MM-DD` `days` after (or before, when negative) a `YYYY-MM-DD`. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return localDateKey(new Date(year, month - 1, day + days));
}

/** Rates per habit id from the archived records between `from` and `to` (inclusive). */
export function habitRates(records: HabitRecord[], from: string, to: string): Record<string, HabitRate> {
  const rates: Record<string, HabitRate> = {};
  for (const record of records) {
    if (record.date < from || record.date > to) continue;
    const rate = (rates[record.habitId] ??= { done: 0, total: 0 });
    rate.total += 1;
    if (record.done) rate.done += 1;
  }
  return rates;
}

export const ratePercent = ({ done, total }: HabitRate) => (total === 0 ? null : Math.round((done / total) * 100));

export function isLowRate(rate: HabitRate | undefined, lowPercent: number): boolean {
  return rate !== undefined && rate.total >= LOW_RATE_MIN_DAYS && (rate.done / rate.total) * 100 < lowPercent;
}

/** The period's end: the start of the next period around the clock. */
function periodEndHour(period: PeriodSetting, periods: PeriodSetting[]): number {
  const next = periods
    .filter((candidate) => candidate.id !== period.id)
    .sort((a, b) => cyclicDistance(period.startHour, a.startHour) - cyclicDistance(period.startHour, b.startHour))[0];
  return next?.startHour ?? period.startHour;
}

export interface PeriodCheck {
  /** One question per period per day: `YYYY-MM-DD:morning`. */
  key: string;
  period: PeriodSetting;
}

/**
 * The morning, noon or evening period ending within `leadMs` of `now` (sleep is never asked). A
 * period whose question would fall after midnight is not asked: the 0:00 archive already cleared it.
 */
export function periodCheck(now: Date, periods: PeriodSetting[], leadMs = ASK_LEAD_MS): PeriodCheck | null {
  for (const period of periods) {
    if (period.id === "sleep") continue;
    const endHour = periodEndHour(period, periods);
    if (endHour < period.startHour && endHour * 3_600_000 - leadMs >= 0) continue;
    for (const offset of [0, 1]) {
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, endHour);
      const from = end.getTime() - leadMs;
      if (now.getTime() >= from && now.getTime() < end.getTime()) return { key: `${localDateKey(new Date(from))}:${period.id}`, period };
    }
  }
  return null;
}

/** Where a habit sits: its period, or the period of its hour. */
export function habitPeriod(habit: Habit, periods: PeriodSetting[]): PeriodId {
  return habit.placement.kind === "period" ? habit.placement.period : periodForHour(habit.placement.hour, periods);
}

/** The period's unfinished habits: period-level ones first, then by hour. */
export function unfinishedIn(items: Habit[], period: PeriodId, periods: PeriodSetting[]): Habit[] {
  return items
    .filter((item) => !item.done && habitPeriod(item, periods) === period)
    .sort((a, b) => (a.placement.kind === b.placement.kind ? a.order - b.order : a.placement.kind === "period" ? -1 : 1));
}

/** One line per reason: whitespace collapsed, at most 80 characters (Rust checks the same). */
export function obstacleText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Adds dated reasons to the habits they belong to. */
export function addObstacles(items: Habit[], date: string, reasons: Array<{ habitId: string; text: string }>, now: string): Habit[] {
  return items.map((item) => {
    const added: HabitObstacle[] = reasons.filter((reason) => reason.habitId === item.id && obstacleText(reason.text)).map((reason) => ({ date, text: obstacleText(reason.text) }));
    return added.length === 0 ? item : { ...item, obstacles: [...(item.obstacles ?? []), ...added], updatedAt: now };
  });
}

function slotLabel(habit: Habit, periods: PeriodSetting[]): string {
  if (habit.placement.kind === "hour") return hourLabel(habit.placement.hour);
  const period = habit.placement.period;
  return periods.find((item) => item.id === period)?.label ?? period;
}

/** The day's habits under 【AI总结】, or null when the board had none. Written by Beta Life, not the AI. */
export function habitStatsText(habits: Habit[], rates: Record<string, HabitRate>, lowPercent: number, periods: PeriodSetting[]): string | null {
  if (habits.length === 0) return null;
  const done = habits.filter((habit) => habit.done).length;
  const lines = [`- 习惯：完成 ${done}/${habits.length}（${Math.round((done / habits.length) * 100)}%）`];
  const missed = habits.filter((habit) => !habit.done);
  if (missed.length > 0) lines.push(`\t- 没完成：${missed.map((habit) => `${habit.title}（${slotLabel(habit, periods)}）`).join("、")}`);
  const low = habits.filter((habit) => isLowRate(rates[habit.id], lowPercent));
  if (low.length > 0) lines.push(`\t- ${RATE_DAYS} 天完成率低于 ${lowPercent}%：${low.map((habit) => `${habit.title} ${rates[habit.id].done}/${rates[habit.id].total}`).join("、")}`);
  return lines.join("\n");
}
