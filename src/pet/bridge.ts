import type { AiBatch, AiScope, Conversation } from "../ai/types";
import type { Habit, PeriodSetting } from "../types";

/** The main window owns the board; it pushes snapshots to the pet and applies the pet's requests. */
export const PET_READY = "pet://ready";
export const PET_BOARD = "pet://board";
export const PET_MARK_DONE = "pet://mark-done";

/** Emitted by Rust (see pet.rs): bebe makes way for the dock, the tray hid bebe, bebe was double-clicked. */
export const PET_PRESENCE = "pet://presence";
export const PET_USER_HIDDEN = "pet://user-hidden";
export const PET_SUMMON_DOCK = "pet://summon-dock";
/** Main → pet: the dock just flew into bebe. */
export const PET_DOCK_ARRIVED = "pet://dock-arrived";

/** The assistant runs in the main window; the pet shows its latest round and sends requests back. */
export const PET_CHAT = "pet://chat";
export const PET_CHAT_SEND = "pet://chat-send";
export const PET_CHAT_RESOLVE = "pet://chat-resolve";
export const PET_CHAT_STOP = "pet://chat-stop";
/** Pet → main: 写进日记 from the evening summary, and 看时间轴. */
export const PET_SUMMARY_DIARY = "pet://summary-diary";
export const PET_OPEN_TIMELINE = "pet://open-timeline";

/** A conversation started from bebe can read the panels (not the diary) and the timeline, and change the time board. */
export const PET_CHAT_SCOPE: AiScope = { board: "write", recall: "read", forest: "read", memories: "read", timeline: "read" };

export interface PetBoardSnapshot {
  items: Habit[];
  periods: PeriodSetting[];
}

export interface PetMarkDone {
  habitId: string;
}

export interface PetChatSnapshot {
  hasApiKey: boolean;
  busy: boolean;
  stopped: boolean;
  error: string | null;
  title: string | null;
  /** The latest round only: the user's last message, the reply after it, and its batch if any. */
  lastUser: string | null;
  reply: string | null;
  batch: AiBatch | null;
}

export interface PetChatSend {
  text: string;
}

export interface PetSummaryDiary {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `YYMMDD`. */
  day: string;
  /** Beta Life's statistics, kept as the first lines. */
  text: string;
}

/** The 写进日记 task: reads the timeline and the week's diary, appends to the day (confirmed in a diff card). */
export const PET_DIARY_SCOPE: AiScope = { diary: "write", timeline: "read" };

export interface PetChatResolve {
  batchId: string;
  selectedIds: string[] | null;
}

export function petChatSnapshot(
  conversation: Conversation | null,
  state: Pick<PetChatSnapshot, "hasApiKey" | "busy" | "stopped" | "error">,
): PetChatSnapshot {
  const messages = conversation?.messages ?? [];
  let start = messages.length;
  while (start > 0 && messages[start - 1].role !== "user") start -= 1;
  const user = messages[start - 1];
  const round = messages.slice(start);
  const reply = round.flatMap((message) => (message.role === "assistant" && message.content.trim() ? [message.content] : [])).at(-1) ?? null;
  const batch = round.flatMap((message) => (message.role === "batch" ? [message.batch] : [])).at(-1) ?? null;
  return { ...state, title: conversation?.title ?? null, lastUser: user?.role === "user" ? user.content || (user.images?.length ? `[图片 ×${user.images.length}]` : "") : null, reply, batch };
}
