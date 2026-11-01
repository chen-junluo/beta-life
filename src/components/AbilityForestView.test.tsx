// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ABILITY_FOREST } from "../defaults";
import type { AbilityForest } from "../types";
import { AbilityForestView } from "./AbilityForestView";

describe("AbilityForestView", () => {
  let host: HTMLDivElement;
  let topbarActions: HTMLDivElement;
  let root: Root;
  let onForestChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    topbarActions = document.createElement("div");
    document.body.append(topbarActions, host);
    root = createRoot(host);
    onForestChange = vi.fn();
    act(() => root.render(
      <AbilityForestView
        forest={structuredClone(DEFAULT_ABILITY_FOREST)}
        saveState="saved"
        onForestChange={onForestChange}
        topbarActions={topbarActions}
      />,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    topbarActions.remove();
  });

  it("keeps a single expanded editor and saves the selected node's text", () => {
    expect(host.querySelectorAll(".ability-markdown-input")).toHaveLength(1);
    const name = host.querySelector<HTMLInputElement>('[aria-label="节点名称"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "数据洞察");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onForestChange).toHaveBeenCalled();
    const updated = onForestChange.mock.calls.at(-1)![0] as AbilityForest;
    expect(updated.nodes.find((node) => node.id === "data-literacy")?.name).toBe("数据洞察");
  });

  it("updates parent links and persists new child nodes immediately", () => {
    const addChild = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("添加子节点"))!;
    act(() => addChild.click());
    const updated = onForestChange.mock.calls.at(-1)![0] as AbilityForest;
    expect(updated.nodes).toHaveLength(DEFAULT_ABILITY_FOREST.nodes.length + 1);
    expect(onForestChange.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it("deletes the selected branch with an in-app confirmation", () => {
    const deleteButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("删除节点"))!;
    act(() => deleteButton.click());
    expect(host.textContent).toContain("再次点击确认删除");
    const confirmButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("确认删除"))!;
    act(() => confirmButton.click());
    const updated = onForestChange.mock.calls.at(-1)![0] as AbilityForest;
    expect(updated.nodes.some((node) => node.id === "data-literacy")).toBe(false);
    expect(updated.mapState?.selectedId).toBe("technology");
  });

  it("shows the isometric map tools and prototype map controls", () => {
    expect(host.querySelector('canvas[aria-label*="等距地图"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="名称显示范围"]')).not.toBeNull();
    const parameters = Array.from(topbarActions.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("地图参数"))!;
    act(() => parameters.click());
    expect(host.querySelector('[aria-label="地图生成参数"]')).not.toBeNull();
    expect(host.querySelectorAll('.ability-map-range input[type="range"]')).toHaveLength(4);
  });
});
