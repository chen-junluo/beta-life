import { invoke } from "@tauri-apps/api/core";

/** bebe's short-lived plan (Rust `bebe::PetPlan`): applied at once by the AI, undone from the chat. */
export interface OneOffReminder {
  id: string;
  /** Unix milliseconds. */
  at: number;
  text: string;
}

export interface PetPlan {
  /** No slack reminders, questions or habit reminders before this. */
  snoozeUntil: number | null;
  reminders: OneOffReminder[];
}

export const EMPTY_PLAN: PetPlan = { snoozeUntil: null, reminders: [] };
/** Emitted by Rust to every window after the plan was saved. */
export const PET_PLAN = "pet://plan";

/** How to take one instant action back. */
export type PlanUndo =
  | { kind: "snooze"; previous: number | null }
  | { kind: "unschedule"; id: string }
  | { kind: "reschedule"; reminder: OneOffReminder };

export interface PlanStep {
  plan: PetPlan;
  /** What bebe did, shown with the undo button. */
  label: string;
  undo: PlanUndo;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** `HH:MM` → the next time that clock time comes (later today, else tomorrow). */
export function nextClock(clock: string, now: number): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new Error(`time must be local HH:MM, got "${clock}"`);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** `15:20`, or `明天 08:00` when it is not today. */
export function clockText(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  today.setDate(today.getDate() + 1);
  return date.toDateString() === today.toDateString() ? `明天 ${time}` : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** Exactly one of `minutes` (from now) or a clock field. */
function whenOf(args: Record<string, unknown>, clockKey: "until" | "at", now: number): number {
  const minutes = args.minutes;
  const clock = args[clockKey];
  if ((minutes === undefined) === (clock === undefined)) throw new Error(`give either minutes or ${clockKey}`);
  return clock !== undefined ? nextClock(String(clock), now) : now + Number(minutes) * MINUTE;
}

export function planSnooze(plan: PetPlan, args: Record<string, unknown>, now: number): PlanStep {
  const until = whenOf(args, "until", now);
  const undo: PlanUndo = { kind: "snooze", previous: plan.snoozeUntil };
  if (until <= now) return { plan: { ...plan, snoozeUntil: null }, label: "提醒恢复了", undo };
  return { plan: { ...plan, snoozeUntil: until }, label: `暂停提醒到 ${clockText(until, now)}`, undo };
}

export function planReminder(plan: PetPlan, args: Record<string, unknown>, now: number, id: string): PlanStep {
  const at = whenOf(args, "at", now);
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("text must not be empty");
  if (at - now > DAY) throw new Error("a one-off reminder must be within the next 24 hours; add a habit on the board for something every day");
  const reminder = { id, at, text };
  return { plan: { ...plan, reminders: [...plan.reminders, reminder] }, label: `${clockText(at, now)} 提醒：${text}`, undo: { kind: "unschedule", id } };
}

export function planCancel(plan: PetPlan, args: Record<string, unknown>, now: number): PlanStep {
  const reminder = plan.reminders.find((item) => item.id === args.id);
  if (!reminder) throw new Error(`No one-off reminder with id "${String(args.id)}"`);
  return {
    plan: { ...plan, reminders: plan.reminders.filter((item) => item.id !== reminder.id) },
    label: `取消了 ${clockText(reminder.at, now)} 的提醒：${reminder.text}`,
    undo: { kind: "reschedule", reminder },
  };
}

export function undoPlan(plan: PetPlan, undo: PlanUndo): PetPlan {
  switch (undo.kind) {
    case "snooze":
      return { ...plan, snoozeUntil: undo.previous };
    case "unschedule":
      return { ...plan, reminders: plan.reminders.filter((item) => item.id !== undo.id) };
    case "reschedule":
      return plan.reminders.some((item) => item.id === undo.reminder.id) ? plan : { ...plan, reminders: [...plan.reminders, undo.reminder] };
  }
}

export const isSnoozed = (plan: PetPlan, now: number) => plan.snoozeUntil !== null && now < plan.snoozeUntil;

/** The earliest reminder whose time has come. */
export function dueReminder(plan: PetPlan, now: number): OneOffReminder | null {
  return plan.reminders.filter((item) => item.at <= now).sort((a, b) => a.at - b.at)[0] ?? null;
}

export const loadPetPlan = () => invoke<PetPlan>("load_pet_plan");
export const savePetPlan = (plan: PetPlan) => invoke<void>("save_pet_plan", { plan });
