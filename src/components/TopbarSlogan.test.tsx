// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopbarSlogan } from "./TopbarSlogan";

describe("TopbarSlogan", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onSave: ReturnType<typeof vi.fn>;

  function render(value: string) {
    act(() => root.render(<TopbarSlogan value={value} onSave={onSave} />));
  }

  function startEditing(): HTMLInputElement {
    act(() => host.querySelector<HTMLButtonElement>(".topbar-slogan")!.click());
    return host.querySelector<HTMLInputElement>(".topbar-slogan-input")!;
  }

  function type(input: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function press(input: HTMLInputElement, init: KeyboardEventInit) {
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onSave = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the full slogan as a tooltip and a placeholder when empty", () => {
    render("一天，不必精确到每一分钟。");
    expect(host.querySelector(".topbar-slogan")?.getAttribute("title")).toBe("一天，不必精确到每一分钟。");
    render("");
    expect(host.textContent).toContain("点击添加这个面板的 slogan");
  });

  it("saves with Enter", () => {
    render("旧的");
    const input = startEditing();
    type(input, "新的 slogan");
    press(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("新的 slogan");
    expect(host.querySelector(".topbar-slogan-input")).toBeNull();
  });

  it("cancels with Escape without saving", () => {
    render("旧的");
    const input = startEditing();
    type(input, "改了一半");
    press(input, { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(host.querySelector(".topbar-slogan")?.textContent).toBe("旧的");
  });

  it("ignores Enter while an input method is composing", () => {
    render("旧的");
    const input = startEditing();
    type(input, "jintian");
    press(input, { key: "Enter", isComposing: true });
    press(input, { key: "Enter", keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    expect(host.querySelector(".topbar-slogan-input")).not.toBeNull();
  });

  it("saves on blur", () => {
    render("旧的");
    const input = startEditing();
    type(input, "失焦保存");
    act(() => input.blur());
    expect(onSave).toHaveBeenCalledWith("失焦保存");
  });
});
