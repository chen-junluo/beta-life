import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { addObstacles, checksIn, fewestDone, habitOn, habitRates, habitStatsText, isLowRate, periodCheck, shiftDate, unfinishedIn } from "./habitLogic";
import type { Habit, HabitRecord, PeriodSetting } from "./types";

const periods = DEFAULT_SETTINGS.periods;
const habit = (id: string, placement: Habit["placement"], done = false, order = 0): Habit => ({
  id, title: `习惯${id}`, description: "", tags: "", placement, order, createdAt: "", updatedAt: "", done,
});
const record = (date: string, habitId: string, done: boolean): HabitRecord => ({ date, boardId: "b", habitId, title: habitId, done });

describe("habit logic", () => {
  it("counts only archived days in the window", () => {
    const records = [record("2026-11-05", "a", true), record("2026-11-10", "a", false), record("2026-11-11", "a", true), record("2026-11-11", "b", false), record("2026-11-12", "a", true)];
    expect(habitRates(records, "2026-11-05", "2026-11-11")).toEqual({ a: { done: 2, total: 3 }, b: { done: 0, total: 1 } });
    expect(shiftDate("2026-11-01", -7)).toBe("2026-10-25");
    // Too few recorded days never count as low.
    expect(isLowRate({ done: 0, total: 2 }, 50)).toBe(false);
    expect(isLowRate({ done: 1, total: 3 }, 50)).toBe(true);
    expect(isLowRate({ done: 2, total: 4 }, 50)).toBe(false);
  });

  it("asks 15 minutes before morning, noon and evening end, never for sleep", () => {
    // Defaults: morning 7, noon 12, evening 18, sleep 23.
    expect(periodCheck(new Date(2026, 10, 12, 11, 44), periods)).toBeNull();
    expect(periodCheck(new Date(2026, 10, 12, 11, 45), periods)).toMatchObject({ key: "2026-11-12:morning", period: { id: "morning" } });
    expect(periodCheck(new Date(2026, 10, 12, 17, 59), periods)?.key).toBe("2026-11-12:noon");
    expect(periodCheck(new Date(2026, 10, 12, 22, 50), periods)?.key).toBe("2026-11-12:evening");
    expect(periodCheck(new Date(2026, 10, 12, 6, 50), periods)).toBeNull();
    // An evening ending at midnight is asked at 23:45; one running past midnight is not asked.
    const midnight: PeriodSetting[] = periods.map((period) => (period.id === "sleep" ? { ...period, startHour: 0 } : period));
    expect(periodCheck(new Date(2026, 10, 12, 23, 50), midnight)?.key).toBe("2026-11-12:evening");
    const late: PeriodSetting[] = periods.map((period) => (period.id === "sleep" ? { ...period, startHour: 1 } : period));
    expect(periodCheck(new Date(2026, 10, 13, 0, 50), late)).toBeNull();
  });

  it("lists a period's unfinished habits, its hours included", () => {
    const items = [habit("h9", { kind: "hour", hour: 9 }), habit("p", { kind: "period", period: "morning" }), habit("done", { kind: "period", period: "morning" }, true), habit("h14", { kind: "hour", hour: 14 })];
    expect(unfinishedIn(items, "morning", periods).map((item) => item.id)).toEqual(["p", "h9"]);
  });

  it("adds dated reasons to their habits", () => {
    const items = [habit("a", { kind: "period", period: "morning" }), habit("b", { kind: "period", period: "morning" })];
    const next = addObstacles(items, "2026-11-12", [{ habitId: "a", text: " 起晚了\n赶组会 " }, { habitId: "b", text: "  " }], "now");
    expect(next[0].obstacles).toEqual([{ date: "2026-11-12", text: "起晚了 赶组会" }]);
    expect(next[1]).toBe(items[1]);
  });

  it("writes the day's statistics for the diary", () => {
    const items = [habit("a", { kind: "period", period: "morning" }, true), habit("b", { kind: "period", period: "noon" }), habit("c", { kind: "hour", hour: 21 }), habit("d", { kind: "period", period: "evening" }, true)];
    const rates = { b: { done: 2, total: 7 }, c: { done: 1, total: 2 }, d: { done: 7, total: 7 } };
    expect(habitStatsText(items, rates, 50, periods)).toBe("- 习惯：完成 2/4（50%）\n\t- 没完成：习惯b（中午）、习惯c（21:00）\n\t- 7 天完成率低于 50%：习惯b 2/7");
    expect(habitStatsText([], {}, 50, periods)).toBeNull();
  });

  it("keeps a day with many unfinished habits short: counts per period, the three lowest rates", () => {
    const named = (id: string, title: string, placement: Habit["placement"]) => ({ ...habit(id, placement), title });
    const items = [
      named("a", "生姜艾叶花椒泡脚15分钟，微微出汗即可", { kind: "hour", hour: 22 }),
      named("b", "写自传！（周末的下午）", { kind: "hour", hour: 17 }),
      named("c", "**跟读《焦点访谈》短节目 15 分钟**", { kind: "hour", hour: 9 }),
      named("d", "练吉他30min", { kind: "hour", hour: 21 }),
      habit("e", { kind: "period", period: "evening" }, true),
    ];
    const rates = { a: { done: 0, total: 4 }, b: { done: 1, total: 4 }, c: { done: 0, total: 3 }, d: { done: 1, total: 3 }, e: { done: 4, total: 4 } };
    // Defaults: morning 7, noon 12, evening 18, sleep 23.
    expect(habitStatsText(items, rates, 50, periods)).toBe(
      "- 习惯：完成 1/5（20%）\n\t- 没完成：晚上 2 个、早上 1 个、中午 1 个\n\t- 7 天完成率低于 50%：4 个，最低的是 生姜艾叶花椒泡脚15分钟 0/4、跟读《焦点访谈》短节目… 0/3、写自传！ 1/4",
    );
  });
  it("weekend-only habits are on at weekends, the others on weekdays and at weekends unless turned off", () => {
    const daily = habit("a", { kind: "hour", hour: 9 });
    const weekend = { ...habit("b", { kind: "hour", hour: 17 }), weekendOnly: true };
    const friday = new Date(2026, 10, 13, 9);
    const saturday = new Date(2026, 10, 14, 9);
    const sunday = new Date(2026, 10, 15, 9);
    expect([habitOn(daily, friday, true), habitOn(weekend, friday, true)]).toEqual([true, false]);
    expect([habitOn(daily, saturday, true), habitOn(weekend, saturday, true)]).toEqual([true, true]);
    expect([habitOn(daily, sunday, false), habitOn(weekend, sunday, false)]).toEqual([false, true]);
    expect([checksIn(daily), checksIn({ ...daily, checkIn: false }), checksIn({ ...daily, checkIn: true })]).toEqual([true, false, true]);
  });

  it("light nudges keep the lowest rates, ties in the given order", () => {
    const habits = [
      { id: "a", done: 2, total: 5 },
      { id: "b", done: 0, total: 4 },
      { id: "c", done: 1, total: 5 },
      { id: "d", done: 0, total: 3 },
    ];
    expect(fewestDone(habits).map((habit) => habit.id)).toEqual(["b", "d", "c"]);
    expect(fewestDone(habits, 1).map((habit) => habit.id)).toEqual(["b"]);
  });
});
