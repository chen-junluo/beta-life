// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_ABILITY_FOREST, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "../defaults";
import type { LoadedAppState } from "../types";
import { useAssistant } from "./useAssistant";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("useAssistant.startTask", () => {
  let host: HTMLDivElement;
  let root: Root;
  let assistant: ReturnType<typeof useAssistant>;
  const mockedInvoke = vi.mocked(invoke);
  const state = { board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, abilityForest: DEFAULT_ABILITY_FOREST, researchAgenda: DEFAULT_RESEARCH_AGENDA } as LoadedAppState;
  const noop = () => undefined;

  function Probe() {
    assistant = useAssistant({ activePanel: "board", getState: () => state, commitBoard: noop, commitForest: noop, recordRecall: noop, recordMemories: noop, recordDiary: noop });
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "list_diary_months") return Promise.resolve(["2611"]) as never;
      if (command === "load_diary_month") return Promise.resolve({ month: (args as { month: string }).month, days: [] }) as never;
      if (command === "ai_chat_step") {
        return Promise.resolve({ content: "", toolCalls: [{ id: "c1", name: "append_diary", arguments: { day: "261112", text: "- 时间轴：活跃 6h\n\t- 专注做了什么" } }] }) as never;
      }
      return Promise.resolve(null) as never;
    });
    host = document.createElement("div");
    root = createRoot(host);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    mockedInvoke.mockReset();
  });

  it("starts a new conversation with the task and scope, and leaves the AI's diary change for confirmation", async () => {
    await act(async () => {
      await assistant.startTask("summarize_day", { diary: "write", timeline: "read" }, "把 2026-11-12 的活动总结写进日记", "261112 日记总结");
    });
    expect(assistant.error).toBeNull();
    const step = mockedInvoke.mock.calls.find(([command]) => command === "ai_chat_step")![1] as { request: { scope: unknown; messages: Array<{ task?: string }> } };
    expect(step.request.scope).toEqual({ diary: "write", timeline: "read" });
    expect(step.request.messages[0].task).toBe("summarize_day");
    const conversation = assistant.conversation!;
    expect(conversation.panel).toBe("diary");
    expect(conversation.title).toBe("261112 日记总结");
    const batch = conversation.messages.at(-1);
    expect(batch?.role === "batch" && batch.batch).toMatchObject({ status: "pending", changes: [{ name: "append_diary", panel: "diary" }] });
  });
});
