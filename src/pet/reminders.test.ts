import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Habit, Placement } from "../types";
import { inQuietHours, isSleepPeriod, quietHoursText, reminderSlot, summaryDay } from "./reminders";

const periods = DEFAULT_SETTINGS.periods;
const startOf = (id: string) => periods.find((period) => period.id === id)!.startHour;

function habit(id: string, placement: Placement, done = false, order = 0): Habit {
  return { id, title: id, description: "", tags: "", placement, order, done, createdAt: "", updatedAt: "" };
}

function at(hour: number, minute = 0): Date {
  return new Date(2026, 10, 9, hour, minute);
}

describe("bebe reminder slots", () => {
  const morning = startOf("morning");

  it("reminds unfinished to-dos placed on the current hour", () => {
    const hour = morning + 1;
    const items = [habit("now", { kind: "hour", hour }), habit("later", { kind: "hour", hour: hour + 1 }), habit("finished", { kind: "hour", hour }, true)];
    const slot = reminderSlot(at(hour, 20), items, periods);
    expect(slot?.habits.map((item) => item.id)).toEqual(["now"]);
    expect(slot?.key).toBe(`2026-11-09T${String(hour).padStart(2, "0")}`);
  });

  it("adds period-level to-dos only in the hour the period starts, after hour to-dos", () => {
    const items = [habit("period", { kind: "period", period: "morning" }), habit("hour", { kind: "hour", hour: morning }, false, 5)];
    expect(reminderSlot(at(morning), items, periods)?.habits.map((item) => item.id)).toEqual(["hour", "period"]);
    expect(reminderSlot(at(morning + 1), items, periods)).toBeNull();
  });

  it("stays quiet during the sleep period", () => {
    const sleep = startOf("sleep");
    const items = [habit("late", { kind: "hour", hour: sleep }), habit("rest", { kind: "period", period: "sleep" })];
    expect(isSleepPeriod(at(sleep), periods)).toBe(true);
    expect(reminderSlot(at(sleep), items, periods)).toBeNull();
    expect(isSleepPeriod(at(morning), periods)).toBe(false);
  });
});

describe("bebe evening summary", () => {
  const withSleep = (startHour: number) => periods.map((period) => (period.id === "sleep" ? { ...period, startHour } : period));

  it("is due in the half hour before sleep starts", () => {
    const sleep = withSleep(23);
    expect(summaryDay(at(22, 29), sleep)).toBeNull();
    expect(summaryDay(at(22, 30), sleep)).toBe("2026-11-09");
    expect(summaryDay(at(22, 59), sleep)).toBe("2026-11-09");
    expect(summaryDay(at(23, 0), sleep)).toBeNull();
  });

  it("handles sleep at midnight and after midnight", () => {
    expect(summaryDay(at(23, 40), withSleep(0))).toBe("2026-11-09");
    expect(summaryDay(at(0, 10), withSleep(0))).toBeNull();
    // Sleep at 1:00: the summary at 0:30 closes the day before.
    expect(summaryDay(at(0, 30), withSleep(1))).toBe("2026-11-08");
  });
});

describe("bebe's lead time and quiet hours", () => {
  it("shows the evening summary with the lead time from Settings", () => {
    expect(summaryDay(at(22, 0), periods, 60 * 60_000)).toBe("2026-11-09");
    expect(summaryDay(at(21, 59), periods, 60 * 60_000)).toBeNull();
  });

  it("is quiet on the listed days and across midnight", () => {
    // 2026-11-09 is a Monday.
    const lecture = { days: ["mon" as const], start: "14:00", end: "16:00" };
    expect(inQuietHours(at(14, 0), [lecture])).toBe(true);
    expect(inQuietHours(at(15, 59), [lecture])).toBe(true);
    expect(inQuietHours(at(16, 0), [lecture])).toBe(false);
    expect(inQuietHours(new Date(2026, 10, 10, 14, 30), [lecture])).toBe(false);
    // Sunday night 23:00–01:00 covers Monday 0:30, not Monday 23:30.
    const late = { days: ["sun" as const], start: "23:00", end: "01:00" };
    expect(inQuietHours(at(0, 30), [late])).toBe(true);
    expect(inQuietHours(at(23, 30), [late])).toBe(false);
    expect(quietHoursText({ days: ["fri", "mon"], start: "14:00", end: "16:00" })).toBe("周一、周五 14:00–16:00");
  });
});
