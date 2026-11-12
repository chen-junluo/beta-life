// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ABILITY_FOREST, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "../defaults";
import { dayLabel } from "../diaryLogic";
import type { DiaryDay } from "../types";
import { applyDiaryChange, commitDiaryChanges, describeDiaryChange, diaryIndex, type DiaryMonths } from "./diaryTools";
import { assistantContext, createToolSession } from "./session";
import type { AiChange } from "./types";

const store = vi.hoisted(() => ({ months: {} as Record<string, DiaryDay[]>, saves: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "list_diary_months") return Object.keys(store.months);
    if (command === "load_diary_month") return { month: args.month, days: store.months[String(args.month)] ?? [] };
    if (command === "save_diary_day") {
      const request = args.request as { month: string; id: string | null; date: string; body: string; delete?: boolean };
      store.saves.push(request);
      const days = store.months[request.month] ?? [];
      const id = request.id ?? request.date;
      const rest = days.filter((day) => day.id !== id);
      const next = request.delete ? rest : [...rest, { id, date: id.slice(0, 6), title: id, body: request.body }];
      store.months[request.month] = next;
      return { status: "saved", id: request.delete ? null : id, month: { month: request.month, days: next } };
    }
    return null;
  }),
}));

const day = (id: string, body: string): DiaryDay => ({ id, date: id.slice(0, 6), title: dayLabel(id), body });
const change = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const data = (diary: Parameters<typeof diaryIndex>[0]) => ({ board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, forests: { vision: DEFAULT_ABILITY_FOREST, research: DEFAULT_RESEARCH_AGENDA }, knowledge: [], memories: [], lifeStages: [], diary, timeline: null });

describe("diary tools", () => {
  const months: DiaryMonths = { "2611": [day("261110", "- 读书"), day("261111", "- ")] };

  beforeEach(() => {
    store.months = { "2610": [day("261031", "- 万圣节")], "2611": [...months["2611"]] };
    store.saves = [];
  });

  it("appends to a day, or creates it at the end of its month", () => {
    expect(applyDiaryChange(months, change("append_diary", { day: "261111", text: "- 散步" }))["2611"][1].body).toBe("- 散步");
    const created = applyDiaryChange(months, change("append_diary", { day: "261112", text: "早睡" }));
    expect(created["2611"].at(-1)).toEqual({ id: "261112", date: "261112", title: "261112周四", body: "早睡" });
    expect(describeDiaryChange(months, change("append_diary", { day: "261112", text: "- 早睡\n- 早起" }))).toEqual({ kind: "add", title: "261112周四", detail: "追加：早睡 等 2 行" });
    expect(() => applyDiaryChange(months, change("append_diary", { day: "261131", text: "x" }))).toThrow("not a real date");
    expect(() => applyDiaryChange(months, change("append_diary", { day: "261111", text: "## 261112周四" }))).toThrow("日期标题");
  });

  it("rewrites and deletes whole days", () => {
    const next = applyDiaryChange(months, change("rewrite_diary_day", { day: "261110", text: "- 读完了\n\n一段感想\n" }));
    expect(next["2611"][0].body).toBe("- 读完了\n\n一段感想");
    expect(describeDiaryChange(months, change("rewrite_diary_day", { day: "261110", text: "- 读完了" })).detail).toBe("改写整天：从第 1 行起 → 读完了");
    expect(() => applyDiaryChange(months, change("delete_diary_day", { day: "261101" }))).toThrow("No diary day");
  });

  it("indexes the current month and reads other months on demand", async () => {
    const diary = { files: ["2610", "2611"], current: "2611", months };
    expect(diaryIndex(diary, new Date(2026, 10, 11)).current.days[0]).toEqual({ id: "261110", title: "261110周二", preview: "读书", lines: 1 });
    const session = createToolSession(data(diary));
    expect(JSON.parse((await session.run({ id: "1", name: "read_diary", arguments: { days: ["261031"] } })).content).items).toEqual([{ id: "261031", title: "261031周六", body: "- 万圣节" }]);
    const staged = await session.run({ id: "2", name: "delete_diary_day", arguments: { day: "261031" } });
    expect(staged.change).toMatchObject({ panel: "diary", kind: "del", title: "261031周六", detail: "万圣节" });
    expect(JSON.parse(assistantContext({ diary: "read" }, data(diary))).diary.months).toEqual(["2610", "2611"]);
  });

  it("writes confirmed changes day by day and returns undo snapshots", async () => {
    const changes = [
      { id: "a", ...change("append_diary", { day: "261111", text: "- 散步" }) },
      { id: "b", ...change("append_diary", { day: "261111", text: "- 早睡" }) },
      { id: "c", ...change("append_diary", { day: "261112", text: "新的一天" }) },
      { id: "d", ...change("delete_diary_day", { day: "261110" }) },
    ] as AiChange[];
    const result = await commitDiaryChanges(changes);
    expect(result.failed).toEqual([]);
    expect(result.before).toEqual([
      { month: "2611", id: "261111", date: "261111", body: "- " },
      { month: "2611", id: "261112", date: "261112", body: null },
      { month: "2611", id: "261110", date: "261110", body: "- 读书" },
    ]);
    expect(result.after.map((snapshot) => snapshot.body)).toEqual(["- 散步\n- 早睡", "新的一天", null]);
    expect(store.saves[2]).toMatchObject({ id: null, date: "261112", base: null });
    expect(store.saves[3]).toMatchObject({ id: "261110", delete: true, base: "- 读书" });
  });
});
