import { describe, expect, it } from "vitest";
import { DEFAULT_PET_SETTINGS, DEFAULT_SETTINGS } from "../defaults";
import { dayWindow, fixedBetween, fixedTimes, quietBetween, weekWindows } from "./schedule";

const periods = DEFAULT_SETTINGS.periods;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

describe("bebe schedule", () => {
  it("lists bebe's fixed times from the periods and Settings", () => {
    expect(fixedTimes(periods, DEFAULT_PET_SETTINGS).map((time) => [time.minute, time.label])).toEqual([
      [11 * 60 + 45, "问早上没完成的习惯"],
      [17 * 60 + 45, "问中午没完成的习惯"],
      [22 * 60 + 45, "问晚上没完成的习惯"],
      [22 * 60 + 50, "晚间总结"],
      [0, "存档习惯 + 写日记"],
    ]);
  });

  it("places the day from the morning start, fixed times and quiet hours inside it", () => {
    // Thursday 2026-11-12 14:05.
    const { from, to } = dayWindow(at(12, 14, 5), periods);
    expect([from, to]).toEqual([at(12, 7), at(13, 7)]);
    expect(dayWindow(at(13, 3), periods).from).toBe(at(12, 7));
    expect(fixedBetween(fixedTimes(periods, DEFAULT_PET_SETTINGS), from, to).map((time) => time.at)).toEqual([at(12, 11, 45), at(12, 17, 45), at(12, 22, 45), at(12, 22, 50), at(13, 0)]);
    const quiet = [
      { days: ["mon", "tue", "wed", "thu", "fri"] as const, start: "13:00", end: "14:00" },
      // Wednesday night into Thursday morning.
      { days: ["wed"] as const, start: "23:00", end: "08:00" },
      { days: ["sat"] as const, start: "07:00", end: "10:00" },
    ].map((item) => ({ ...item, days: [...item.days] }));
    expect(quietBetween(quiet, from, to)).toEqual([
      { index: 1, start: at(12, 7), end: at(12, 8) },
      { index: 0, start: at(12, 13), end: at(12, 14) },
    ]);
  });

  it("splits the week Monday to Sunday", () => {
    const week = weekWindows(at(12, 14), periods);
    expect(week[0].from).toBe(at(9, 7));
    expect(week[6].to).toBe(at(16, 7));
  });
});
