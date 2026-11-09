import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Habit, Placement } from "../types";
import { isSleepPeriod, reminderSlot } from "./reminders";

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
