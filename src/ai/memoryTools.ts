import { invoke } from "@tauri-apps/api/core";
import { MEMORY_EMOTIONS } from "../memoryLogic";
import { restoreMemorySnapshot, type MemorySnapshot } from "../memoryStorage";
import type { EmotionType, LifeStage, Memory, MemoryMetadata } from "../types";
import type { AiChange, ChangeKind } from "./types";

type ChangeInput = Pick<AiChange, "name" | "arguments" | "createdId">;
type Failure = { changeId: string; reason: string };

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const emotionLabel = (type: EmotionType) => MEMORY_EMOTIONS.find((emotion) => emotion.value === type)?.label ?? type;

export function newMemoryId(): string {
  return `memory_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function findMemory(memories: Memory[], id: unknown): Memory {
  const memory = memories.find((item) => item.id === id);
  if (!memory) throw new Error(`No memory with id "${String(id)}"`);
  return memory;
}

function checkStage(stage: string | undefined, stages: LifeStage[]): void {
  if (stage && !stages.some((item) => item.name === stage)) {
    throw new Error(`stage must be one of: ${stages.map((item) => item.name).join(", ") || "(no stages defined)"}`);
  }
}

export function memoryIndex(memories: MemoryMetadata[], stages: LifeStage[]) {
  return {
    lifeStages: stages.map(({ name, start, end }) => ({ name, start, end })),
    memories: memories.map((memory) => ({
      id: memory.id,
      ...(memory.song && { song: memory.song }),
      date: memory.date,
      ...(memory.stage && { stage: memory.stage }),
      ...(memory.location && { location: memory.location }),
      emotion: memory.emotion.type,
      intensity: memory.emotion.intensity,
    })),
  };
}

/** Metadata padded to the Memory shape so staged writes can be checked without reading bodies. */
export function asMemories(memories: MemoryMetadata[]): Memory[] {
  return memories.map((memory) => ({ ...memory, stage: memory.stage ?? "", content: "" }));
}

/** Applies one memory write to the list. */
export function applyMemoryChange(memories: Memory[], change: ChangeInput, stages: LifeStage[], now = new Date().toISOString()): Memory[] {
  const args = change.arguments;
  switch (change.name) {
    case "add_memory": {
      if (!change.createdId) throw new Error("add_memory needs an id");
      checkStage(text(args.stage)?.trim(), stages);
      const memory: Memory = {
        id: change.createdId,
        song: text(args.song)?.trim() ?? "",
        date: String(args.date).trim(),
        stage: text(args.stage)?.trim() ?? "",
        location: text(args.location)?.trim() ?? "",
        emotion: { type: args.emotion as EmotionType, intensity: args.intensity as number },
        content: String(args.content),
        createdAt: now,
        updatedAt: now,
      };
      return [...memories, memory];
    }
    case "update_memory": {
      const memory = findMemory(memories, args.id);
      const fields = ["content", "song", "date", "stage", "location", "emotion", "intensity"].filter((field) => args[field] !== undefined);
      if (fields.length === 0) throw new Error("Nothing to update");
      checkStage(text(args.stage)?.trim(), stages);
      const next: Memory = {
        ...memory,
        ...(text(args.content) !== undefined && { content: text(args.content)! }),
        ...(text(args.song) !== undefined && { song: text(args.song)!.trim() }),
        ...(text(args.date) !== undefined && { date: text(args.date)!.trim() }),
        ...(text(args.stage) !== undefined && { stage: text(args.stage)!.trim() }),
        ...(text(args.location) !== undefined && { location: text(args.location)!.trim() }),
        emotion: {
          type: (args.emotion as EmotionType | undefined) ?? memory.emotion.type,
          intensity: (args.intensity as number | undefined) ?? memory.emotion.intensity,
        },
        updatedAt: now,
      };
      return memories.map((item) => (item.id === memory.id ? next : item));
    }
    case "delete_memory": {
      const memory = findMemory(memories, args.id);
      return memories.filter((item) => item.id !== memory.id);
    }
    default:
      throw new Error(`Unknown memory tool ${change.name}`);
  }
}

function label(memory: Pick<Memory, "song" | "content">): string {
  return memory.song || memory.content.trim().slice(0, 24) || "（无标题记忆）";
}

export function describeMemoryChange(memories: Memory[], change: ChangeInput): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  switch (change.name) {
    case "add_memory":
      return {
        kind: "add",
        title: label({ song: text(args.song)?.trim() ?? "", content: String(args.content) }),
        detail: [args.date, args.stage, args.location, `${emotionLabel(args.emotion as EmotionType)} ${args.intensity}`].filter(Boolean).join(" · "),
      };
    case "update_memory": {
      const memory = findMemory(memories, args.id);
      const names: Record<string, string> = { content: "正文", song: "歌曲", date: "日期", stage: "阶段", location: "地点", emotion: "情绪", intensity: "强度" };
      const parts = Object.keys(names).filter((field) => args[field] !== undefined).map((field) => (field === "content" ? "正文已修改" : `${names[field]} → ${field === "emotion" ? emotionLabel(args.emotion as EmotionType) : String(args[field]) || "（清空）"}`));
      return { kind: "edit", title: label(memory), detail: parts.join(" · ") };
    }
    case "delete_memory": {
      const memory = findMemory(memories, args.id);
      return { kind: "del", title: label(memory), detail: memory.date };
    }
    default:
      throw new Error(`Unknown memory tool ${change.name}`);
  }
}

export async function loadMemoryData(): Promise<{ memories: MemoryMetadata[]; lifeStages: LifeStage[] }> {
  const [memories, lifeStages] = await Promise.all([invoke<MemoryMetadata[]>("list_memories"), invoke<LifeStage[]>("load_life_stages")]);
  return { memories, lifeStages };
}

export async function readMemory(id: string): Promise<Memory> {
  return invoke<Memory>("read_memory", { id });
}

/** Replays confirmed memory changes on the full stored memories and writes the result. */
export async function commitMemoryChanges(changes: AiChange[]) {
  const { memories: metadata, lifeStages } = await loadMemoryData();
  const known = new Set(metadata.map((memory) => memory.id));
  const ids = [...new Set(changes.map((change) => change.createdId ?? String(change.arguments.id)))];
  const current = (await Promise.all(ids.filter((id) => known.has(id)).map(readMemory))).map((memory) => ({ ...memory, stage: memory.stage ?? "" }));
  let memories = current;
  const failed: Failure[] = [];
  for (const change of changes) {
    try {
      memories = applyMemoryChange(memories, change, lifeStages);
    } catch (error) {
      failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const before: MemorySnapshot[] = [];
  const after: MemorySnapshot[] = [];
  for (const id of ids) {
    const old = current.find((memory) => memory.id === id) ?? null;
    const next = memories.find((memory) => memory.id === id) ?? null;
    if (old === null && next === null) continue;
    if (old !== null && next !== null && old === next) continue;
    before.push({ id, memory: old });
    after.push({ id, memory: next });
  }
  for (const snapshot of after) await restoreMemorySnapshot(snapshot);
  return { before, after, failed };
}
