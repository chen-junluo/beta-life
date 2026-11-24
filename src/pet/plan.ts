import { invoke } from "@tauri-apps/api/core";

/** bebe's short-lived plan (Rust `bebe::PetPlan`): applied at once by the AI, undone from the chat. */
export interface PetPlan {
  /** No slack reminders, questions or habit reminders before this. */
  snoozeUntil: number | null;
}

export const EMPTY_PLAN: PetPlan = { snoozeUntil: null };
/** Emitted by Rust to every window after the plan was saved. */
export const PET_PLAN = "pet://plan";

/** How to take one instant action back. */
export type PlanUndo = { kind: "snooze"; previous: number | null };

export interface PlanStep {
  plan: PetPlan;
  /** What bebe did, shown with the undo button. */
  label: string;
  undo: PlanUndo;
}

const MINUTE = 60_000;

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

/** Exactly one of `minutes` (from now) or `until` (a clock field). */
function whenOf(args: Record<string, unknown>, now: number): number {
  const minutes = args.minutes;
  const clock = args.until;
  if ((minutes === undefined) === (clock === undefined)) throw new Error("give either minutes or until");
  return clock !== undefined ? nextClock(String(clock), now) : now + Number(minutes) * MINUTE;
}

export function planSnooze(plan: PetPlan, args: Record<string, unknown>, now: number): PlanStep {
  const until = whenOf(args, now);
  const undo: PlanUndo = { kind: "snooze", previous: plan.snoozeUntil };
  if (until <= now) return { plan: { ...plan, snoozeUntil: null }, label: "提醒恢复了", undo };
  return { plan: { ...plan, snoozeUntil: until }, label: `暂停提醒到 ${clockText(until, now)}`, undo };
}

export function undoPlan(plan: PetPlan, undo: PlanUndo): PetPlan {
  return { ...plan, snoozeUntil: undo.previous };
}

export const isSnoozed = (plan: PetPlan, now: number) => plan.snoozeUntil !== null && now < plan.snoozeUntil;

export const loadPetPlan = () => invoke<PetPlan>("load_pet_plan");
export const savePetPlan = (plan: PetPlan) => invoke<void>("save_pet_plan", { plan });
