// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { EmotionType, LifeStage, Memory, MemoryMetadata } from "../types";
import { MemoriesView } from "./MemoriesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("./MemoryConstellation", () => ({
  MemoryConstellation: ({
    memories,
    previewIntensity,
    locations,
    songQuery,
    onToggleEmotion,
    onToggleLocation,
    onSongQueryChange,
    onResetFilters,
    onMemoryClick,
    onNewMemory,
  }: {
    memories: MemoryMetadata[];
    previewIntensity: { id: string; intensity: number } | null;
    locations: string[];
    songQuery: string;
    onToggleEmotion: (emotion: EmotionType) => void;
    onToggleLocation: (location: string) => void;
    onSongQueryChange: (query: string) => void;
    onResetFilters: () => void;
    onMemoryClick: (memory: MemoryMetadata) => void | Promise<void>;
    onNewMemory: () => void;
  }) => (
    <div
      className="test-constellation"
      data-memory-ids={memories.map((memory) => memory.id).join(",")}
      data-intensities={memories.map((memory) => `${memory.id}:${memory.emotion.intensity}`).join(",")}
      data-preview-intensity={previewIntensity ? `${previewIntensity.id}:${previewIntensity.intensity}` : ""}
    >
      <input aria-label="检索歌曲" value={songQuery} onChange={(event) => onSongQueryChange(event.target.value)} />
      <button type="button" onClick={() => onToggleEmotion("calm")}>情绪筛选</button>
      <button type="button" onClick={onResetFilters}>重置筛选</button>
      {locations.map((location) => (
        <button type="button" key={location} data-location={location} onClick={() => onToggleLocation(location)}>
          {location}
        </button>
      ))}
      <button type="button" onClick={() => memories[0] && void onMemoryClick(memories[0])}>打开第一条</button>
      <button type="button" onClick={() => { const target = memories.find((memory) => memory.id === "memory-calm"); if (target) void onMemoryClick(target); }}>打开强度目标</button>
      <button type="button" onClick={onNewMemory}>新建记忆</button>
    </div>
  ),
}));

const now = "2026-10-28T00:00:00.000Z";
const listedMemories: MemoryMetadata[] = [
  {
    id: "memory-calm",
    song: "晴天",
    date: "2021Q2",
    stage: "本科",
    location: "校园, 教室",
    emotion: { type: "calm", intensity: 6 },
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "memory-warm",
    song: "如愿",
    date: "2024Q4",
    stage: "PhD",
    location: "实验室",
    emotion: { type: "warm", intensity: 7 },
    createdAt: now,
    updatedAt: now,
  },
];
const lifeStages: LifeStage[] = [
  { name: "本科", start: "2019-09", end: "2023-08" },
  { name: "PhD", start: "2023-09", end: "2027-08" },
];
const fullMemory: Memory = {
  ...listedMemories[0],
  stage: listedMemories[0].stage ?? "",
  content: "校园里的春天，风很轻。",
};

describe("MemoriesView", () => {
  let host: HTMLDivElement;
  let root: Root;
  let currentMemories: MemoryMetadata[];
  const mockedInvoke = vi.mocked(invoke);

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    currentMemories = structuredClone(listedMemories);
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "list_memories") return Promise.resolve(currentMemories) as never;
      if (command === "load_life_stages") return Promise.resolve(lifeStages) as never;
      if (command === "read_memory") {
        const metadata = currentMemories.find((memory) => memory.id === (args as { id: string }).id);
        return Promise.resolve({ ...fullMemory, ...metadata }) as never;
      }
      if (command === "parse_memory_with_ai") {
        return Promise.resolve({ song: "晴天", date: "2021Q2", stage: "本科", location: "校园", emotion: { type: "warm", intensity: 8 }, content: "校庆夜里听着晴天，和室友走回宿舍。" }) as never;
      }
      if (command === "save_memory") {
        const memory = (args as { memory: Memory }).memory;
        currentMemories = [
          ...currentMemories.filter((item) => item.id !== memory.id),
          {
            id: memory.id,
            song: memory.song,
            date: memory.date,
            stage: memory.stage || undefined,
            location: memory.location,
            emotion: memory.emotion,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
          },
        ];
        return Promise.resolve(undefined) as never;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`)) as never;
    });
    await act(async () => {
      root.render(<MemoriesView hasApiKey onOpenSettings={vi.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    mockedInvoke.mockReset();
  });

  it("filters metadata and loads the Markdown body when a star is selected", async () => {
    expect(host.querySelector(".test-constellation")?.getAttribute("data-memory-ids")).toBe("memory-calm,memory-warm");
    expect(host.querySelector('[data-location="校园"]')).not.toBeNull();
    expect(host.querySelector('[data-location="教室"]')).not.toBeNull();

    const emotionFilter = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "情绪筛选");
    await act(async () => {
      emotionFilter?.click();
      await Promise.resolve();
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-memory-ids")).toBe("memory-calm");

    const locationFilter = host.querySelector<HTMLButtonElement>('[data-location="校园"]');
    await act(async () => {
      locationFilter?.click();
      host.querySelector<HTMLButtonElement>(".test-constellation button:nth-last-child(2)")?.click();
      await Promise.resolve();
    });

    expect(mockedInvoke).toHaveBeenCalledWith("read_memory", { id: "memory-calm" });
    expect(host.querySelector<HTMLTextAreaElement>("#memory-content")?.value).toBe(fullMemory.content);
  });

  it("filters memories by a partial song query and clears it with the shared reset", async () => {
    const search = host.querySelector<HTMLInputElement>('[aria-label="检索歌曲"]');
    expect(search).not.toBeNull();
    await act(async () => {
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(search, "晴");
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      }
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-memory-ids")).toBe("memory-calm");

    const reset = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "重置筛选");
    await act(async () => {
      reset?.click();
      await Promise.resolve();
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-memory-ids")).toBe("memory-calm,memory-warm");
  });

  it("previews intensity while editing, then reloads the persisted star metadata", async () => {
    const openButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "打开第一条");
    await act(async () => {
      openButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const intensity = host.querySelector<HTMLInputElement>("#memory-emotion-intensity");
    expect(intensity).not.toBeNull();
    await act(async () => {
      if (intensity) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(intensity, "10");
        intensity.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-preview-intensity")).toBe("memory-calm:10");
    expect(host.querySelector(".test-constellation")?.getAttribute("data-intensities")).toBe("memory-calm:6,memory-warm:7");

    const closeButton = host.querySelector<HTMLButtonElement>(".memory-editor-header .icon-button");
    await act(async () => {
      closeButton?.click();
      await Promise.resolve();
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-preview-intensity")).toBe("");
    expect(host.querySelector(".test-constellation")?.getAttribute("data-intensities")).toBe("memory-calm:6,memory-warm:7");

    const reopenUnchanged = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "打开强度目标");
    await act(async () => {
      reopenUnchanged?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const editedIntensity = host.querySelector<HTMLInputElement>("#memory-emotion-intensity");
    await act(async () => {
      if (editedIntensity) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(editedIntensity, "10");
        editedIntensity.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });

    const saveButton = host.querySelector<HTMLButtonElement>(".memory-editor-actions .primary-button");
    await act(async () => {
      saveButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector(".test-constellation")?.getAttribute("data-preview-intensity")).toBe("");
    expect(host.querySelector(".test-constellation")?.getAttribute("data-intensities")).toBe("memory-warm:7,memory-calm:10");

    const reopenButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "打开强度目标");
    await act(async () => {
      reopenButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector<HTMLInputElement>("#memory-emotion-intensity")?.value).toBe("10");
  });

  it("uses the AI intake tab to fill an editable Memory form and saves through the memory commands", async () => {
    const newMemory = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "新建记忆");
    act(() => newMemory?.click());

    const aiTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent?.includes("AI 识别"));
    act(() => aiTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const importText = host.querySelector<HTMLTextAreaElement>('[aria-label="用于 AI 识别的记忆正文"]');
    expect(importText).not.toBeNull();
    await act(async () => {
      if (importText) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(importText, "校庆夜里听着晴天，和室友走回宿舍。");
        importText.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });

    const analyzeButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("AI 识别并填入"));
    await act(async () => {
      analyzeButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedInvoke).toHaveBeenCalledWith("parse_memory_with_ai", { text: "校庆夜里听着晴天，和室友走回宿舍。", today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(host.querySelector<HTMLInputElement>("#memory-create-song")?.value).toBe("晴天");
    expect(host.querySelector<HTMLSelectElement>("#memory-create-emotion")?.value).toBe("warm");
    expect(host.querySelector<HTMLTextAreaElement>(".memory-create-content-field textarea")?.value).toBe("校庆夜里听着晴天，和室友走回宿舍。");

    const song = host.querySelector<HTMLInputElement>("#memory-create-song");
    await act(async () => {
      if (song) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(song, "晴天（修改后）");
        song.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    const saveButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("保存记忆"));
    await act(async () => {
      saveButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const saveCall = mockedInvoke.mock.calls.find(([command]) => command === "save_memory");
    const savedMemory = (saveCall?.[1] as { memory: Memory } | undefined)?.memory;
    expect(savedMemory?.createdAt).toBeTruthy();
    expect(savedMemory?.updatedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(savedMemory?.createdAt ?? ""))).toBe(false);
    expect(savedMemory?.song).toBe("晴天（修改后）");
    expect(savedMemory?.content).toBe("校庆夜里听着晴天，和室友走回宿舍。");
    expect(mockedInvoke).toHaveBeenCalledWith("list_memories");
    expect(mockedInvoke.mock.calls.some(([command]) => command === "save_knowledge" || command === "save_recall_points")).toBe(false);
    expect(host.querySelector(".memory-create-sheet")).toBeNull();
  });
});
