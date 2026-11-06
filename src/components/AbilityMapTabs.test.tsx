// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbilityMapTabs } from "./AbilityMapTabs";

describe("AbilityMapTabs", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  let onRename: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onSelect = vi.fn();
    onRename = vi.fn();
    act(() => root.render(
      <AbilityMapTabs
        maps={[{ kind: "vision", name: "Long-term Vision" }, { kind: "research", name: "Research Agenda" }]}
        active="vision"
        onSelect={onSelect}
        onRename={onRename}
      />,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const tab = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent === name)!;
  const startRename = (name: string) => {
    act(() => tab(name).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    return host.querySelector<HTMLInputElement>('[aria-label="地图名称"]')!;
  };
  const type = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = (input: HTMLInputElement, key: string) => act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

  it("switches maps on click and marks the active tab", () => {
    expect(tab("Long-term Vision").getAttribute("aria-selected")).toBe("true");
    act(() => tab("Research Agenda").click());
    expect(onSelect).toHaveBeenCalledWith("research");
  });

  it("renames a tab on double-click and Enter, trimming the name", () => {
    const input = startRename("Research Agenda");
    expect(input.value).toBe("Research Agenda");
    type(input, "  短期研究议程  ");
    press(input, "Enter");
    expect(onRename).toHaveBeenCalledWith("research", "短期研究议程");
    expect(host.querySelector('[aria-label="地图名称"]')).toBeNull();
  });

  it("keeps the old name on Escape or an empty name", () => {
    let input = startRename("Long-term Vision");
    type(input, "Vision 2030");
    press(input, "Escape");
    expect(host.querySelector('[aria-label="地图名称"]')).toBeNull();

    input = startRename("Long-term Vision");
    type(input, "   ");
    press(input, "Enter");
    expect(onRename).not.toHaveBeenCalled();
  });
});
