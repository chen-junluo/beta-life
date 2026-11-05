// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Habit } from "../types";
import { BoardView, pointerCollision } from "./BoardView";

describe("BoardView focus layout", () => {
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

  it("compresses every sleep lane into the available period width", () => {
    act(() => {
      root.render(
        <BoardView
          items={[]}
          settings={structuredClone(DEFAULT_SETTINGS)}
          viewMode="sleep"
          onItemsChange={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onSloganChange={vi.fn()}
          onTagIconChange={vi.fn()}
        />,
      );
    });

    const period = host.querySelector<HTMLElement>('.period-group[data-layout="focus"]');
    const hoursGrid = host.querySelector<HTMLElement>(".focused-hours-grid");

    expect(period).not.toBeNull();
    expect(period!.style.getPropertyValue("--focused-board-min-width")).toBe("");
    expect(hoursGrid?.style.gridTemplateColumns).toBe("repeat(9, minmax(0, 1fr))");
    expect(hoursGrid?.children).toHaveLength(9);
  });
});

describe("pointerCollision", () => {
  const rect = (top: number) => ({ top, bottom: top + 40, left: 0, right: 200, width: 200, height: 40 });
  let container: HTMLDivElement;

  function collide(x: number, y: number, activeId: string) {
    const droppableRects = new Map([["a", rect(0)], ["b", rect(50)], ["c", rect(100)]]);
    return pointerCollision({
      active: { id: activeId },
      pointerCoordinates: { x, y },
      droppableRects,
      droppableContainers: [],
      collisionRect: rect(0),
    } as unknown as Parameters<typeof pointerCollision>[0]);
  }

  beforeEach(() => {
    container = document.createElement("div");
    container.dataset.containerId = "hour:9";
    container.innerHTML = ["a", "b", "c"]
      .map((id) => `<article class="habit-card" data-droppable-id="${id}"></article>`)
      .join("");
    document.body.appendChild(container);
    // The DOM hit is a shifted card ("c"); the result must follow the untransformed rects instead.
    document.elementsFromPoint = () => [container.querySelector("[data-droppable-id='c']")!];
  });

  afterEach(() => container.remove());

  it("targets the card whose original rect holds the pointer, ignoring visual shifts", () => {
    expect(collide(100, 60, "a")).toEqual([{ id: "b" }]);
  });

  it("targets the last card when dragging below the stack in the same hour", () => {
    expect(collide(100, 180, "a")).toEqual([{ id: "c" }]);
  });

  it("targets the container when dragging below the stack from another hour", () => {
    expect(collide(100, 180, "x")).toEqual([{ id: "hour:9" }]);
  });

  it("targets the nearest card when the pointer sits in a gap", () => {
    expect(collide(100, 97, "a")).toEqual([{ id: "c" }]);
  });
});

describe("BoardView tag focus", () => {
  let host: HTMLDivElement;
  let root: Root;
  const habit = (id: string, hour: number, tags: string): Habit => ({
    id,
    title: id,
    description: "",
    tags,
    placement: { kind: "hour", hour },
    order: 0,
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
  });
  const items = [habit("tea", 8, "饮食"), habit("read", 9, "口才突破"), habit("calcium", 20, "饮食, 睡前")];

  function render(onTagIconChange = vi.fn()) {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), tagIcons: { 饮食: "🍵", 口才突破: "" } };
    act(() => {
      root.render(
        <BoardView
          items={items}
          settings={settings}
          viewMode="global"
          onItemsChange={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onSloganChange={vi.fn()}
          onTagIconChange={onTagIconChange}
        />,
      );
    });
  }
  const pill = (tag: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".tag-pill")].find((item) => item.textContent?.includes(tag))!;
  const card = (id: string) => host.querySelector<HTMLElement>(`.habit-card[data-droppable-id="${id}"]`)!;
  const focus = () => host.querySelector<HTMLElement>(".timeline-scroll")!.dataset.tagFocus;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("lists tags by usage with icons, falling back to # when a tag has no icon", () => {
    render();
    expect([...host.querySelectorAll(".tag-pill")].map((item) => item.textContent)).toEqual(["🍵饮食2", "#口才突破1", "#睡前1"]);
    expect(card("tea").querySelector(".habit-tag")?.textContent).toBe("🍵饮食");
  });

  it("pins tags from the legend, dims other cards and clears on Escape", () => {
    render();
    act(() => pill("饮食").click());
    expect(focus()).toBe("pinned");
    expect(card("tea").classList).toContain("is-tag-hit");
    expect(card("calcium").classList).toContain("is-tag-hit");
    expect(card("read").classList).toContain("is-tag-dimmed");
    expect(host.querySelector(".tag-bar-status")?.textContent).toContain("已聚焦 1 个 tag · 2 个习惯");

    act(() => pill("口才突破").click());
    expect(card("read").classList).toContain("is-tag-hit");

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(focus()).toBeUndefined();
    expect(card("read").className).not.toMatch(/is-tag-/);
  });

  it("previews a tag while hovering a card chip and pins it on click without opening the editor", () => {
    render();
    const chip = card("read").querySelector<HTMLButtonElement>(".habit-tag")!;
    act(() => { chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    expect(focus()).toBe("preview");
    expect(card("tea").classList).toContain("is-tag-dimmed");
    act(() => { chip.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    expect(focus()).toBeUndefined();

    act(() => chip.click());
    expect(pill("口才突破").getAttribute("aria-pressed")).toBe("true");
  });

  it("chooses an icon for a tag in edit mode", () => {
    const onTagIconChange = vi.fn();
    render(onTagIconChange);
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".tag-bar-action")].at(-1)!.click());
    act(() => pill("睡前").click());
    const options = host.querySelectorAll<HTMLButtonElement>('[role="option"]');
    act(() => options[0].click());
    expect(onTagIconChange).toHaveBeenCalledWith("睡前", options[0].textContent);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(focus()).toBeUndefined();
  });
});
