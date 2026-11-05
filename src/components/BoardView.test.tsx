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
    expect([...host.querySelectorAll(".tag-pill")].map((item) => item.textContent)).toEqual(["🍵饮食0/2", "#口才突破0/1", "#睡前0/1"]);
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
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".tag-bar-action")].find((button) => button.textContent === "编辑 icon")!.click());
    act(() => pill("睡前").click());
    const options = host.querySelectorAll<HTMLButtonElement>('[role="option"]');
    act(() => options[0].click());
    expect(onTagIconChange).toHaveBeenCalledWith("睡前", options[0].textContent);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(focus()).toBeUndefined();
  });
});

describe("BoardView daily to-do", () => {
  let host: HTMLDivElement;
  let root: Root;
  const habit = (id: string, hour: number, done = false, tags = ""): Habit => ({
    id,
    title: id,
    description: "",
    tags,
    placement: { kind: "hour", hour },
    order: 0,
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    done,
  });

  function render(items: Habit[], handlers = { onItemsChange: vi.fn(), onEdit: vi.fn() }) {
    act(() => {
      root.render(
        <BoardView
          items={items}
          settings={structuredClone(DEFAULT_SETTINGS)}
          viewMode="global"
          onItemsChange={handlers.onItemsChange}
          onCreate={vi.fn()}
          onEdit={handlers.onEdit}
          onSloganChange={vi.fn()}
          onTagIconChange={vi.fn()}
        />,
      );
    });
    return handlers;
  }
  const card = (id: string) => host.querySelector<HTMLElement>(`.habit-card[data-droppable-id="${id}"]`)!;
  const toggle = (id: string) => card(id).querySelector<HTMLButtonElement>(".habit-done-toggle")!;
  const heading = (period: string) => host.querySelector<HTMLElement>(`.period-group[data-period-id="${period}"] .period-heading`)!;
  const resetButton = () => host.querySelector<HTMLButtonElement>(".tag-bar-reset")!;

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

  it("toggles a habit done without opening the editor", () => {
    const items = [habit("tea", 8), habit("read", 9, true)];
    const { onItemsChange, onEdit } = render(items);

    expect(card("read").classList).toContain("is-done");
    expect(toggle("read").getAttribute("aria-pressed")).toBe("true");
    expect(card("tea").classList).not.toContain("is-done");

    act(() => toggle("tea").click());
    expect(onEdit).not.toHaveBeenCalled();
    expect(onItemsChange).toHaveBeenCalledWith([{ ...items[0], done: true }, items[1]]);
  });

  it("shows per-period progress and marks a fully done period", () => {
    render([habit("tea", 8, true), habit("read", 9), habit("nap", 13, true)]);

    const morning = heading("morning");
    expect(morning.querySelector(".period-done-count")?.textContent).toBe("1/2");
    expect(morning.style.getPropertyValue("--done-ratio")).toBe("0.5");
    expect(heading("evening").style.getPropertyValue("--done-ratio")).toBe("0");
    expect(heading("noon").querySelector(".period-done-count")?.classList).toContain("is-all");
    expect(heading("evening").querySelector(".period-done-count")).toBeNull();
    expect(host.querySelector(".tag-bar-today")?.textContent).toContain("今日完成 2/3");
  });

  it("resets every done habit only after a confirming second click", () => {
    const items = [habit("tea", 8, true), habit("read", 9), habit("nap", 13, true)];
    const { onItemsChange } = render(items);

    act(() => resetButton().click());
    expect(onItemsChange).not.toHaveBeenCalled();
    expect(resetButton().textContent).toBe("再点一次确认");

    act(() => resetButton().click());
    expect(onItemsChange).toHaveBeenCalledWith(items.map((item) => ({ ...item, done: false })));
    expect(resetButton().textContent).toBe("重置今日");
  });

  it("fills each tag pill with the share of its habits done", () => {
    render([habit("tea", 8, true, "饮食"), habit("rice", 12, false, "饮食, 睡前"), habit("bath", 22, true, "睡前, 调理")]);
    const pill = (tag: string) =>
      [...host.querySelectorAll<HTMLElement>(".tag-pill")].find((item) => item.textContent?.includes(tag))!;

    expect(pill("饮食").style.getPropertyValue("--done-ratio")).toBe("0.5");
    expect(pill("饮食").querySelector("small")?.textContent).toBe("1/2");
    expect(pill("饮食").classList).not.toContain("is-all-done");
    expect(pill("调理").classList).toContain("is-all-done");
    expect(pill("调理").querySelector("small svg")).not.toBeNull();
  });

  it("keeps the reset bar for untagged habits and disables reset when nothing is done", () => {
    render([habit("tea", 8)]);
    expect(host.querySelector(".tag-pill")).toBeNull();
    expect(resetButton().disabled).toBe(true);
  });
});
