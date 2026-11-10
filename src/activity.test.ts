import { describe, expect, it } from "vitest";
import { dayBounds, dayKey, formatDuration, summarizeDay, UNTITLED, type ActivitySession } from "./activity";

const day = new Date(2026, 10, 10);
const bounds = dayBounds(day);
const at = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute).getTime();
const s = (start: number, end: number, app: string, title = "", domain?: string): ActivitySession => ({ start, end, app, title, ...(domain && { domain }) });

describe("activity summary", () => {
  it("ranks apps by time, groups browsers by domain and other apps by title", () => {
    const { total, groups, band } = summarizeDay([
      s(at(9), at(10), "Code", "ai.rs"),
      s(at(10), at(10, 30), "Microsoft Edge", "GitHub", "github.com"),
      s(at(10, 30), at(10, 40), "Microsoft Edge", "B站", "bilibili.com"),
      s(at(11), at(11, 20), "Code", ""),
      s(at(12), at(12, 5), "Microsoft Edge", "PR", "github.com"),
    ], bounds);
    expect(total).toBe(125 * 60_000);
    expect(groups.map((group) => [group.app, group.total / 60_000])).toEqual([["Code", 80], ["Microsoft Edge", 45]]);
    expect(groups[0].children).toEqual([{ label: "ai.rs", total: 3_600_000 }, { label: UNTITLED, total: 1_200_000 }]);
    expect(groups[1].children.map((child) => child.label)).toEqual(["github.com", "bilibili.com"]);
    expect(band[0]).toMatchObject({ left: 37.5, color: groups[0].color, label: "Code · ai.rs · 09:00–10:00" });
    expect(band[0].width).toBeCloseTo(100 / 24);
  });

  it("clips sessions to the day", () => {
    const { total, band } = summarizeDay([s(at(23, 30), at(23, 30) + 3_600_000, "Code")], bounds);
    expect(total).toBe(30 * 60_000);
    expect(band[0].left + band[0].width).toBeCloseTo(100);
  });

  it("formats durations and day keys", () => {
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(48 * 60_000)).toBe("48m");
    expect(formatDuration(160 * 60_000)).toBe("2h 40m");
    expect(dayKey(day)).toBe("2026-11-10");
  });
});
