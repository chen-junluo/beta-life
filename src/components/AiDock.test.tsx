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
    const handlers = { onSend: vi.fn(), onResolveBatch: vi.fn(), onNewConversation: vi.fn(), onOpenSettings: vi.fn(), onScopeChange: vi.fn(), onStop: vi.fn(), onRename: vi.fn(), onRemoveTask: vi.fn() };
    act(() => root.render(
      <AiDock conversation={conversation} busy={false} error={null} hasApiKey activePanel="board" scope={{ board: "write" }} focusRequest={0} stopped={false} supportsImages task={null} {...handlers} {...props} />,
    ));
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

  it("sends on Enter but not while an IME is composing", () => {
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
    expect(onSend).toHaveBeenCalledWith("加一个晨跑", []);
  });

  function type(input: HTMLTextAreaElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const key = (input: HTMLTextAreaElement, name: string) => act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

  it("sets every panel in the @ picker and applies them with one Enter", () => {
    const { onScopeChange } = render({ conversation: null });
    const input = host.querySelector("textarea")!;
    type(input, "总结一下 @记忆");
    expect(host.querySelectorAll(".ai-mention-row")).toHaveLength(5);
    expect(host.querySelector(".ai-mention-row.is-active")?.textContent).toContain("记忆星云");
    key(input, "ArrowRight");
    key(input, "ArrowUp");
    key(input, "ArrowRight");
    key(input, "ArrowRight");
    key(input, "ArrowUp");
    key(input, "ArrowUp");
    key(input, "ArrowLeft");
    expect(onScopeChange).not.toHaveBeenCalled();
    key(input, "Enter");
    expect(onScopeChange).toHaveBeenCalledWith({ board: "read", forest: "write", memories: "read" });
    expect(input.value).toBe("总结一下 ");
    expect(host.querySelector(".ai-mention-menu")).toBeNull();
  });

  it("opens the picker from the @ button and cancels with Escape", () => {
    const { onScopeChange } = render({ conversation: null });
    const button = host.querySelector<HTMLButtonElement>(".ai-dock-at")!;
    act(() => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(host.querySelector(".ai-mention-menu")).not.toBeNull();
    key(host.querySelector("textarea")!, "Escape");
    expect(host.querySelector(".ai-mention-menu")).toBeNull();
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("deletes the last pill with Backspace at the start of the input", () => {
    const { onScopeChange } = render({ conversation: null, scope: { board: "write", memories: "read" } });
    const input = host.querySelector("textarea")!;
    key(input, "Backspace");
    expect(onScopeChange).toHaveBeenCalledWith({ board: "write" });
  });

  it("shows the entry chip ahead of the pills; Backspace removes pills first, then the chip", () => {
    const { onScopeChange, onRemoveTask } = render({ conversation: null, task: "extract_habits", scope: {} });
    const chip = host.querySelector(".ai-task-chip")!;
    expect(chip.textContent).toBe("提取习惯");
    expect(chip.nextElementSibling?.className).toBe("ai-at-ghost");
    key(host.querySelector("textarea")!, "Backspace");
    expect(onRemoveTask).toHaveBeenCalled();
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("keeps the chip on the first message once the conversation started", () => {
    render({
      task: "extract_habits",
      expandRequest: 1,
      conversation: { ...conversation, messages: [{ id: "u", role: "user", content: "", scope: { board: "write" }, task: "extract_habits", images: [{ id: "i", name: "plan.png", thumbnail: "data:image/jpeg;base64,AA" }], createdAt: "" }] },
    });
    expect(host.querySelector(".ai-dock-pills")).toBeNull();
    expect(host.querySelector(".ai-msg-user-wrap .ai-task-chip")?.textContent).toBe("提取习惯");
    expect(host.querySelector<HTMLImageElement>(".ai-msg-images img")?.alt).toBe("plan.png");
    expect(host.querySelector(".ai-msg-user")).toBeNull();
  });

  it("refuses pasted images when the provider has no image support, and keeps text paste", () => {
    render({ conversation: null, supportsImages: false });
    const input = host.querySelector("textarea")!;
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [file] } });
    act(() => input.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    expect(host.querySelector(".ai-dock-image-notice")?.textContent).toContain("没有开启图片能力");
    expect(host.querySelector(".ai-dock-thumb")).toBeNull();
    const text = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(text, { clipboardData: { files: [] } });
    act(() => input.dispatchEvent(text));
    expect(text.defaultPrevented).toBe(false);
  });

  it("turns send into stop while the assistant is working", () => {
    const { onStop } = render({ busy: true });
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!.click());
    expect(onStop).toHaveBeenCalled();
    expect(host.querySelector(".ai-dock-new")?.textContent).toBe("新对话");
  });

  it("keeps pills when the panel changes and offers a one-click add for the current panel", () => {
    const { onScopeChange } = render({ conversation: null, activePanel: "forest" });
    expect([...host.querySelectorAll(".ai-at-pill-main")].map((pill) => pill.textContent)).toEqual(["@时间板"]);
    const ghost = host.querySelector<HTMLButtonElement>(".ai-at-ghost")!;
    expect(ghost.textContent).toBe("@能力森林");
    act(() => ghost.click());
    expect(onScopeChange).toHaveBeenCalledWith({ board: "write", forest: "write" });
    act(() => host.querySelector<HTMLButtonElement>(".ai-at-pill-main")!.click());
    expect(onScopeChange).toHaveBeenLastCalledWith({ board: "read" });
    act(() => host.querySelector<HTMLButtonElement>(".ai-at-pill-remove")!.click());
    expect(onScopeChange).toHaveBeenLastCalledWith({});
  });

  const continued: Conversation = {
    ...conversation,
    messages: [
      { id: "u1", role: "user", content: "看看记忆", scope: { board: "write", memories: "read" }, createdAt: "" },
      { id: "a1", role: "assistant", content: "有 3 条记忆。", toolCalls: [], createdAt: "" },
      { id: "u2", role: "user", content: "再加一个习惯", scope: { board: "write", memories: "write" }, createdAt: "" },
      { id: "a2", role: "assistant", content: "好的。", toolCalls: [], createdAt: "" },
    ],
  };

  it("after the first message the input is plain text and permissions move to the header", () => {
    const { onScopeChange } = render({ conversation: continued, scope: { board: "write", memories: "write" }, busy: true });
    expect(host.querySelector(".ai-dock-pills")).toBeNull();
    expect(host.querySelector(".ai-dock-at")).toBeNull();
    expect(host.querySelector(".ai-dock-title")?.textContent).toBe("整理早上");
    expect(host.querySelectorAll(".ai-scope-dot:not(.is-ghost)")).toHaveLength(2);
    // The whole conversation is shown, with a scope line only where it changed.
    expect(host.querySelector(".ai-dock-body")?.textContent).toContain("有 3 条记忆。");
    expect([...host.querySelectorAll(".ai-msg-scope")].map((line) => line.textContent)).toEqual(["权限改为：可改时间板 · 可改记忆星云"]);
    const input = host.querySelector("textarea")!;
    type(input, "发邮件给 a@b");
    expect(host.querySelector(".ai-mention-menu")).toBeNull();
    act(() => { host.querySelector(".ai-scope-edit")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(host.querySelector(".ai-mention-menu.is-header")).not.toBeNull();
    key(input, "ArrowDown");
    key(input, "ArrowRight");
    key(input, "Enter");
    expect(onScopeChange).toHaveBeenCalledWith({ board: "write", recall: "read", memories: "write" });
  });

  it("renames the conversation from its title", () => {
    const { onRename } = render({ conversation: continued, busy: true });
    act(() => host.querySelector<HTMLButtonElement>(".ai-dock-title")!.click());
    const field = host.querySelector<HTMLInputElement>(".ai-dock-title-input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(field, "记忆整理");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onRename).toHaveBeenCalledWith("记忆整理");
  });

  it("offers an expand button while the conversation card is collapsed", () => {
    render({ conversation: continued });
    expect(host.querySelector(".ai-dock-card")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="展开对话"]')!.click());
    expect(host.querySelector(".ai-dock-card")).not.toBeNull();
    expect(host.querySelector('button[aria-label="展开对话"]')).toBeNull();
  });

  it("asks for an API key instead of showing the input", () => {
    const { onOpenSettings } = render({ conversation: null, hasApiKey: false });
    expect(host.querySelector("textarea")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".ai-dock-setup")!.click());
    expect(onOpenSettings).toHaveBeenCalled();
  });
  it("in the workbench layout stays expanded and points pending changes to the side column", () => {
    render({ layout: "workbench" });
    expect(host.querySelector(".ai-dock.is-workbench .ai-dock-card")).not.toBeNull();
    expect(host.textContent).toContain("待确认修改 · 2 项，见右侧");
    expect(host.querySelector(".ai-diff")).toBeNull();
    expect(host.querySelector('[aria-label="收起"]')).toBeNull();
  });

  it("opens the current conversation in the workbench from the dock header", () => {
    const onOpenWorkbench = vi.fn();
    render({ onOpenWorkbench });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="在工作台打开"]')?.click());
    expect(onOpenWorkbench).toHaveBeenCalled();
  });
  it("shrinks into bebe: the button starts the flight, and without animation support it ends at once", () => {
    const onMinimize = vi.fn();
    const onFlightEnd = vi.fn();
    render({ onMinimize, onFlightEnd });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="缩小成 bebe"]')?.click());
    expect(onMinimize).toHaveBeenCalled();
    render({ onMinimize, onFlightEnd, flightTarget: { x: 1400, y: 880 } });
    expect(onFlightEnd).toHaveBeenCalledTimes(1);
    render({ onMinimize, onFlightEnd, hidden: true });
    expect(host.querySelector(".ai-dock")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the bebe button when bebe is hidden from the tray, and expands on request", () => {
    render({ conversation: { ...conversation, messages: conversation.messages.slice(0, 2) } });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起"]')?.click());
    expect(host.querySelector(".ai-dock-card")).toBeNull();
    expect(host.querySelector('[aria-label="缩小成 bebe"]')).toBeNull();
    render({ conversation: { ...conversation, messages: conversation.messages.slice(0, 2) }, expandRequest: 1 });
    expect(host.querySelector(".ai-dock-card")).not.toBeNull();
  });
});
