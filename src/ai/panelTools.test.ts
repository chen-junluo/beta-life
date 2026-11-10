// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ABILITY_FOREST, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "../defaults";
import type { KnowledgeRecord, LifeStage, LoadedAppState, Memory, MemoryMetadata } from "../types";
import { applyForestChange, describeForestChange, forestIndex, type Forests } from "./forestTools";
import { applyMemoryChange, asMemories, describeMemoryChange } from "./memoryTools";
import { applyRecallChange, describeRecallChange, dueRecords } from "./recallTools";
import { assistantContext, commitChanges, createToolSession, type AssistantData } from "./session";
import type { AiChange } from "./types";

const store = vi.hoisted(() => ({ memories: new Map<string, Memory>(), knowledge: [] as KnowledgeRecord[], calls: [] as Array<[string, unknown]> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    store.calls.push([command, args]);
    switch (command) {
      case "list_memories": return [...store.memories.values()].map(({ content: _content, ...metadata }) => metadata);
      case "load_life_stages": return [{ name: "高中", start: "2010-09", end: "2013-06" }];
      case "read_memory": return store.memories.get(String(args.id));
      case "list_knowledge": return store.knowledge;
      case "load_recall_points":
      case "load_recall_reviews": return [];
      default: return null;
    }
  }),
}));

const forests: Forests = { vision: DEFAULT_ABILITY_FOREST, research: DEFAULT_RESEARCH_AGENDA };
const stages: LifeStage[] = [{ name: "高中", start: "2010-09", end: "2013-06" }];
const memory: Memory = { id: "m1", song: "晴天", date: "2012Q3", stage: "高中", location: "上海", emotion: { type: "nostalgic", intensity: 7 }, content: "操场", createdAt: "", updatedAt: "" };
const knowledge: KnowledgeRecord = { id: "k1", title: "制度同构", markdown: "强制、模仿、规范", tags: "社会学/组织", createdAt: "", updatedAt: "", nextReviewAt: "2000-01-01T00:00:00Z" };
const input = (name: string, args: Record<string, unknown>, createdId?: string) => ({ name, arguments: args, createdId });

function data(overrides: Partial<AssistantData> = {}): AssistantData {
  const { content: _content, ...metadata } = memory;
  return { board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, forests, knowledge: [knowledge], memories: [metadata as MemoryMetadata], lifeStages: stages, ...overrides };
}

describe("forest tools", () => {
  const root = DEFAULT_ABILITY_FOREST.nodes.find((node) => node.level === 0)!;
  const group = DEFAULT_ABILITY_FOREST.nodes.find((node) => node.parentId === root.id)!;

  it("adds a node under a parent at the next level with the given id", () => {
    const next = applyForestChange(forests, input("add_node", { map: "vision", name: "数据可视化", parentId: group.id }, "n-new"));
    expect(next.vision.nodes.find((node) => node.id === "n-new")).toMatchObject({ name: "数据可视化", level: 2, parentId: group.id });
    expect(next.research).toBe(forests.research);
    expect(describeForestChange(forests, input("add_node", { map: "vision", name: "x", parentId: group.id })).detail).toContain(`${group.name} 下的能力`);
  });

  it("deletes a whole subtree and says how many nodes go with it", () => {
    const size = DEFAULT_ABILITY_FOREST.nodes.filter((node) => node.parentId === group.id).length;
    const next = applyForestChange(forests, input("delete_node", { map: "vision", id: group.id }));
    expect(next.vision.nodes.some((node) => node.parentId === group.id || node.id === group.id)).toBe(false);
    expect(describeForestChange(forests, input("delete_node", { map: "vision", id: group.id })).detail).toContain(`连同下面 ${size} 个节点`);
  });

  it("rejects a color on non-root nodes and children under level-2 nodes", () => {
    expect(() => applyForestChange(forests, input("update_node", { map: "vision", id: group.id, color: "#000000" }))).toThrow("level-0");
    const leaf = DEFAULT_ABILITY_FOREST.nodes.find((node) => node.level === 2)!;
    expect(() => applyForestChange(forests, input("add_node", { map: "vision", name: "x", parentId: leaf.id }, "n"))).toThrow();
  });

  it("moves a node to the top level with parentId \"\"", () => {
    const next = applyForestChange(forests, input("move_node", { map: "vision", id: group.id, parentId: "" }));
    expect(next.vision.nodes.find((node) => node.id === group.id)).toMatchObject({ level: 0, parentId: null });
  });

  it("indexes both maps in tree order without notes", () => {
    const index = forestIndex(forests);
    expect(index.maps.map((map) => map.map)).toEqual(["vision", "research"]);
    expect(index.maps[0].nodes[0]).not.toHaveProperty("markdown");
    expect(index.maps[0].nodes[1].parentId).toBe(index.maps[0].nodes[0].id);
  });
});

describe("recall tools", () => {
  it("adds, updates with normalized tag paths, and deletes records", () => {
    const added = applyRecallChange([knowledge], input("add_knowledge", { title: " 弱关系 ", markdown: "格兰诺维特", tags: "社会学\n网络" }, "k2"), "now");
    expect(added[0]).toMatchObject({ id: "k2", title: "弱关系", tags: "社会学/网络", createdAt: "now" });
    const updated = applyRecallChange(added, input("update_knowledge", { id: "k1", tags: "组织, 制度" }));
    expect(updated.find((record) => record.id === "k1")?.tags).toBe("组织/制度");
    expect(applyRecallChange(updated, input("delete_knowledge", { id: "k1" })).map((record) => record.id)).toEqual(["k2"]);
    expect(() => applyRecallChange([knowledge], input("delete_knowledge", { id: "nope" }))).toThrow('No knowledge record with id "nope"');
    expect(describeRecallChange([knowledge], input("update_knowledge", { id: "k1", title: "制度同构论" })).detail).toBe("标题 → 制度同构论");
  });

  it("treats records without a next review as due", () => {
    expect(dueRecords([knowledge, { ...knowledge, id: "k3", nextReviewAt: "2999-01-01T00:00:00Z" }, { ...knowledge, id: "k4", nextReviewAt: undefined }]).map((record) => record.id)).toEqual(["k1", "k4"]);
  });
});

describe("memory tools", () => {
  it("checks stages against the life stages and keeps other fields on update", () => {
    expect(() => applyMemoryChange([], input("add_memory", { content: "x", date: "2020Q1", emotion: "calm", intensity: 3, stage: "大学" }, "m2"), stages)).toThrow("stage must be one of: 高中");
    const updated = applyMemoryChange([memory], input("update_memory", { id: "m1", intensity: 9, stage: "" }), stages, "now");
    expect(updated[0]).toMatchObject({ song: "晴天", stage: "", emotion: { type: "nostalgic", intensity: 9 }, content: "操场", updatedAt: "now" });
    expect(describeMemoryChange([memory], input("update_memory", { id: "m1", emotion: "warm" })).detail).toBe("情绪 → 温暖");
  });

  it("stages against metadata padded to the memory shape", () => {
    const { content: _content, ...metadata } = memory;
    expect(asMemories([metadata as MemoryMetadata])[0]).toMatchObject({ id: "m1", content: "" });
  });
});

describe("assistant session", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    store.memories = new Map([["m1", memory]]);
    store.knowledge = [knowledge];
    store.calls = [];
  });

  it("only puts readable panels into the context", () => {
    const context = JSON.parse(assistantContext({ forest: "read", memories: "write" }, data()));
    expect(Object.keys(context).sort()).toEqual(["forest", "memories", "now"]);
    expect(context.memories.memories[0]).toEqual({ id: "m1", song: "晴天", date: "2012Q3", stage: "高中", location: "上海", emotion: "nostalgic", intensity: 7 });
  });

  it("stages writes per panel and reads memory bodies on demand", async () => {
    const session = createToolSession(data());
    const read = JSON.parse((await session.run({ id: "1", name: "read_memory", arguments: { id: "m1" } })).content);
    expect(read.content).toBe("操场");
    const staged = await session.run({ id: "2", name: "add_memory", arguments: { content: "毕业合唱", date: "2013Q2", emotion: "warm", intensity: 8 } });
    expect(staged.change).toMatchObject({ panel: "memories", kind: "add" });
    expect(staged.change?.createdId).toMatch(/^memory_\d+_[a-z0-9]+$/);
    expect(store.calls.some(([command]) => command === "save_memory")).toBe(false);
  });

  it("commits each panel once and returns undo snapshots", async () => {
    const session = createToolSession(data());
    const group = DEFAULT_ABILITY_FOREST.nodes.find((node) => node.level === 1)!;
    const changes = [
      (await session.run({ id: "1", name: "update_memory", arguments: { id: "m1", song: "七里香" } })).change!,
      (await session.run({ id: "2", name: "update_node", arguments: { map: "vision", id: group.id, name: "新名字" } })).change!,
      (await session.run({ id: "3", name: "delete_knowledge", arguments: { id: "k1" } })).change!,
      { ...(await session.run({ id: "4", name: "delete_memory", arguments: { id: "m1" } })).change!, selected: false },
    ] as AiChange[];
    const state = { board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, abilityForest: DEFAULT_ABILITY_FOREST, researchAgenda: DEFAULT_RESEARCH_AGENDA, hasApiKey: true } as LoadedAppState;
    const targets = { getState: () => state, commitBoard: vi.fn(), commitForest: vi.fn(), recordRecall: vi.fn(), recordMemories: vi.fn() };
    const failed = await commitChanges(changes.filter((change) => change.selected), targets);
    expect(failed).toEqual([]);
    expect(targets.commitBoard).not.toHaveBeenCalled();
    expect(targets.commitForest).toHaveBeenCalledTimes(1);
    expect(targets.commitForest.mock.calls[0][1].nodes.find((node: { id: string }) => node.id === group.id).name).toBe("新名字");
    expect(targets.recordMemories).toHaveBeenCalledWith([{ id: "m1", memory }], [{ id: "m1", memory: expect.objectContaining({ song: "七里香", content: "操场" }) }]);
    expect(targets.recordRecall.mock.calls[0][1]).toEqual([{ id: "k1", record: null, points: [], reviews: [] }]);
    expect(store.calls.filter(([command]) => command === "save_memory")).toHaveLength(1);
    expect(store.calls.some(([command, args]) => command === "delete_knowledge" && (args as { knowledgeId: string }).knowledgeId === "k1")).toBe(true);
  });
});
