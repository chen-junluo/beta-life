import { invoke } from "@tauri-apps/api/core";
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
