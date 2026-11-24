import { describe, expect, it } from "vitest";
import { clockText, EMPTY_PLAN, isSnoozed, nextClock, planSnooze, undoPlan } from "./plan";

const now = new Date(2026, 10, 12, 15, 0).getTime();
const MIN = 60_000;

describe("bebe's plan", () => {
  it("reads HH:MM as the next time that clock time comes", () => {
    expect(nextClock("15:30", now)).toBe(now + 30 * MIN);
    expect(nextClock("14:00", now)).toBe(new Date(2026, 10, 13, 14, 0).getTime());
    expect(() => nextClock("9:00", now)).toThrow();
    expect(() => nextClock("24:00", now)).toThrow();
    expect(clockText(now + 30 * MIN, now)).toBe("15:30");
    expect(clockText(nextClock("08:00", now), now)).toBe("明天 08:00");
  });

  it("pauses, resumes and undoes a pause", () => {
    const paused = planSnooze(EMPTY_PLAN, { until: "22:00" }, now);
    expect(paused.label).toBe("暂停提醒到 22:00");
    expect(isSnoozed(paused.plan, now)).toBe(true);
    const resumed = planSnooze(paused.plan, { minutes: 0 }, now + MIN);
    expect(resumed.label).toBe("提醒恢复了");
    expect(isSnoozed(resumed.plan, now + MIN)).toBe(false);
    expect(undoPlan(resumed.plan, resumed.undo)).toEqual(paused.plan);
    expect(() => planSnooze(EMPTY_PLAN, {}, now)).toThrow("either");
    expect(() => planSnooze(EMPTY_PLAN, { minutes: 5, until: "16:00" }, now)).toThrow("either");
  });
});
