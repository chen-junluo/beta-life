import { containerForPlacement, hourLabel, itemsInContainer, orderedPeriods, reindexItems } from "../boardLogic";
import type { AppSettings, BoardFile, Habit, PeriodId, Placement } from "../types";
import tools from "./tools.json";
import type { AiChange, AiToolSpec, ChangeKind, ToolArguments } from "./types";

export const AI_TOOLS = tools as AiToolSpec[];

type ChangeInput = Pick<AiChange, "name" | "arguments" | "createdId">;

function activeItems(file: BoardFile): Habit[] {
  return file.boards.find((board) => board.id === file.activeBoardId)?.items ?? [];
}

function withActiveItems(file: BoardFile, items: Habit[]): BoardFile {
  return {
    ...file,
    boards: file.boards.map((board) => (board.id === file.activeBoardId ? { ...board, items: reindexItems(items) } : board)),
  };
}

function findHabit(items: Habit[], id: unknown): Habit {
  const habit = items.find((item) => item.id === id);
  if (!habit) throw new Error(`No habit with id "${String(id)}" on the active board`);
  return habit;
}

function placementFrom(args: ToolArguments): Placement {
  const hasPeriod = typeof args.period === "string";
  const hasHour = typeof args.hour === "number";
  if (hasPeriod === hasHour) throw new Error("Give exactly one of period or hour");
  return hasHour ? { kind: "hour", hour: args.hour as number } : { kind: "period", period: args.period as PeriodId };
}

/** Puts `habit` at `position` inside its placement (clamped), renumbering that placement. */
function placeAt(items: Habit[], habit: Habit, position: number): Habit[] {
  const lane = itemsInContainer(items, containerForPlacement(habit.placement)).filter((item) => item.id !== habit.id);
  lane.splice(Math.min(position, lane.length), 0, habit);
  const order = new Map(lane.map((item, index) => [item.id, index]));
  const rest = items.filter((item) => item.id !== habit.id);
  return reindexItems([...rest, habit].map((item) => (order.has(item.id) ? { ...item, order: order.get(item.id)! } : item)));
}

/** Applies one board write to `file`. Throws with a model-readable reason when it cannot apply. */
export function applyBoardChange(file: BoardFile, change: ChangeInput, now = new Date().toISOString()): BoardFile {
  const items = activeItems(file);
  const args = change.arguments;
  switch (change.name) {
    case "add_habit": {
      if (!change.createdId) throw new Error("add_habit needs an id");
      const habit: Habit = {
        id: change.createdId,
        title: String(args.title).trim(),
        description: typeof args.description === "string" ? args.description : "",
        tags: typeof args.tags === "string" ? args.tags.trim() : "",
        placement: placementFrom(args),
        order: 0,
        createdAt: now,
        updatedAt: now,
      };
      return withActiveItems(file, placeAt(items, habit, typeof args.position === "number" ? args.position : 0));
    }
    case "update_habit": {
      const habit = findHabit(items, args.id);
      if (args.title === undefined && args.description === undefined && args.tags === undefined) {
        throw new Error("Nothing to update: give title, description or tags");
      }
      const next: Habit = {
        ...habit,
        ...(typeof args.title === "string" && { title: args.title.trim() }),
        ...(typeof args.description === "string" && { description: args.description }),
        ...(typeof args.tags === "string" && { tags: args.tags.trim() }),
        updatedAt: now,
      };
      return withActiveItems(file, items.map((item) => (item.id === habit.id ? next : item)));
    }
    case "move_habit": {
      const habit = findHabit(items, args.id);
      const moved = { ...habit, placement: placementFrom(args), updatedAt: now };
      return withActiveItems(file, placeAt(items, moved, typeof args.position === "number" ? args.position : Infinity));
    }
    case "delete_habit": {
      const habit = findHabit(items, args.id);
      return withActiveItems(file, items.filter((item) => item.id !== habit.id));
    }
    case "set_habit_done": {
      const habit = findHabit(items, args.id);
      return withActiveItems(file, items.map((item) => (item.id === habit.id ? { ...item, done: args.done === true, updatedAt: now } : item)));
    }
    default:
      throw new Error(`Unknown board tool ${change.name}`);
  }
}

export function placementLabel(placement: Placement, settings: AppSettings): string {
  if (placement.kind === "hour") return hourLabel(placement.hour);
  return settings.periods.find((period) => period.id === placement.period)?.label ?? placement.period;
}

/** Human-readable diff row, computed against the board before the change. */
export function describeBoardChange(file: BoardFile, change: ChangeInput, settings: AppSettings): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  const items = activeItems(file);
  const where = (placement: Placement) => placementLabel(placement, settings);
  switch (change.name) {
    case "add_habit":
      return { kind: "add", title: String(args.title).trim(), detail: [where(placementFrom(args)), args.tags].filter(Boolean).join(" · ") };
    case "update_habit": {
      const habit = findHabit(items, args.id);
      const parts = [
        typeof args.title === "string" && args.title.trim() !== habit.title && `标题 → ${args.title.trim()}`,
        typeof args.tags === "string" && `tags → ${args.tags.trim() || "（清空）"}`,
        typeof args.description === "string" && "备注已修改",
      ].filter(Boolean);
      return { kind: "edit", title: habit.title, detail: parts.join(" · ") || "内容不变" };
    }
    case "move_habit": {
      const habit = findHabit(items, args.id);
      return { kind: "move", title: habit.title, detail: `${where(habit.placement)} → ${where(placementFrom(args))}` };
    }
    case "delete_habit": {
      const habit = findHabit(items, args.id);
      return { kind: "del", title: habit.title, detail: where(habit.placement) };
    }
    case "set_habit_done": {
      const habit = findHabit(items, args.id);
      return { kind: "edit", title: habit.title, detail: args.done === true ? "标记为今天已完成" : "取消今天的完成" };
    }
    default:
      throw new Error(`Unknown board tool ${change.name}`);
  }
}

/** Compact index of the active board: the context the model always sees, and the list_habits result. */
export function boardIndex(file: BoardFile, settings: AppSettings) {
  const items = activeItems(file);
  const lanes = [
    ...orderedPeriods(settings).map((period) => `period:${period.id}` as const),
    ...Array.from({ length: 24 }, (_, hour) => `hour:${hour}` as const),
  ];
  const habits = lanes.flatMap((lane) =>
    itemsInContainer(items, lane).map((item, position) => ({
      id: item.id,
      title: item.title,
      ...(item.placement.kind === "hour" ? { hour: item.placement.hour } : { period: item.placement.period }),
      position,
      ...(item.tags && { tags: item.tags }),
      ...(item.description && { description: item.description }),
      done: Boolean(item.done),
    })),
  );
  const board = file.boards.find((entry) => entry.id === file.activeBoardId);
  return { board: board?.name ?? "", habits };
}

/** Replays the selected changes on the live board. Changes that no longer apply are reported, not thrown. */
export function applyBoardBatch(file: BoardFile, changes: AiChange[]) {
  let board = file;
  const failed: Array<{ changeId: string; reason: string }> = [];
  let applied = 0;
  for (const change of changes) {
    try {
      board = applyBoardChange(board, change);
      applied += 1;
    } catch (error) {
      failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { board, applied, failed };
}
