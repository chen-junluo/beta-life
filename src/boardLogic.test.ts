import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import {
  hoursForPeriod,
  masonryRowSpan,
  moveHabit,
  periodForHour,
  validatePeriodStarts,
} from "./boardLogic";
import type { Habit } from "./types";

function habit(id: string, hour: number, order: number): Habit {
  return {
    id,
    title: id,
    description: "",
    tags: "每天",
    placement: { kind: "hour", hour },
    order,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
  };
}

describe("time period mapping", () => {
  it("supports sleep across midnight", () => {
    expect(periodForHour(23, DEFAULT_SETTINGS.periods)).toBe("sleep");
    expect(periodForHour(2, DEFAULT_SETTINGS.periods)).toBe("sleep");
    expect(periodForHour(7, DEFAULT_SETTINGS.periods)).toBe("morning");
    expect(hoursForPeriod("sleep", DEFAULT_SETTINGS)).toEqual([23, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("rejects duplicate cutoffs", () => {
    const invalid = structuredClone(DEFAULT_SETTINGS);
    invalid.periods[1].startHour = invalid.periods[0].startHour;
    expect(validatePeriodStarts(invalid)).toMatch(/不能/);
  });
});

describe("moveHabit", () => {
  it("reorders a source column so lower cards move up", () => {
    const items = [habit("a", 9, 0), habit("b", 9, 1), habit("c", 10, 0)];
    const moved = moveHabit(items, "a", "hour:10", "c");
    expect(moved.find((item) => item.id === "b")?.order).toBe(0);
    expect(moved.find((item) => item.id === "a")?.placement).toEqual({ kind: "hour", hour: 10 });
    expect(
      moved
        .filter((item) => item.placement.kind === "hour" && item.placement.hour === 10)
        .sort((left, right) => left.order - right.order)
        .map((item) => item.id),
    ).toEqual(["a", "c"]);
  });
});

describe("masonryRowSpan", () => {
  it("reserves enough compact grid rows for each measured card", () => {
    expect(masonryRowSpan(42)).toBe(7);
    expect(masonryRowSpan(90)).toBe(13);
    expect(masonryRowSpan(0)).toBe(1);
  });
});
