import { invoke } from "@tauri-apps/api/core";
import { orderedSiblings } from "./abilityForest";
import type { AbilityForest, AbilityMapKind } from "./types";

/** A 在推进 node and the target to write inside `[[…]]` in the diary (P7). */
export interface Goal {
  map: AbilityMapKind;
  path: string[];
  name: string;
  link: string;
  /** `YYYY-MM-DD` it was marked 在推进; without progress it counts from here. */
  since: string;
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

/** Whole days from `date` (`YYYY-MM-DD`) to today. */
export function daysSince(date: string, now: Date): number {
  return Math.max(0, Math.round((dayStart(now).getTime() - localDate(date).getTime()) / 86_400_000));
}

/** `entries` newest first; `since` is when the goal was marked (today when unknown). */
export function goalStatus(entries: GoalEntry[], now: Date, staleDays: number, since?: string): GoalStatus {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthDays = new Set(entries.filter((entry) => entry.date.startsWith(month)).map((entry) => entry.date)).size;
  const latest = entries[0];
  if (!latest) {
    const days = since ? daysSince(since, now) : 0;
    return days >= staleDays ? { label: `标记 ${days} 天还没推进`, stale: true, monthDays } : { label: "还没推进", stale: false, monthDays };
  }
  const days = daysSince(latest.date, now);
  if (days === 0) return { label: "今天", stale: false, monthDays };
  if (days >= staleDays) return { label: `${days} 天没推进`, stale: true, monthDays };
  return { label: `${days} 天前`, stale: false, monthDays };
}

/** A 在推进 goal with no progress for `staleDays` or more, for bebe's morning reminder. */
export interface StaleGoal {
  /** `map` + name path, for remembering when bebe last reminded about it. */
  key: string;
  name: string;
  link: string;
  path: string[];
  /** 「12 天没推进」 / 「标记 9 天还没推进」. */
  label: string;
  days: number;
}

/** Stale goals, longest idle first. */
export function staleGoals(progress: GoalProgress, now: Date, staleDays: number): StaleGoal[] {
  return progress.goals
    .map((goal) => {
      const entries = progress.entries.filter((entry) => entry.map === goal.map && pathKey(entry.path) === pathKey(goal.path));
      entries.sort((left, right) => right.date.localeCompare(left.date));
      const status = goalStatus(entries, now, staleDays, goal.since);
      const days = daysSince(entries[0]?.date ?? goal.since, now);
      return { status, goal: { key: `${goal.map}:${pathKey(goal.path)}`, name: goal.name, link: goal.link, path: goal.path, label: status.label, days } };
    })
    .filter(({ status }) => status.stale)
    .map(({ goal }) => goal)
    .sort((left, right) => right.days - left.days);
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
