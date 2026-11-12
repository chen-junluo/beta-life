import { invoke } from "@tauri-apps/api/core";
import { AI_DIVIDER, appendToAiSection, newDayBody } from "./diaryLogic";
import type { DiaryMonth, DiarySaveOutcome } from "./types";

export const listDiaryMonths = () => invoke<string[]>("list_diary_months");
export const loadDiaryMonth = (month: string) => invoke<DiaryMonth>("load_diary_month", { month });

export interface DiarySaveRequest {
  month: string;
  /** null for a day that is not in the file yet. */
  id: string | null;
  /** `YYMMDD` of a new day; its `## YYMMDD周X` heading is written by Rust. */
  date?: string | null;
  /** The body as last read; a different body on disk is a conflict unless `force`. */
  base: string | null;
  /** Everything under the heading. */
  body: string;
  delete?: boolean;
  force?: boolean;
}

export const saveDiaryDay = (request: DiarySaveRequest) => invoke<DiarySaveOutcome>("save_diary_day", { request });

/** A day before or after a change; `body: null` means it did not exist. */
export interface DiarySnapshot {
  month: string;
  id: string;
  date: string | null;
  body: string | null;
}

/** Writes a snapshot back over whatever the day holds now (undo / redo). */
export async function restoreDiarySnapshot(snapshot: DiarySnapshot): Promise<void> {
  const { days } = await loadDiaryMonth(snapshot.month);
  const current = days.find((day) => day.id === snapshot.id) ?? null;
  if (!current && snapshot.body === null) return;
  const outcome = await saveDiaryDay({
    month: snapshot.month,
    id: snapshot.id,
    date: snapshot.date,
    base: current?.body ?? null,
    body: snapshot.body ?? "",
    delete: snapshot.body === null,
    force: true,
  });
  if (outcome.status !== "saved") throw new Error("日记没有写回");
}

/**
 * Beta Life's own statistics under a day's 【AI总结】 line, written without a diff card (P6). A day
 * not written yet starts from the template. Skipped when that summary is already there (the other
 * Mac wrote it); `marker` is its first words, e.g. `- 习惯：`. Returns whether it wrote.
 */
export async function appendDiarySummary(code: string, text: string, marker: string, template: string): Promise<boolean> {
  const month = code.slice(0, 4);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const day = (await loadDiaryMonth(month)).days.find((item) => item.id === code) ?? null;
    const below = day?.body.split(AI_DIVIDER).slice(1).join(AI_DIVIDER) ?? "";
    if (below.split("\n").some((line) => line.startsWith(marker))) return false;
    const body = appendToAiSection(day ? day.body : newDayBody(template, code), text);
    const outcome = await saveDiaryDay({ month, id: day ? code : null, date: code, base: day?.body ?? null, body });
    if (outcome.status === "saved") return true;
  }
  throw new Error("日记这一天正在被改，习惯统计没有写入");
}
