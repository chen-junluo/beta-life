import { invoke } from "@tauri-apps/api/core";
import type { PeriodId } from "./types";

/** Mirrors Rust `categories::Category`; `null` while the user has not classified it. */
export type ActivityCategory = "focus" | "neutral" | "slack";

/** One stretch of time on the same app, window title and domain (Rust `activity::Session`). */
export interface ActivitySession {
  /** Unix milliseconds. */
  start: number;
  end: number;
  app: string;
  bundleId?: string;
  /** Empty without Accessibility, or when a browser could not be checked for a private window. */
  title: string;
  domain?: string;
  /** Decided in Rust by the rules; `null` or missing while unclassified. */
  category?: ActivityCategory | null;
}

/** What a hand classification sets a rule for: the site for web pages, else the app. */
export interface RuleTarget {
  kind: "app" | "domain";
  /** Bundle id (or app name) for apps, the rule's domain for sites. */
  key: string;
  label: string;
}

export interface TargetState extends RuleTarget {
  category: ActivityCategory | null;
}

/** `load_activity_day`: the sessions plus the rule each ranking row edits. */
export interface ActivityDay {
  sessions: ActivitySession[];
  /** By app name. */
  apps: Record<string, TargetState>;
  /** By recorded domain. */
  domains: Record<string, TargetState>;
}

export interface ActivityRules {
  apps: Array<{ key: string; name: string; category: ActivityCategory }>;
  domains: Array<{ domain: string; category: ActivityCategory }>;
  keywords: Array<{ keyword: string; category: ActivityCategory }>;
}

/** Emitted by Rust to every window after the rules change. */
export const RULES_CHANGED = "activity://rules-changed";

export const CATEGORIES: Array<{ id: ActivityCategory; label: string; color: string }> = [
  { id: "focus", label: "专注", color: "#16a34a" },
  { id: "neutral", label: "中性", color: "#64748b" },
  { id: "slack", label: "摸鱼", color: "#ea580c" },
];
export const UNCLASSIFIED = { label: "待分类", color: "#cbd5e1" };

export function categoryMeta(category: ActivityCategory | null | undefined) {
  return CATEGORIES.find((item) => item.id === category) ?? UNCLASSIFIED;
}

/** One click in the timeline or in bebe's bubble; `null` makes it unclassified again. */
export function setActivityRule(target: RuleTarget, category: ActivityCategory | null): Promise<void> {
  return invoke("set_activity_rule", { request: { kind: target.kind, key: target.key, name: target.label, category } });
}

export type BrowserAccess = "unknown" | "granted" | "denied";

export interface ActivityStatus {
  supported: boolean;
  accessibility: boolean;
  browsers: Array<{ name: string; access: BrowserAccess }>;
}

export interface ActivityItem {
  label: string;
  total: number;
}

export interface ActivityGroup extends ActivityItem {
  app: string;
  color: string;
  /** Children are domains (browsers) rather than window titles. */
  byDomain: boolean;
  /** Domains for browsers, window titles for other apps; longest first. */
  children: ActivityItem[];
}

export interface BandSegment {
  left: number;
  width: number;
  color: string;
  /** Color of the session's category, for the stripe under the band. */
  categoryColor: string;
  label: string;
}

export type CategoryTotals = Record<ActivityCategory | "none", number>;

export const UNTITLED = "（无标题）";
const OTHER_COLOR = "#94a3b8";
/** The top apps get their own color in the band and the ranking; the rest share gray. */
const APP_COLORS = ["#6366f1", "#0ea5e9", "#16a34a", "#d97706", "#ea580c", "#db2777", "#7c3aed", "#0d9488"];

/** Local midnight of `day` and of the next day (DST-safe). */
export function dayBounds(day: Date): [number, number] {
  return [new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(), new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()];
}

export function dayKey(day: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function clip(sessions: ActivitySession[], [from, to]: [number, number]): ActivitySession[] {
  return sessions.flatMap((session) => {
    const start = Math.max(session.start, from);
    const end = Math.min(session.end, to);
    return end > start ? [{ ...session, start, end }] : [];
  });
}

function sumBy(sessions: ActivitySession[], key: (session: ActivitySession) => string): ActivityItem[] {
  const totals = new Map<string, number>();
  for (const session of sessions) totals.set(key(session), (totals.get(key(session)) ?? 0) + session.end - session.start);
  return [...totals].map(([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total);
}

/** Active time of the day, apps ranked by time, time per category, and the 24h band. */
export function summarizeDay(sessions: ActivitySession[], bounds: [number, number]) {
  const clipped = clip(sessions, bounds);
  const ranked = sumBy(clipped, (session) => session.app);
  const colors = new Map(ranked.map(({ label }, index) => [label, APP_COLORS[index] ?? OTHER_COLOR]));
  const groups: ActivityGroup[] = ranked.map(({ label: app, total }) => {
    const own = clipped.filter((session) => session.app === app);
    const byDomain = own.some((session) => session.domain);
    return {
      app,
      label: app,
      total,
      color: colors.get(app)!,
      byDomain,
      children: sumBy(own, (session) => (byDomain ? session.domain : undefined) ?? (session.title.trim() || UNTITLED)),
    };
  });
  const span = bounds[1] - bounds[0];
  const band: BandSegment[] = clipped.map((session) => ({
    left: ((session.start - bounds[0]) / span) * 100,
    width: ((session.end - session.start) / span) * 100,
    color: colors.get(session.app)!,
    categoryColor: categoryMeta(session.category).color,
    label: `${session.app}${session.domain || session.title ? ` · ${session.domain ?? session.title}` : ""} · ${clock(session.start)}–${clock(session.end)}`,
  }));
  const categories: CategoryTotals = { focus: 0, neutral: 0, slack: 0, none: 0 };
  for (const session of clipped) categories[session.category ?? "none"] += session.end - session.start;
  return { total: ranked.reduce((sum, item) => sum + item.total, 0), groups, band, categories };
}

/** `load_daily_summary` (Rust `digest::DaySummary`): every duration is in milliseconds. */
export interface DaySummary {
  /** `YYYY-MM-DD`. */
  date: string;
  totals: CategoryTotals;
  longestFocus: { start: number; end: number } | null;
  /** Slack sites (or apps), longest first, at most 3. */
  topSlack: Array<{ label: string; ms: number }>;
  /** Unclassified rule targets, longest first, at most 3; `todayMs` is time on that day. */
  unclassified: Array<RuleTarget & { todayMs: number }>;
  periods: Array<CategoryTotals & { id: PeriodId; label: string }>;
  /** Per-day means over the previous 7 days that have any record. */
  average: { days: number; active: number; focus: number; slack: number } | null;
  nudges: { count: number; back: number };
}

export function loadDailySummary(date: string): Promise<DaySummary> {
  return invoke<DaySummary>("load_daily_summary", { date });
}

export function activeTotal(totals: CategoryTotals): number {
  return totals.focus + totals.neutral + totals.slack + totals.none;
}

/** Whole percent of active time spent on focus; `null` without any record. */
export function focusShare(totals: CategoryTotals): number | null {
  const active = activeTotal(totals);
  return active > 0 ? Math.round((totals.focus / active) * 100) : null;
}

/** `+35m` / `−10m` / `±0`: today against the average. */
export function formatDelta(ms: number): string {
  if (Math.abs(ms) < 60_000) return "±0";
  return `${ms > 0 ? "+" : "−"}${formatDuration(Math.abs(ms))}`;
}

/** The evening bubble: one or two sentences, no titles. */
export function summaryLine(summary: DaySummary): string {
  const { totals } = summary;
  const share = focusShare(totals);
  const parts = [`今天专注 ${formatDuration(totals.focus)}${share === null ? "" : `（${share}%）`}`, `摸鱼 ${formatDuration(totals.slack)}`];
  if (totals.none >= 60_000) parts.push(`还有 ${formatDuration(totals.none)} 没分类`);
  const streak = summary.longestFocus ? `最长一口气专注了 ${formatDuration(summary.longestFocus.end - summary.longestFocus.start)}。` : "";
  const slack = summary.topSlack[0] ? `摸鱼最多的是 ${summary.topSlack[0].label}。` : "";
  return `${parts.join("，")}。${streak}${slack}`;
}

/** 写进日记 (bebe's evening bubble and the timeline page): the date, its diary day `YYMMDD`, and the statistics the AI puts first. */
export function summaryDiaryEntry(summary: DaySummary): { date: string; day: string; text: string } {
  const [year, month, day] = summary.date.split("-");
  return { date: summary.date, day: `${year.slice(2)}${month}${day}`, text: summaryDiaryText(summary) };
}

/** Appended to the day's diary body: tab-indented bullets like the user's own diary. */
export function summaryDiaryText(summary: DaySummary): string {
  const { totals } = summary;
  const share = focusShare(totals);
  const lines = [
    `- 时间轴：活跃 ${formatDuration(activeTotal(totals))}，专注 ${formatDuration(totals.focus)}${share === null ? "" : `（${share}%）`}、中性 ${formatDuration(totals.neutral)}、摸鱼 ${formatDuration(totals.slack)}、待分类 ${formatDuration(totals.none)}`,
  ];
  if (summary.longestFocus) lines.push(`\t- 最长连续专注 ${formatDuration(summary.longestFocus.end - summary.longestFocus.start)}（${clock(summary.longestFocus.start)}–${clock(summary.longestFocus.end)}）`);
  const slack = summary.topSlack.map((item) => `${item.label} ${formatDuration(item.ms)}`).join("、");
  const nudges = summary.nudges.count > 0 ? `bebe 提醒 ${summary.nudges.count} 次，回去做事 ${summary.nudges.back} 次` : "";
  if (slack || nudges) lines.push(`\t- ${[slack && `摸鱼最多：${slack}`, nudges].filter(Boolean).join("；")}`);
  return lines.join("\n");
}

export function clock(ms: number): string {
  const time = new Date(ms);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** `2h 40m`, `48m`, `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}
