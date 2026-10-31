// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../types";
import { MemoryEditor } from "./MemoryEditor";

const memory: Memory = {
  id: "memory-1",
  song: "随身听",
  date: "2024Q3",
  stage: "PhD",
  location: "香港",
  emotion: { type: "excited", intensity: 6 },
  content: "那个时候也是刚从澳洲回来。",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

describe("MemoryEditor", () => {
  it("deletes after a second in-app click without relying on window.confirm", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Tauri's macOS WKWebView returns false from window.confirm without showing a dialog.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<MemoryEditor memory={memory} lifeStages={[]} onSave={vi.fn()} onDelete={onDelete} onReload={vi.fn()} onClose={vi.fn()} />);
    });
    const deleteButton = container.querySelector<HTMLButtonElement>(".danger-button")!;

    await act(async () => deleteButton.click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(deleteButton.textContent).toContain("再次点击确认删除");

    await act(async () => deleteButton.click());
    expect(onDelete).toHaveBeenCalledWith("memory-1");
    expect(confirmSpy).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
    confirmSpy.mockRestore();
  });
});
