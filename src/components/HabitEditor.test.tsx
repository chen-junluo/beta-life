// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Habit } from "../types";
import { HabitEditor } from "./HabitEditor";

describe("HabitEditor tag suggestions", () => {
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

  it("suggests known tags while typing and fills the chosen one", () => {
    act(() => {
      root.render(
        <HabitEditor
          habit={null}
          initialContainer="hour:9"
          settings={structuredClone(DEFAULT_SETTINGS)}
          knownTags={["调理温湿", "饮食", "口才突破"]}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "饮食，调");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["# 调理温湿"]);

    act(() => options[0].click());
    expect(input.value).toBe("饮食，调理温湿, ");
    expect([...host.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["# 口才突破"]);
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
