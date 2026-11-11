import { appendToBody, bodyProblem, codeDate, dayCode, dayLabel, dayPreview, dayTitle, monthCode, monthList, PREAMBLE } from "../diaryLogic";
import { listDiaryMonths, loadDiaryMonth, saveDiaryDay, type DiarySnapshot } from "../diaryStorage";
import type { DiaryDay } from "../types";
import type { AiChange, ChangeKind } from "./types";

type ChangeInput = Pick<AiChange, "name" | "arguments">;
type Failure = { changeId: string; reason: string };
/** Loaded month files, `YYMM` → their days. */
export type DiaryMonths = Record<string, DiaryDay[]>;

export interface DiaryData {
  /** Months that have a file. */
  files: string[];
  current: string;
  months: DiaryMonths;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const short = (value: string, length = 48) => (value.length > length ? `${value.slice(0, length)}…` : value);
const clean = (line: string) => line.replace(/^\s*(?:[-*+]|\d+\.)?\s*/, "").trim();
const settled = (value: string) => value.replace(/^\n+/, "").replace(/\n+$/, "");

export async function loadDiaryData(now = new Date()): Promise<DiaryData> {
  const current = monthCode(now);
  const [files, month] = await Promise.all([listDiaryMonths(), loadDiaryMonth(current)]);
  return { files, current, months: { [current]: month.days } };
}

/** `YYMM` of a day id (`YYMMDD` or `YYMMDD-2`). */
export function monthOfDay(day: unknown): string {
  const id = String(day ?? "");
  if (!/^\d{6}(-\d+)?$/.test(id)) throw new Error(`day must be YYMMDD (or an id like YYMMDD-2 from the index), got "${id}"`);
  return id.slice(0, 4);
}

export function diaryMonthIndex(month: string, days: DiaryDay[]) {
  return {
    month,
    days: days.filter((day) => day.id !== PREAMBLE).map((day) => ({ id: day.id, title: day.title, preview: short(dayPreview(day.body), 40), lines: day.body ? day.body.split("\n").length : 0 })),
  };
}

export function diaryIndex(data: DiaryData, now = new Date()) {
  return { today: dayLabel(dayCode(now)), months: monthList(data.files, data.current), current: diaryMonthIndex(data.current, data.months[data.current] ?? []) };
}

export function findDay(months: DiaryMonths, id: unknown): DiaryDay {
  const day = months[monthOfDay(id)]?.find((item) => item.id === id);
  if (!day) throw new Error(`No diary day "${String(id)}"`);
  return day;
}

/** Applies one diary write to the loaded months; the day's month must already be loaded. */
export function applyDiaryChange(months: DiaryMonths, change: ChangeInput): DiaryMonths {
  const args = change.arguments;
  const month = monthOfDay(args.day);
  const days = months[month];
  if (!days) throw new Error(`Diary month ${month} is not loaded`);
  const replace = (id: string, next: DiaryDay | null) => ({
    ...months,
    [month]: next ? days.map((day) => (day.id === id ? next : day)) : days.filter((day) => day.id !== id),
  });
  switch (change.name) {
    case "append_diary": {
      const code = String(args.day);
      if (!codeDate(code)) throw new Error(`"${code}" is not a real date (YYMMDD)`);
      const addition = text(args.text);
      const problem = bodyProblem(addition);
      if (problem) throw new Error(problem);
      const existing = days.find((day) => day.id === code);
      if (existing) return replace(code, { ...existing, body: appendToBody(existing.body, addition) });
      return { ...months, [month]: [...days, { id: code, date: code, title: dayLabel(code), body: appendToBody("", addition) }] };
    }
    case "rewrite_diary_day": {
      const day = findDay(months, args.day);
      const body = settled(text(args.text));
      const problem = bodyProblem(body);
      if (problem) throw new Error(problem);
      return replace(day.id, { ...day, body });
    }
    case "delete_diary_day":
      return replace(findDay(months, args.day).id, null);
    default:
      throw new Error(`Unknown diary tool ${change.name}`);
  }
}

export function describeDiaryChange(months: DiaryMonths, change: ChangeInput): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  switch (change.name) {
    case "append_diary": {
      const code = String(args.day);
      const existing = months[monthOfDay(code)]?.find((day) => day.id === code);
      const lines = text(args.text).split("\n").map(clean).filter(Boolean);
      const more = lines.length > 1 ? ` 等 ${lines.length} 行` : "";
      return { kind: existing ? "edit" : "add", title: existing ? dayTitle(existing) : dayLabel(code), detail: `追加：${short(lines[0] ?? "")}${more}` };
    }
    case "rewrite_diary_day": {
      const day = findDay(months, args.day);
      const before = day.body.split("\n");
      const after = settled(text(args.text)).split("\n");
      const first = after.findIndex((line, index) => line !== before[index]);
      const detail = first === -1 && before.length === after.length
        ? "改写整天：内容没有变化"
        : first === -1
          ? `改写整天：删去第 ${after.length + 1} 行起的内容`
          : `改写整天：从第 ${first + 1} 行起 → ${short(clean(after[first]) || "（空行）")}`;
      return { kind: "edit", title: dayTitle(day), detail };
    }
    case "delete_diary_day": {
      const day = findDay(months, args.day);
      return { kind: "del", title: dayTitle(day), detail: short(dayPreview(day.body)) || "空的一天" };
    }
    default:
      throw new Error(`Unknown diary tool ${change.name}`);
  }
}

/** Writes confirmed diary changes one day at a time against the files as they are now. */
export async function commitDiaryChanges(changes: AiChange[]) {
  const failed: Failure[] = [];
  const loaded: DiaryMonths = {};
  const before = new Map<string, DiarySnapshot>();
  const after = new Map<string, DiarySnapshot>();
  for (const change of changes) {
    try {
      const month = monthOfDay(change.arguments.day);
      loaded[month] ??= (await loadDiaryMonth(month)).days;
      const id = String(change.arguments.day);
      const date = id.slice(0, 6);
      const previous = loaded[month].find((day) => day.id === id) ?? null;
      const updated = applyDiaryChange(loaded, change)[month].find((day) => day.id === id) ?? null;
      const outcome = await saveDiaryDay({
        month,
        id: previous ? id : null,
        date,
        base: previous?.body ?? null,
        body: updated?.body ?? "",
        delete: updated === null,
      });
      if (outcome.status === "conflict") throw new Error("这一天刚在别处被改过，没有写入");
      loaded[month] = outcome.month.days;
      const key = `${month}/${id}`;
      if (!before.has(key)) before.set(key, { month, id, date, body: previous?.body ?? null });
      after.set(key, { month, id, date, body: outcome.month.days.find((day) => day.id === outcome.id)?.body ?? null });
    } catch (error) {
      failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { before: [...before.values()], after: [...after.values()], failed };
}
