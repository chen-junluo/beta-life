import { invoke } from "@tauri-apps/api/core";
import { orderedSiblings } from "./abilityForest";
import type { AbilityForest, AbilityMapKind } from "./types";

/** A 在推进 node and the target to write inside `[[…]]` in the diary (P7). */
export interface Goal {
  map: AbilityMapKind;
  path: string[];
  name: string;
  link: string;
}

/** One diary line `[[目标]]：做了什么` under a day's `- 长期目标`. */
export interface GoalEntry {
  map: AbilityMapKind;
  path: string[];
  /** `YYYY-MM-DD`. */
  date: string;
  text: string;
}

export interface GoalProgress {
  goals: Goal[];
  entries: GoalEntry[];
}

/** Days without progress before the tree shows the goal as stale. */
export const STALE_DAYS = 7;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function loadGoalProgress(maps: AbilityMapKind[]): Promise<GoalProgress> {
  return invoke<GoalProgress>("load_goal_progress", { maps });
}

export const pathKey = (path: string[]) => path.join("\u001f");

/** Name path of every node, as the Rust side keys them: repeated sibling names get `#2`, `#3`. */
export function namePaths(forest: AbilityForest): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const walk = (parentId: string | null, prefix: string[]) => {
    const counts = new Map<string, number>();
    for (const node of orderedSiblings(forest, parentId)) {
      const name = node.name.trim();
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      const path = [...prefix, count === 1 ? name : `${name}#${count}`];
      paths.set(node.id, path);
      walk(node.id, path);
    }
  };
  walk(null, []);
  return paths;
}

/** One map's entries by node path, newest first. */
export function entriesByPath(progress: GoalProgress | null, map: AbilityMapKind): Map<string, GoalEntry[]> {
  const result = new Map<string, GoalEntry[]>();
  for (const entry of progress?.entries ?? []) {
    if (entry.map !== map) continue;
    const key = pathKey(entry.path);
    result.set(key, [...(result.get(key) ?? []), entry]);
  }
  for (const list of result.values()) list.sort((left, right) => right.date.localeCompare(left.date));
  return result;
}

function localDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dayStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export interface GoalStatus {
  /** 今天 / N 天前 / N 天没推进 / 还没推进. */
  label: string;
  stale: boolean;
  /** Distinct days with progress in the current month. */
  monthDays: number;
}

/** `entries` newest first. */
export function goalStatus(entries: GoalEntry[], now: Date): GoalStatus {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthDays = new Set(entries.filter((entry) => entry.date.startsWith(month)).map((entry) => entry.date)).size;
  const latest = entries[0];
  if (!latest) return { label: "还没推进", stale: true, monthDays };
  const days = Math.max(0, Math.round((dayStart(now).getTime() - localDate(latest.date).getTime()) / 86_400_000));
  if (days === 0) return { label: "今天", stale: false, monthDays };
  if (days >= STALE_DAYS) return { label: `${days} 天没推进`, stale: true, monthDays };
  return { label: `${days} 天前`, stale: false, monthDays };
}

/** `11-13 周五`. */
export function entryDateLabel(date: string): string {
  return `${date.slice(5)} ${WEEKDAYS[localDate(date).getDay()]}`;
}

/** The 长期目标 block of the evening summary's message; empty without 在推进 goals. */
export function goalsMessage(goals: Goal[]): string {
  if (goals.length === 0) return "";
  return `\n\n长期目标（在推进，链接原样使用）：\n${goals.map((goal) => `- [[${goal.link}]]（${goal.path.join(" › ")}）`).join("\n")}`;
}
