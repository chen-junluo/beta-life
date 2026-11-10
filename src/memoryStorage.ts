import { invoke } from "@tauri-apps/api/core";
import type { Memory } from "./types";

/** A memory before or after a change; `memory: null` means it did not exist. */
export interface MemorySnapshot {
  id: string;
  memory: Memory | null;
}

/** The payload MemoriesView sends to `save_memory`: an empty stage is stored as null. */
export function memoryForSave(memory: Memory, now = new Date().toISOString()) {
  return { ...memory, stage: memory.stage?.trim() || null, createdAt: memory.createdAt || now, updatedAt: now };
}

/** Writes a snapshot back: saves the memory, or deletes it if it did not exist. */
export async function restoreMemorySnapshot(snapshot: MemorySnapshot): Promise<void> {
  if (snapshot.memory) await invoke("save_memory", { memory: { ...snapshot.memory, stage: snapshot.memory.stage?.trim() || null } });
  else await invoke("delete_memory", { id: snapshot.id });
}
