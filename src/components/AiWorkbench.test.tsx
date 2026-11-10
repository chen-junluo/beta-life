// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationSummary } from "../ai/types";
import { AiWorkbench, readLog } from "./AiWorkbench";

const now = new Date().toISOString();
const conversation: Conversation = {
  id: "conv",
  title: "整理早上",
  panel: "board",
  createdAt: now,
  updatedAt: now,
  messages: [
    { id: "u", role: "user", content: "整理早上", scope: { board: "write" }, createdAt: now },
    {
      id: "a",
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "list_habits", arguments: {} },
        { id: "c2", name: "list_habits", arguments: {} },
        { id: "c3", name: "read_node", arguments: { ids: ["x"] }, error: "bad id" },
        { id: "c4", name: "add_habit", arguments: {} },
      ],
      createdAt: now,
    },
    { id: "t1", role: "tool", toolCallId: "c1", name: "list_habits", content: "{}", createdAt: now },
    { id: "t2", role: "tool", toolCallId: "c2", name: "list_habits", content: "{}", createdAt: now },
    { id: "t4", role: "tool", toolCallId: "c4", name: "add_habit", content: '{"status":"staged"}', createdAt: now },
    {
      id: "b",
      role: "batch",
      createdAt: now,
      batch: { id: "batch", status: "pending", changes: [{ id: "x", toolCallId: "c4", name: "add_habit", arguments: {}, kind: "add", title: "晨跑", detail: "早上", selected: true }] },
    },
  ],
};
const summaries: ConversationSummary[] = [
  { id: "conv", title: "整理早上", panel: "board", createdAt: now, updatedAt: now },
  { id: "old", title: "合成控制法加入知识", panel: "recall", createdAt: "2026-01-02T08:00:00Z", updatedAt: "2026-01-02T08:00:00Z" },
];

describe("AiWorkbench", () => {
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

  function render() {
    const handlers = { onScopeChange: vi.fn(), onOpen: vi.fn(), onDelete: vi.fn(), onNew: vi.fn(), onResolveBatch: vi.fn() };
    act(() => root.render(
      <AiWorkbench summaries={summaries} conversation={conversation} busy={false} scope={{ board: "write" }} {...handlers}><div /></AiWorkbench>,
    ));
    return handlers;
  }

  const items = () => Array.from(host.querySelectorAll(".ai-wb-item-title")).map((item) => item.textContent);

  it("logs each successful read once and skips writes and failed calls", () => {
    expect(readLog(conversation.messages)).toEqual([{ panel: "board", label: "读取了时间板的全部习惯" }]);
  });

  it("groups by date, searches titles and filters by source panel", () => {
    const { onOpen } = render();
    expect(Array.from(host.querySelectorAll(".ai-wb-group h5")).map((heading) => heading.textContent)).toEqual(["今天", "更早"]);

    const search = host.querySelector<HTMLInputElement>(".ai-wb-search input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "合成");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(items()).toEqual(["合成控制法加入知识"]);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const recallFilter = Array.from(host.querySelectorAll<HTMLButtonElement>(".ai-wb-filters button")).find((button) => button.textContent === "回想");
    act(() => recallFilter?.click());
    expect(items()).toEqual(["合成控制法加入知识"]);

    act(() => host.querySelector<HTMLButtonElement>(".ai-wb-item-main")?.click());
    expect(onOpen).toHaveBeenCalledWith("old");
  });

  it("deletes only on the second click", () => {
    const { onDelete } = render();
    const remove = () => host.querySelectorAll<HTMLButtonElement>(".ai-wb-delete")[1];
    act(() => remove().click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(remove().textContent).toContain("确认删除");
    act(() => remove().click());
    expect(onDelete).toHaveBeenCalledWith("old");
  });

  it("shows the pending batch in the side column and edits scope there", () => {
    const { onResolveBatch, onScopeChange } = render();
    const side = host.querySelector(".ai-wb-side")!;
    expect(side.textContent).toContain("晨跑");
    act(() => Array.from(side.querySelectorAll<HTMLButtonElement>(".primary-button")).find((button) => button.textContent?.includes("确认"))?.click());
    expect(onResolveBatch).toHaveBeenCalledWith("batch", ["x"]);

    const recallRead = side.querySelector<HTMLButtonElement>('[aria-label="回想的权限"] [role="radio"]:nth-child(2)');
    act(() => recallRead?.click());
    expect(onScopeChange).toHaveBeenCalledWith({ board: "write", recall: "read" });
  });
});
