import { DEFAULT_PERSONAL_TAG, canLink, chainOf, md, type BoardEvent, type EventFile } from "../boardEvents";
import type { AiChange, ChangeKind, ToolArguments } from "./types";

/** Event writes ride on the board panel (`@时间板`), so no new scope has to be granted. */
export const EVENT_TOOLS = ["add_event", "update_event", "delete_event"];
export const isEventTool = (name: string) => EVENT_TOOLS.includes(name);

/**
 * 「bebe 查官网」 uses DeepSeek's server-side `deepseek_web_search`, which only its `deepseek-flash`
 * model serves. Must match `web_search_available` in `src-tauri/src/ai.rs`.
 */
export const lookupAvailable = (ai: { provider: string; model: string }) => ai.provider === "deepseek" && ai.model.toLowerCase().includes("flash");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type ChangeInput = Pick<AiChange, "name" | "arguments" | "createdId">;
export type Display = { kind: ChangeKind; title: string; detail: string };

/** What the model reads: every event and project it may point at. */
export function eventIndex(file: EventFile) {
  return {
    projects: file.projects.map((project) => ({ id: project.id, tag: project.tag, head: project.head, chain: chainOf(project, file.events).length })),
    events: file.events.map((event) => ({
      id: event.id,
      title: event.title,
      shape: event.shape,
      date: event.date,
      time: event.time,
      end: event.end,
      tags: event.tags,
      next: event.next,
      remind: event.remind,
      done: event.done,
    })),
  };
}

function date(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  return value;
}

function clock(value: unknown): string {
  if (typeof value !== "string" || !CLOCK.test(value)) throw new Error("time must be HH:MM");
  return value;
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [DEFAULT_PERSONAL_TAG];
  return value.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 3);
}

function remind(value: unknown): BoardEvent["remind"] {
  if (value === undefined) return { onDay: true, daysBefore: [] };
  const record = (value ?? {}) as { onDay?: unknown; daysBefore?: unknown };
  const daysBefore = Array.isArray(record.daysBefore)
    ? [...new Set(record.daysBefore.map(Number).filter((days) => Number.isInteger(days) && days >= 1 && days <= 30))].sort((a, b) => a - b)
    : [];
  return { onDay: record.onDay !== false, daysBefore };
}

function findEvent(file: EventFile, id: unknown): BoardEvent {
  const event = file.events.find((item) => item.id === id);
  if (!event) throw new Error(`No event with id "${String(id)}"`);
  return event;
}

/** The fields a call would set, validated; `base` supplies what the call leaves out. */
function withArgs(base: BoardEvent, args: ToolArguments): BoardEvent {
  const shape = args.shape === "span" ? "span" : args.shape === "point" ? "point" : base.shape;
  const next = { ...base };
  if (args.title !== undefined) {
    next.title = String(args.title).trim();
    if (!next.title) throw new Error("title must not be empty");
  }
  if (!next.title) throw new Error("title is required");
  if (args.shape !== undefined) next.shape = shape;
  if (args.date !== undefined) next.date = date(args.date, "date");
  if (args.shape === "span" && next.time !== null) next.time = null;
  if (args.shape === "point") {
    next.end = null;
    next.endEst = false;
  }
  if (args.time !== undefined) {
    if (next.shape === "span") throw new Error("time belongs to a point; a span has 截止 and 通知 dates");
    next.time = args.time === null ? null : clock(args.time);
  }
  if (args.end !== undefined) {
    if (next.shape !== "span") throw new Error("end belongs to a span; use shape \"span\" first");
    next.end = args.end === null ? null : date(args.end, "end");
  }
  if (next.end !== null && next.end < next.date) throw new Error("end must be on or after date");
  if (args.dateEst !== undefined) next.dateEst = args.dateEst === true;
  if (args.endEst !== undefined) next.endEst = args.endEst === true && next.end !== null;
  if (args.tags !== undefined) next.tags = tags(args.tags);
  if (args.note !== undefined) next.note = String(args.note);
  if (args.remind !== undefined) next.remind = remind(args.remind);
  if (args.done !== undefined) next.done = args.done === true;
  return next;
}

const when = (event: BoardEvent) =>
  event.shape === "span"
    ? `${md(event.date, event.dateEst)} 截止 → ${event.end ? `${md(event.end, event.endEst)} 通知` : "通知未定"}`
    : `${md(event.date, event.dateEst)}${event.time ? ` ${event.time}` : ""}`;

/**
 * Applies one `add_event` / `update_event` / `delete_event` on a copy and says what changed, so the
 * chat can show a diff card. Throws with a message the model can correct itself from.
 */
export function reviewEventChange(file: EventFile, change: ChangeInput): { file: EventFile; display: Display } {
  const args = change.arguments;
  if (change.name === "add_event") {
    const event = withArgs(
      {
        id: change.createdId ?? crypto.randomUUID(),
        title: "",
        note: "",
        shape: "point",
        date: "",
        dateEst: false,
        end: null,
        endEst: false,
        time: null,
        tags: [DEFAULT_PERSONAL_TAG],
        next: null,
        remind: { onDay: true, daysBefore: [] },
        done: false,
        createdAt: 0,
        updatedAt: 0,
      },
      args,
    );
    if (!event.date) throw new Error("date is required");
    const now = Date.now();
    return { file: { ...file, events: [...file.events, { ...event, createdAt: now, updatedAt: now }] }, display: { kind: "add", title: event.title, detail: `事项 · ${when(event)} · ${event.tags.join(" / ")}` } };
  }

  const event = findEvent(file, args.id);

  if (change.name === "delete_event") {
    const events = file.events
      .filter((item) => item.id !== event.id)
      .map((item) => (item.next === event.id ? { ...item, next: null, updatedAt: Date.now() } : item));
    const projects = file.projects.map((project) => (project.head === event.id ? { ...project, head: null, updatedAt: Date.now() } : project));
    return { file: { ...file, events, projects }, display: { kind: "del", title: event.title, detail: `删除事项 · ${when(event)}` } };
  }

  if (args.next !== undefined && args.next !== null) {
    const target = String(args.next);
    if (!file.events.some((item) => item.id === target)) throw new Error(`No event with id "${target}"`);
    if (!canLink(event.id, target, file.events)) throw new Error("That 下一站 would close a loop or already points back here");
  }
  const next = { ...withArgs(event, args), updatedAt: Date.now() };
  if (args.next !== undefined) next.next = args.next === null ? null : String(args.next);
  const changed = (["title", "shape", "date", "dateEst", "time", "end", "endEst", "tags", "note", "remind", "done", "next"] as const).filter((key) => {
    const before = event[key];
    const after = next[key];
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  if (changed.length === 0) throw new Error("Nothing changes: the event already looks like that");
  return {
    file: { ...file, events: file.events.map((item) => (item.id === next.id ? next : item)) },
    display: { kind: "edit", title: next.title, detail: `事项 · ${when(next)} · 改 ${changed.join(" / ")}` },
  };
}

/** Replays the confirmed event changes on the live file, one bad change at a time. */
export function applyEventBatch(file: EventFile, changes: AiChange[]): { file: EventFile; applied: number; failed: Array<{ changeId: string; reason: string }> } {
  let next = file;
  let applied = 0;
  const failed: Array<{ changeId: string; reason: string }> = [];
  for (const change of changes) {
    try {
      next = reviewEventChange(next, change).file;
      applied += 1;
    } catch (error) {
      failed.push({ changeId: change.id, reason: message(error) });
    }
  }
  return { file: next, applied, failed };
}
