// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import type { Conversation } from "./ai/types";
import { DEFAULT_ABILITY_FOREST, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "./defaults";
import { PET_SUMMON_DOCK } from "./pet/bridge";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: () => Promise.resolve(),
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  },
}));

const conversation: Conversation = {
  id: "old",
  title: "上午研究任务挪到下午",
  panel: "board",
  createdAt: "2026-11-10T08:00:00Z",
  updatedAt: "2026-11-10T08:00:00Z",
  messages: [
    { id: "u", role: "user", content: "把上午的研究任务挪到下午", scope: { board: "write" }, createdAt: "2026-11-10T08:00:00Z" },
    { id: "a", role: "assistant", content: "已经看过时间板了。", toolCalls: [], createdAt: "2026-11-10T08:00:00Z" },
  ],
};

describe("App and bebe", () => {
  let host: HTMLDivElement;
  let root: Root;
  const mockedInvoke = vi.mocked(invoke);

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
    mockedInvoke.mockImplementation((command) => {
      const replies: Record<string, unknown> = {
        load_app_state: { board: structuredClone(DEFAULT_BOARD), settings: structuredClone(DEFAULT_SETTINGS), abilityForest: structuredClone(DEFAULT_ABILITY_FOREST), researchAgenda: structuredClone(DEFAULT_RESEARCH_AGENDA), hasApiKey: true },
        list_ai_conversations: [{ ...conversation, messages: undefined }],
        load_ai_conversation: conversation,
        pet_hidden_by_user: false,
      };
      return Promise.resolve(replies[command]) as never;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mockedInvoke.mockReset();
    handlers.clear();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("double-clicking bebe starts a new conversation in the dock and focuses it", async () => {
    expect(host.querySelector<HTMLTextAreaElement>(".ai-dock-input")?.placeholder).toBe("继续对话…");

    await act(async () => handlers.get(PET_SUMMON_DOCK)?.({ payload: null }));

    const input = host.querySelector<HTMLTextAreaElement>(".ai-dock-input");
    expect(host.querySelector(".ai-dock-pills")?.textContent).toContain("@时间板");
    expect(input?.placeholder).not.toBe("继续对话…");
    expect(document.activeElement).toBe(input);
    expect(host.querySelector(".ai-dock")?.hasAttribute("hidden")).toBe(false);
  });

  it("tells Rust the dock is in front unless it is minimized into bebe", async () => {
    const visibility = () => mockedInvoke.mock.calls.filter(([command]) => command === "set_dock_visible").map(([, args]) => (args as { visible: boolean }).visible);
    expect(visibility().at(-1)).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="缩小成 bebe"]')?.click());
    expect(host.querySelector(".ai-dock")?.hasAttribute("hidden")).toBe(true);
    expect(visibility().at(-1)).toBe(false);

    await act(async () => handlers.get(PET_SUMMON_DOCK)?.({ payload: null }));
    expect(visibility().at(-1)).toBe(true);
  });
});
