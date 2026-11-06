// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent, MarkdownEditor } from "./MarkdownEditor";

function pasteText(target: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
}

describe("MarkdownEditor", () => {
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

  const editor = () => host.querySelector<HTMLElement>('[role="textbox"]')!;

  it("renders stored Markdown and does not rewrite it on open", () => {
    const onChange = vi.fn();
    act(() => root.render(<MarkdownEditor value={"- 喝水\n- **拉伸**"} onChange={onChange} aria-label="备注" />));
    expect(editor().querySelectorAll("li")).toHaveLength(2);
    expect(editor().querySelector("strong")?.textContent).toBe("拉伸");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders pasted Markdown and reports it back as Markdown", () => {
    const onChange = vi.fn();
    act(() => root.render(<MarkdownEditor value="" onChange={onChange} placeholder="写点什么" />));
    expect(editor().dataset.empty).toBe("true");
    act(() => pasteText(editor(), "## 步骤\n\n1. 坐好\n2. **听**呼吸"));
    expect(editor().querySelector("h2")?.textContent).toBe("步骤");
    expect(editor().querySelectorAll("ol li")).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith("## 步骤\n\n1. 坐好\n2. **听**呼吸");
    expect(editor().dataset.empty).toBeUndefined();
  });

  it("bolds the selection with Ctrl+B", () => {
    const onChange = vi.fn();
    act(() => root.render(<MarkdownEditor value="听息" onChange={onChange} />));
    act(() => {
      editor().dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
      editor().dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("**听息**");
  });

  it("shows values set from outside, like an AI fill", () => {
    function Harness() {
      const [value, setValue] = useState("旧");
      return <><MarkdownEditor value={value} onChange={setValue} /><button onClick={() => setValue("*新*")}>fill</button></>;
    }
    act(() => root.render(<Harness />));
    act(() => host.querySelector("button")!.click());
    expect(editor().querySelector("em")?.textContent).toBe("新");
  });

  it("renders read-only Markdown without letting links navigate", () => {
    act(() => root.render(<MarkdownContent value="[链接](https://example.com) **粗**" />));
    const link = host.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(host.querySelector("strong")?.textContent).toBe("粗");
  });
});
