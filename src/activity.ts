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
  /** Domains for browsers, window titles for other apps; longest first. */
  children: ActivityItem[];
}

export interface BandSegment {
  left: number;
  width: number;
  color: string;
  label: string;
}

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

/** Active time of the day, apps ranked by time, and the 24h band. */
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
      children: sumBy(own, (session) => (byDomain ? session.domain : undefined) ?? (session.title.trim() || UNTITLED)),
    };
  });
  const span = bounds[1] - bounds[0];
  const band: BandSegment[] = clipped.map((session) => ({
    left: ((session.start - bounds[0]) / span) * 100,
    width: ((session.end - session.start) / span) * 100,
    color: colors.get(session.app)!,
    label: `${session.app}${session.domain || session.title ? ` · ${session.domain ?? session.title}` : ""} · ${clock(session.start)}–${clock(session.end)}`,
  }));
  return { total: ranked.reduce((sum, item) => sum + item.total, 0), groups, band };
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
