// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelHistory } from "./history";

type History = ReturnType<typeof usePanelHistory>;

describe("usePanelHistory", () => {
  let host: HTMLDivElement;
  let root: Root;
  let history: History;

  function Harness() {
    history = usePanelHistory();
    return <span>{history.notice?.text ?? ""}</span>;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("keeps one stack per panel and shows a notice", async () => {
    let board = "b0";
    let forest = "f0";
    act(() => {
      history.record("board", { before: "b0", after: "b1", restore: (value) => { board = value; } });
      history.record("forest", { before: "f0", after: "f1", restore: (value) => { forest = value; } });
    });
    await act(() => history.undo("board"));
    expect(board).toBe("b0");
    expect(forest).toBe("f0");
    expect(history.canUndo("forest")).toBe(true);
    expect(history.canRedo("board")).toBe(true);
    expect(host.textContent).toBe("已撤销");
    await act(() => history.redo("board"));
    expect(board).toBe("b1");
    expect(host.textContent).toBe("已重做");
  });

  it("merges same-key changes made in quick succession and clears redo on a new change", async () => {
    let value = "";
    const restore = (next: string) => { value = next; };
    act(() => {
      history.record("forest", { before: "", after: "a", key: "n1:name", restore });
      history.record("forest", { before: "a", after: "ab", key: "n1:name", restore });
    });
    await act(() => history.undo("forest"));
    expect(value).toBe("");
    expect(history.canUndo("forest")).toBe(false);
    act(() => history.record("forest", { before: "", after: "x", restore }));
    expect(history.canRedo("forest")).toBe(false);
  });

  it("keeps the step when restoring fails", async () => {
    act(() => history.record("recall", { before: 1, after: 2, restore: () => Promise.reject(new Error("磁盘已满")) }));
    await act(() => history.undo("recall"));
    expect(history.canUndo("recall")).toBe(true);
    expect(host.textContent).toBe("撤销失败：磁盘已满");
  });
});
