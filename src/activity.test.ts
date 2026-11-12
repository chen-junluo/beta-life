import { describe, expect, it } from "vitest";
import { dayBounds, dayKey, formatDelta, formatDuration, summarizeDay, summaryDiaryEntry, summaryDiaryText, summaryLine, UNTITLED, type ActivitySession, type DaySummary } from "./activity";

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

  it("totals time per category, unclassified apart", () => {
    const { categories, band } = summarizeDay([
      { ...s(at(9), at(10), "Code"), category: "focus" },
      { ...s(at(10), at(10, 20), "Microsoft Edge", "", "bilibili.com"), category: "slack" },
      { ...s(at(10, 20), at(10, 30), "Notion"), category: null },
    ], bounds);
    expect(categories).toEqual({ focus: 60 * 60_000, neutral: 0, slack: 20 * 60_000, none: 10 * 60_000 });
    expect(band.map((segment) => segment.categoryColor)).toEqual(["#16a34a", "#ea580c", "#cbd5e1"]);
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

describe("daily digest text", () => {
  const summary: DaySummary = {
    date: "2026-11-10",
    totals: { focus: 260 * 60_000, neutral: 50 * 60_000, slack: 65 * 60_000, none: 25 * 60_000 },
    longestFocus: { start: at(14, 5), end: at(15, 45) },
    topSlack: [{ label: "bilibili.com", ms: 40 * 60_000 }, { label: "zhihu.com", ms: 15 * 60_000 }],
    unclassified: [],
    periods: [],
    average: null,
    nudges: { count: 3, back: 2 },
  };

  it("says the day in one bubble line", () => {
    expect(summaryLine(summary)).toBe("今天专注 4h 20m（65%），摸鱼 1h 05m，还有 25m 没分类。最长一口气专注了 1h 40m。摸鱼最多的是 bilibili.com。");
  });

  it("writes tab-indented bullets for the diary", () => {
    expect(summaryDiaryText(summary)).toBe([
      "- 时间轴：活跃 6h 40m，专注 4h 20m（65%）、中性 50m、摸鱼 1h 05m、待分类 25m",
      "\t- 最长连续专注 1h 40m（14:05–15:45）",
      "\t- 摸鱼最多：bilibili.com 40m、zhihu.com 15m；bebe 提醒 3 次，回去做事 2 次",
    ].join("\n"));
    expect(summaryDiaryText({ ...summary, longestFocus: null, topSlack: [], nudges: { count: 0, back: 0 } }).split("\n")).toHaveLength(1);
  });

  it("targets the summary's own day in the diary", () => {
    expect(summaryDiaryEntry(summary)).toEqual({ date: "2026-11-10", day: "261110", text: summaryDiaryText(summary) });
  });

  it("formats differences against the average", () => {
    expect([formatDelta(35 * 60_000), formatDelta(-10 * 60_000), formatDelta(20_000)]).toEqual(["+35m", "−10m", "±0"]);
  });
});
