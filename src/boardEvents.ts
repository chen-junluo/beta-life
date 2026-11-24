import { invoke } from "@tauri-apps/api/core";

/** `时间板/.beta-life/events.json` (Rust `vault::events`), synced with the data folder. */
export interface BoardEvent {
  id: string;
  title: string;
  /** Markdown. */
  note: string;
  shape: "point" | "span";
  /** Point: due. Span: 截止. `YYYY-MM-DD`. */
  date: string;
  dateEst: boolean;
  /** Span only: 通知; `null` = 还没公布. */
  end: string | null;
  endEst: boolean;
  /** Point only: local `HH:MM`; 有值才在「今天」「本周」按分钟定位. */
  time: string | null;
  /** `/` 分层；`tags[0]` 决定进甘特哪一行. */
  tags: string[];
  /** 唯一下一站. */
  next: string | null;
  remind: { onDay: boolean; daysBefore: number[] };
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A project colours one chain; `tag` = `分类/名称` and is unique. */
export interface Project {
  id: string;
  tag: string;
  /** chain 起点；`null` = 回托盘. */
  head: string | null;
  /** 1–10，同分类内排序，不影响取色. */
  priority: number;
  /** 显式色值；`null` = 跟随分类. */
  color: string | null;
  note: string;
  updatedAt: number;
}

export interface Tombstone {
  id: string;
  at: number;
}

export interface EventFile {
  schemaVersion: number;
  events: BoardEvent[];
  projects: Project[];
  /** 90 天内的删除记录，另一台 Mac 的旧副本合并不回来. */
  deleted: Tombstone[];
}

/** What a window loads and hands back: the file plus the mtime it read. */
export interface EventsState {
  file: EventFile;
  /** Unix ms; 0 = 文件还不存在. */
  mtime: number;
}

export const EMPTY_EVENTS: EventFile = { schemaVersion: 1, events: [], projects: [], deleted: [] };
/** Emitted by Rust after another window saved the file. */
export const BOARD_EVENTS = "board://events";

export const loadEvents = () => invoke<EventsState>("load_events");
export const saveEvents = (state: EventsState) => invoke<EventsState>("save_events", { state });

/** `eventId:YYYY-MM-DD:onDay|before<N>|morning` already shown on this Mac. */
export interface Fired { keys: string[] }
export const loadEventsFired = () => invoke<Fired>("load_events_fired");
export const saveEventsFired = (fired: Fired) => invoke<void>("save_events_fired", { fired });

// ---------- tags ----------

export const PERSONAL = "个人事项";
export const PERSONAL_KINDS = ["工作", "生活", "学习", "关系", "行政"];
/** 个人事项新建时的默认 tag；用户可以在事项编辑区改成别的. */
export const DEFAULT_PERSONAL_TAG = `${PERSONAL}/工作`;

export const categoryOf = (tag: string) => tag.split("/")[0];
/** `NLP/ACL` → `ACL`; a one-level tag is its own name. */
export const nameOf = (tag: string) => tag.split("/").slice(1).join("/") || tag;

// ---------- dates ----------

export const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function parseDate(text: string): Date {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
export const addMonths = (date: Date, months: number) => new Date(date.getFullYear(), date.getMonth() + months, 1);
export const daysInMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
/** Whole months between two dates' months, `to - from`. */
export const monthSpan = (from: Date, to: Date) => (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();

/** `11/22`, with `~` when the date is an estimate. */
export const md = (text: string, est = false) => {
  const date = parseDate(text);
  return `${est ? "~" : ""}${date.getMonth() + 1}/${date.getDate()}`;
};

/** The next 30 days' worth of a day's items, sorted by date then time. */
export const eventAt = (event: BoardEvent): number => {
  if (!event.time) return parseDate(event.date).getTime();
  const [hours, minutes] = event.time.split(":").map(Number);
  const date = parseDate(event.date);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes).getTime();
};

// ---------- colours ----------

/** 深海日落：四系，每系三色；同分类内按数组顺序取子色. */
export const FAMS_LIGHT = [
  ["#2c4a7c", "#5a78ab", "#1b2f52"],
  ["#2a8c8c", "#5cb5b5", "#1a5f5f"],
  ["#e06c5a", "#f0998b", "#a9473c"],
  ["#d9a441", "#ecc576", "#a4771c"],
];
export const FAMS_DARK = [
  ["#8aa6d8", "#a9c0e6", "#6b88bd"],
  ["#63c4c4", "#8fd8d8", "#4aa5a5"],
  ["#f0948a", "#f6b3ab", "#cf7166"],
  ["#e6c072", "#f0d79e", "#c9a152"],
];
/** project 可选颜色：12 个色板，跟色系同源. */
export const PALETTE = FAMS_LIGHT.flat();
export const GREY = "#b9bbb3";
export const GREY_INK = "#6b6e66";

/**
 * 分类 → 色系顺序：`projectFamilies` 里的按它的顺序，未知的按名字追加末尾。
 * 已删（没有 project）的分类仍占着自己的位子，其他分类不换色。
 */
export const categoryOrder = (projectFamilies: string[], present: string[]) =>
  [...new Set([...projectFamilies, ...present.filter((category) => !projectFamilies.includes(category)).sort()])];

/** 只有真正有 project 的分类，按色系顺序. */
export function orderedCategories(projects: Project[], projectFamilies: string[]): string[] {
  const present = [...new Set(projects.map((project) => categoryOf(project.tag)))];
  return categoryOrder(projectFamilies, present).filter((category) => present.includes(category));
}

/** 新分类追加到 `projectFamilies` 末尾（Setting 面板里可再拖动）. */
export const withFamily = (projectFamilies: string[], category: string) =>
  projectFamilies.includes(category) ? projectFamilies : [...projectFamilies, category];

export function familyOf(category: string, projects: Project[], projectFamilies: string[]): number {
  const order = categoryOrder(projectFamilies, projects.map((project) => categoryOf(project.tag)));
  const index = order.indexOf(category);
  // 还没见过的分类排在末尾，下一次出现时已经有位子
  return index < 0 ? order.length : index;
}

const siblings = (project: Project, projects: Project[]) =>
  projects.filter((other) => categoryOf(other.tag) === categoryOf(project.tag));

/** 没显式颜色时按分类色系取：同分类内按 `projects[]` 顺序轮流取三个子色. */
export function familyColor(project: Project, projects: Project[], projectFamilies: string[], dark = false): string {
  const families = dark ? FAMS_DARK : FAMS_LIGHT;
  const family = families[familyOf(categoryOf(project.tag), projects, projectFamilies) % families.length];
  return family[siblings(project, projects).indexOf(project) % family.length];
}

export const projectColor = (project: Project, projects: Project[], projectFamilies: string[], dark = false) =>
  project.color ?? familyColor(project, projects, projectFamilies, dark);

/** 分类色带和「跟随分类」的状态色：该分类的第一个子色. */
export function categoryColor(category: string, projects: Project[], projectFamilies: string[], dark = false): string {
  const families = dark ? FAMS_DARK : FAMS_LIGHT;
  const family = families[familyOf(category, projects, projectFamilies) % families.length];
  return family[0];
}

// ---------- chains ----------

export function chainOf(project: Pick<Project, "head">, events: BoardEvent[]): string[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const chain: string[] = [];
  let cursor = project.head;
  while (cursor && !chain.includes(cursor) && byId.has(cursor)) {
    chain.push(cursor);
    cursor = byId.get(cursor)!.next;
  }
  return chain;
}

/** 从某个事项往后数，包含它自己；选「下一站」时成环的选项要置灰. */
export function forwardOf(id: string, events: BoardEvent[]): string[] {
  return chainOf({ head: id }, events);
}

export const canLink = (from: string, to: string, events: BoardEvent[]) =>
  from !== to && !forwardOf(to, events).includes(from);

export const projectsOnEvent = (id: string, events: BoardEvent[], projects: Project[]) =>
  projects.filter((project) => chainOf(project, events).includes(id));

export const projectOfTag = (tag: string | undefined, projects: Project[]) =>
  tag ? projects.find((project) => project.tag === tag) ?? null : null;

/** 甘特里的行：`tags[0]` 是 project tag 或没有 tag 的事项不占行. */
export function rowKeyOf(event: BoardEvent, projects: Project[]): string | null {
  const tag = event.tags[0];
  return !tag || projectOfTag(tag, projects) ? null : tag;
}

/** 事项的颜色：所在 chain 的第一个 project → 自己的 project tag → 灰. */
export function eventColor(event: BoardEvent, events: BoardEvent[], projects: Project[], projectFamilies: string[], dark = false): string {
  const onChain = orderedProjects(projects, projectFamilies).find((project) => chainOf(project, events).includes(event.id));
  if (onChain) return projectColor(onChain, projects, projectFamilies, dark);
  const owner = projectOfTag(event.tags[0], projects);
  if (owner) return projectColor(owner, projects, projectFamilies, dark);
  return rowKeyOf(event, projects) ? GREY_INK : "#7f8790";
}

/** 分类色系顺序 → 同分类 `priority` 降序 → `projects[]` 数组顺序. */
export function orderedProjects(projects: Project[], projectFamilies: string[]): Project[] {
  const categories = orderedCategories(projects, projectFamilies);
  return [...projects].sort((a, b) => {
    const byCategory = categories.indexOf(categoryOf(a.tag)) - categories.indexOf(categoryOf(b.tag));
    if (byCategory !== 0) return byCategory;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return projects.indexOf(a) - projects.indexOf(b);
  });
}

// ---------- gantt rows ----------

export const BAND_HEIGHT = 24;
export const PROJECT_ROW_HEIGHT = 28;
export const VENUE_ROW_HEIGHT = 34;
export const BAR_HEIGHT = 15;

/** 一个事项被 n 个 project 共用时条带 `(n+1)/2` 倍高. */
export const barHeight = (n: number) => (n <= 1 ? BAR_HEIGHT : (BAR_HEIGHT * (n + 1)) / 2);

export interface GanttBand {
  kind: "band";
  label: string;
  color: string;
  /** 沉底的分组（未分配）用灰. */
  grey: boolean;
  count: string;
  height: number;
  y: number;
}
export interface GanttProjectRow {
  kind: "project";
  project: Project;
  color: string;
  collapsed: boolean;
  height: number;
  y: number;
}
export interface GanttVenueRow {
  kind: "venue";
  key: string;
  /** 归属的 project；`null` = 沉底的灰组. */
  parentProject: string | null;
  height: number;
  y: number;
}
export type GanttRow = GanttBand | GanttProjectRow | GanttVenueRow;

type Draft =
  | { kind: "band"; label: string; color: string; grey: boolean; count: string }
  | { kind: "project"; project: Project; color: string }
  | { kind: "venue"; key: string; parentProject: string | null };

function drafts(events: BoardEvent[], projects: Project[], projectFamilies: string[], dark: boolean): Draft[] {
  const rows: Draft[] = [];
  const placed = new Set<string>();
  const ordered = orderedProjects(projects, projectFamilies);
  const assigned = ordered.filter((project) => chainOf(project, events).length > 0);
  for (const category of orderedCategories(assigned, projectFamilies)) {
    const inCategory = assigned.filter((project) => categoryOf(project.tag) === category);
    rows.push({
      kind: "band",
      label: category,
      color: categoryColor(category, projects, projectFamilies, dark),
      grey: false,
      count: `${inCategory.length} 个 project`,
    });
    for (const project of inCategory) {
      rows.push({ kind: "project", project, color: projectColor(project, projects, projectFamilies, dark) });
      for (const id of chainOf(project, events)) {
        const event = events.find((item) => item.id === id);
        const key = event && rowKeyOf(event, projects);
        if (!key || placed.has(key)) continue;
        placed.add(key);
        rows.push({ kind: "venue", key, parentProject: project.id });
      }
    }
  }
  const rest = [...new Set(events.map((event) => rowKeyOf(event, projects)).filter((key): key is string => !!key))]
    .filter((key) => !placed.has(key));
  const withTrack = rest.filter((key) => key.includes("/"));
  for (const track of [...new Set(withTrack.map(categoryOf))]) {
    const keys = withTrack.filter((key) => categoryOf(key) === track);
    rows.push({ kind: "band", label: track, color: GREY_INK, grey: true, count: `${keys.length} ${track === PERSONAL ? "个子类" : "个 venue"} · 未分配` });
    for (const key of keys) rows.push({ kind: "venue", key, parentProject: null });
  }
  const loose = rest.filter((key) => !key.includes("/"));
  if (loose.length) {
    rows.push({ kind: "band", label: PERSONAL, color: GREY_INK, grey: true, count: `${loose.length} 个 tag · 未分配` });
    for (const key of loose) rows.push({ kind: "venue", key, parentProject: null });
  }
  return rows;
}

/**
 * 一行一行算好 y：project 分类色带 → project 子标题 → 它 chain 经过的 venue 行，
 * 剩下的 venue 按 track 分灰组沉底，一层 tag 的（个人事项子类）最后。
 * 折叠的 project 藏掉名下 venue 行，后面的行 y 跟着重算。
 */
export function ganttRows(
  events: BoardEvent[],
  projects: Project[],
  projectFamilies: string[],
  collapsed: ReadonlySet<string> = new Set(),
  dark = false,
): GanttRow[] {
  const all = drafts(events, projects, projectFamilies, dark);
  const visible: Draft[] = [];
  let hiding: string | null = null;
  for (const row of all) {
    if (row.kind === "project") hiding = collapsed.has(row.project.id) ? row.project.id : null;
    else if (row.kind === "band") hiding = null;
    else if (hiding && row.parentProject === hiding) continue;
    visible.push(row);
  }
  const rows: GanttRow[] = [];
  let y = 0;
  for (const row of visible) {
    let height = BAND_HEIGHT;
    if (row.kind === "project") height = PROJECT_ROW_HEIGHT;
    if (row.kind === "venue") {
      const shared = Math.max(1, ...events.filter((event) => rowKeyOf(event, projects) === row.key).map((event) => projectsOnEvent(event.id, events, projects).length));
      height = Math.max(VENUE_ROW_HEIGHT, barHeight(shared) + 24);
    }
    rows.push(row.kind === "band"
      ? { ...row, height, y }
      : row.kind === "project"
        ? { ...row, collapsed: collapsed.has(row.project.id), height, y }
        : { ...row, height, y });
    y += height;
  }
  return rows;
}

export function rowOfEvent(rows: GanttRow[], event: BoardEvent, projects: Project[]): GanttRow | null {
  const key = rowKeyOf(event, projects);
  if (key) return rows.find((row) => row.kind === "venue" && row.key === key) ?? null;
  const owner = projectOfTag(event.tags[0], projects);
  return owner ? rows.find((row) => row.kind === "project" && row.project.id === owner.id) ?? null : null;
}

/** 跨一级分组时箭头画成短箭头 + 「→ 标题」. */
export function groupOf(rows: GanttRow[], row: GanttRow): number {
  return rows.slice(0, rows.indexOf(row) + 1).filter((item) => item.kind === "band").length;
}
