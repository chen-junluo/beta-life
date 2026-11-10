// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../ai/types";
import { AiDock } from "./AiDock";

const conversation: Conversation = {
  id: "conv",
  title: "整理早上",
  panel: "board",
  createdAt: "",
  updatedAt: "",
  messages: [
    { id: "u", role: "user", content: "整理早上", scope: { board: "write" }, createdAt: "" },
    { id: "a", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_habits", arguments: {} }], createdAt: "" },
    {
      id: "b",
      role: "batch",
      createdAt: "",
      batch: {
        id: "batch",
        panel: "board",
        status: "pending",
        changes: [
          { id: "x", toolCallId: "c2", name: "add_habit", arguments: {}, createdId: "n", kind: "add", title: "晨跑", detail: "早上", selected: true },
          { id: "y", toolCallId: "c3", name: "delete_habit", arguments: {}, kind: "del", title: "喝水", detail: "早上", selected: true },
        ],
      },
    },
  ],
};

describe("AiDock", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: Partial<Parameters<typeof AiDock>[0]> = {}) {
    const handlers = { onSend: vi.fn(), onResolveBatch: vi.fn(), onNewConversation: vi.fn(), onOpenSettings: vi.fn() };
    act(() => root.render(<AiDock conversation={conversation} busy={false} error={null} hasApiKey {...handlers} {...props} />));
    return handlers;
  }

  it("opens on a pending batch and confirms only the checked changes", () => {
    const { onResolveBatch } = render();
    expect(host.textContent).toContain("读取了时间板的全部习惯");
    expect(host.textContent).toContain("待确认修改 · 2 项");
    const checkboxes = host.querySelectorAll<HTMLInputElement>(".ai-diff-row input");
    act(() => checkboxes[1].click());
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("确认"))!;
    expect(confirm.textContent).toBe("确认 1 项");
    act(() => confirm.click());
    expect(onResolveBatch).toHaveBeenCalledWith("batch", ["x"]);
    expect(host.querySelector(".ai-dock-card")).toBeNull();
  });

  it("sends on Enter with the board scope but not while an IME is composing", () => {
    const { onSend } = render({ conversation: null });
    const input = host.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "加一个晨跑");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith("加一个晨跑", { board: "write" });
  });

  it("asks for an API key instead of showing the input", () => {
    const { onOpenSettings } = render({ conversation: null, hasApiKey: false });
    expect(host.querySelector("textarea")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".ai-dock-setup")!.click());
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
