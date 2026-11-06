// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Habit } from "../types";
import { HabitEditor } from "./HabitEditor";

describe("HabitEditor", () => {
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

  function renderEditor(habit: Habit | null, onSave = vi.fn()) {
    act(() => {
      root.render(
        <HabitEditor
          habit={habit}
          initialContainer="hour:9"
          settings={structuredClone(DEFAULT_SETTINGS)}
          knownTags={["调理温湿", "饮食", "口才突破"]}
          onClose={vi.fn()}
          onSave={onSave}
          onDelete={vi.fn()}
        />,
      );
    });
    return onSave;
  }

  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;

  function typeInto(input: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const habit: Habit = {
    id: "tea",
    title: "喝茶",
    description: "",
    tags: "饮食",
    placement: { kind: "hour", hour: 9 },
    order: 0,
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
  };

  it("picks, creates and removes tags from the tag popover", () => {
    const onSave = renderEditor(habit);
    expect(host.querySelector('[aria-label="Tag：饮食，点击编辑"]')).not.toBeNull();

    act(() => button("Tag").click());
    const search = host.querySelector<HTMLInputElement>('input[aria-label="搜索或新建 tag"]')!;
    typeInto(search, "调");
    const options = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options().map((option) => option.textContent?.trim())).toEqual(["# 调理温湿"]);
    act(() => options()[0].click());

    typeInto(search, "养生");
    act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    typeInto(search, "");
    act(() => options().find((option) => option.textContent?.includes("饮食"))!.click());

    act(() => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tags: "调理温湿, 养生" }));
  });

  it("sets a whole period or a specific hour from the time chip", () => {
    const onSave = renderEditor(habit);
    const chip = () => host.querySelector<HTMLButtonElement>('[aria-label^="时间："]')!;
    expect(chip().textContent).toContain("09:00 · 早上");

    act(() => chip().click());
    act(() => button("晚上").click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".habit-whole-period")][0].click());
    expect(chip().textContent).toContain("整个晚上");
    act(() => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ placement: { kind: "period", period: "evening" } }));

    act(() => chip().click());
    act(() => button("中午").click());
    act(() => button("14:00").click());
    expect(host.querySelector(".habit-time-popover")).toBeNull();
    act(() => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ placement: { kind: "hour", hour: 14 } }));
  });

  it("widens the sheet when renamed periods need more room", () => {
    const width = () => parseInt(host.querySelector<HTMLElement>(".habit-editor")!.style.getPropertyValue("--habit-sheet-width"), 10);
    renderEditor(habit);
    expect(width()).toBeLessThan(560);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.periods = settings.periods.map((period) => ({ ...period, label: `${period.label}深度工作与学习时间段` }));
    act(() => {
      root.render(<HabitEditor habit={habit} initialContainer={null} settings={settings} knownTags={[]} onClose={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} />);
    });
    expect(width()).toBeGreaterThan(560);
  });

  it("closes an open popover on Escape without closing the editor", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <HabitEditor habit={habit} initialContainer={null} settings={structuredClone(DEFAULT_SETTINGS)} knownTags={[]} onClose={onClose} onSave={vi.fn()} onDelete={vi.fn()} />,
      );
    });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label^="时间："]')!.click());
    act(() => host.querySelector(".habit-time-popover button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".habit-time-popover")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the daily done check when an existing habit is edited", () => {
    const habit: Habit = {
      id: "tea",
      title: "喝茶",
      description: "",
      tags: "",
      placement: { kind: "hour", hour: 9 },
      order: 0,
      createdAt: "2026-11-05T00:00:00Z",
      updatedAt: "2026-11-05T00:00:00Z",
      done: true,
    };
    const onSave = vi.fn();
    act(() => {
      root.render(
        <HabitEditor
          habit={habit}
          initialContainer={null}
          settings={structuredClone(DEFAULT_SETTINGS)}
          knownTags={[]}
          onClose={vi.fn()}
          onSave={onSave}
          onDelete={vi.fn()}
        />,
      );
    });

    act(() => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "tea", done: true }));
  });
});
