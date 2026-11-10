import { describe, expect, it } from "vitest";
import { itemsInContainer } from "../boardLogic";
import { DEFAULT_ABILITY_FOREST, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "../defaults";
import type { BoardFile, Habit } from "../types";
import { AI_TOOLS, applyBoardBatch, boardIndex } from "./boardTools";
import { createToolSession } from "./session";

const createBoardSession = (board: BoardFile, settings = DEFAULT_SETTINGS) =>
  createToolSession({ board, settings, forests: { vision: DEFAULT_ABILITY_FOREST, research: DEFAULT_RESEARCH_AGENDA }, knowledge: [], memories: [], lifeStages: [] });

function habit(id: string, title: string, placement: Habit["placement"], order: number, extra: Partial<Habit> = {}): Habit {
  return { id, title, description: "", tags: "", placement, order, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...extra };
}

function board(items: Habit[]): BoardFile {
  return { schemaVersion: 1, activeBoardId: "main", boards: [{ id: "main", name: "My Life", items }, { id: "other", name: "Other", items: [] }] };
}

const morning = { kind: "period", period: "morning" } as const;
const evening = { kind: "period", period: "evening" } as const;
const items = (file: BoardFile) => file.boards[0].items;
const titles = (file: BoardFile, lane: Parameters<typeof itemsInContainer>[1]) => itemsInContainer(items(file), lane).map((item) => item.title);

describe("board tools", () => {
  const start = board([habit("a", "喝水", morning, 0), habit("b", "拉伸", morning, 1), habit("c", "读书", evening, 0)]);

  it("stages writes on a draft and never touches the confirmed board", async () => {
    const session = createBoardSession(start);
    const added = await session.run({ id: "1", name: "add_habit", arguments: { title: "晨跑", period: "morning", tags: "运动" } });
    expect(JSON.parse(added.content)).toMatchObject({ status: "staged", id: added.change!.createdId });
    expect(added.change).toMatchObject({ kind: "add", title: "晨跑", detail: "早上 · 运动", selected: true });

    // A later call in the same turn can build on the staged habit.
    const moved = await session.run({ id: "2", name: "move_habit", arguments: { id: added.change!.createdId, hour: 9 } });
    expect(moved.change).toMatchObject({ kind: "move", detail: "早上 → 09:00" });

    expect(JSON.parse((await session.run({ id: "3", name: "list_habits", arguments: {} })).content).habits).toHaveLength(3);
    expect(items(start)).toHaveLength(3);
  });

  it("returns model-readable errors for bad ids and ambiguous placements", async () => {
    const session = createBoardSession(start);
    const missing = await session.run({ id: "1", name: "delete_habit", arguments: { id: "nope" } });
    expect(missing.change).toBeUndefined();
    expect(JSON.parse(missing.content).error).toContain('No habit with id "nope"');
    const both = await session.run({ id: "2", name: "add_habit", arguments: { title: "x", period: "noon", hour: 3 } });
    expect(JSON.parse(both.content).error).toBe("Give exactly one of period or hour");
  });

  it("applies only the selected changes and reports the ones that no longer apply", async () => {
    const session = createBoardSession(start);
    const add = (await session.run({ id: "1", name: "add_habit", arguments: { title: "冥想", period: "morning", position: 1 } })).change!;
    const move = (await session.run({ id: "2", name: "move_habit", arguments: { id: add.createdId, period: "evening" } })).change!;
    const done = (await session.run({ id: "3", name: "set_habit_done", arguments: { id: "c", done: true } })).change!;
    const rename = (await session.run({ id: "4", name: "update_habit", arguments: { id: "b", title: "全身拉伸", tags: "运动" } })).change!;
    const remove = (await session.run({ id: "5", name: "delete_habit", arguments: { id: "a" } })).change!;
    expect(rename).toMatchObject({ kind: "edit", title: "拉伸", detail: "标题 → 全身拉伸 · tags → 运动" });

    // The user unchecks the add, so the move of that new habit cannot apply.
    const result = applyBoardBatch(start, [move, done, rename, remove]);
    expect(result.applied).toBe(3);
    expect(result.failed).toEqual([{ changeId: move.id, reason: `No habit with id "${add.createdId}" on the active board` }]);
    expect(titles(result.board, "period:morning")).toEqual(["全身拉伸"]);
    expect(items(result.board).find((item) => item.id === "c")?.done).toBe(true);
    expect(itemsInContainer(items(result.board), "period:morning")[0].order).toBe(0);
  });

  it("inserts at the requested position and moves to the end by default", async () => {
    const session = createBoardSession(start);
    const add = (await session.run({ id: "1", name: "add_habit", arguments: { title: "冥想", period: "morning", position: 1 } })).change!;
    const move = (await session.run({ id: "2", name: "move_habit", arguments: { id: "a", period: "evening" } })).change!;
    const { board: next } = applyBoardBatch(start, [add, move]);
    expect(titles(next, "period:morning")).toEqual(["冥想", "拉伸"]);
    expect(titles(next, "period:evening")).toEqual(["读书", "喝水"]);
    expect(next.boards[1]).toBe(start.boards[1]);
  });

  it("indexes the active board in display order without empty fields", async () => {
    const file = board([habit("x", "复盘", evening, 0, { tags: "每天", done: true }), habit("y", "早餐", morning, 0), habit("z", "开会", { kind: "hour", hour: 9 }, 0)]);
    expect(boardIndex(file, DEFAULT_SETTINGS)).toEqual({
      board: "My Life",
      habits: [
        { id: "y", title: "早餐", period: "morning", position: 0, done: false },
        { id: "x", title: "复盘", period: "evening", position: 0, tags: "每天", done: true },
        { id: "z", title: "开会", hour: 9, position: 0, done: false },
      ],
    });
  });

  it("keeps the registry in MCP shape with a panel and access level", async () => {
    for (const tool of AI_TOOLS) {
      expect(tool).toMatchObject({ name: expect.any(String), description: expect.any(String), inputSchema: { type: "object" } });
      expect(["read", "write"]).toContain(tool.access);
    }
  });
});
