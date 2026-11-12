import type { DiaryDay } from "./types";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (value: number) => String(value).padStart(2, "0");

/** Text before the first day of a month file. */
export const PREAMBLE = "preamble";

/** `YYMMDD` of a local date. */
export function dayCode(date: Date): string {
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function monthCode(date: Date): string {
  return dayCode(date).slice(0, 4);
}

/** The date of `YYMMDD` (20YY), or null when it is not a real day. */
export function codeDate(code: string): Date | null {
  if (!/^\d{6}$/.test(code)) return null;
  const date = new Date(2000 + Number(code.slice(0, 2)), Number(code.slice(2, 4)) - 1, Number(code.slice(4, 6)));
  return dayCode(date) === code ? date : null;
}

/** `261111` → `261111周三`, the heading of a day. */
export function dayLabel(code: string): string {
  const date = codeDate(code);
  return date ? `${code}${WEEKDAYS[date.getDay()]}` : code;
}

/** `2611` → `2026 年 11 月`. */
export function monthTitle(month: string): string {
  return `20${month.slice(0, 2)} 年 ${Number(month.slice(2, 4))} 月`;
}

/** Every month that has a file, plus the current one, oldest first. */
export function monthList(files: string[], current: string): string[] {
  return [...new Set([...files, current])].sort();
}

/** `YYMMDD` of a day heading (`## 261111周三`, `## 260904 周五`, `## 260702`), like the Rust parser. */
export function headingDate(line: string): string | null {
  return /^## +(\d{6})(?!\d)/.exec(line)?.[1] ?? null;
}

/** The heading without `## `, e.g. `261111周三`. */
export function dayTitle(day: DiaryDay): string {
  return day.id === PREAMBLE ? "月初" : day.title;
}

/** The first written line of a body, without list markers, heading marks or emphasis marks. */
export function dayPreview(body: string): string {
  for (const line of body.split("\n")) {
    const clean = line.replace(/^\s*(?:[-*+]|\d+\.|#{1,6})?\s*/, "").replace(/\*\*|__|~~|`/g, "").trim();
    if (clean) return clean;
  }
  return "";
}

/** The body of a new day from the Settings template; `{{date}}` becomes `261111周三`. */
export function newDayBody(template: string, code: string): string {
  return template.replaceAll("{{date}}", dayLabel(code));
}

/** Why a body cannot be saved, or null: a `## YYMMDD` heading inside it would split the day. */
export function bodyProblem(body: string): string | null {
  return body.split("\n").some((line) => headingDate(line)) ? "正文里不能有 `## YYMMDD` 这样的日期标题；另一天请单独新建" : null;
}

/** Above it the user's own writing, below it what Beta Life and the AI add (P6). */
export const AI_DIVIDER = "=============================================【AI总结】=============================================";
const isDivider = (line: string) => line.trim() === AI_DIVIDER;

const listLine = (line: string) => /^\s*(?:[-*+]|\d+\.)\s/.test(line);

/** Adds text to the end of a body; trailing empty bullets (e.g. from the template) go first. */
export function appendToBody(body: string, addition: string): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  while (lines.length > 0 && /^\s*[-*+]?\s*$/.test(lines.at(-1)!)) lines.pop();
  const added = addition.replace(/^\n+/, "").replace(/\s+$/, "");
  if (lines.length === 0) return added;
  // A list continues a list; anything else starts a new paragraph.
  const joiner = listLine(lines.at(-1)!) && listLine(added.split("\n", 1)[0]) ? "\n" : "\n\n";
  return `${lines.join("\n")}${joiner}${added}`;
}

/** Adds the user's kind of text: at the end of the hand-written part, above the 【AI总结】 line. */
export function appendToNotes(body: string, addition: string): string {
  const lines = body.split("\n");
  const divider = lines.findIndex(isDivider);
  if (divider === -1) return appendToBody(body, addition);
  const notes = appendToBody(lines.slice(0, divider).join("\n"), addition);
  return `${notes}\n\n${lines.slice(divider).join("\n")}`;
}

/** Adds a summary under the 【AI总结】 line, adding the line first when the day has none. */
export function appendToAiSection(body: string, addition: string): string {
  const added = addition.replace(/^\n+/, "").replace(/\s+$/, "");
  const lines = body.replace(/\s+$/, "").split("\n");
  const divider = lines.findIndex(isDivider);
  if (divider === -1) {
    const head = body.replace(/\s+$/, "");
    return `${head ? `${head}\n\n` : ""}${AI_DIVIDER}\n\n${added}`;
  }
  // A blank line after the divider, as the diary editor writes it.
  const below = lines.slice(divider + 1).join("\n").replace(/^\n+/, "");
  return `${lines.slice(0, divider + 1).join("\n")}\n\n${appendToBody(below, added)}`;
}
