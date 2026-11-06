// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Memory } from "../types";
import { MemoryFieldChips } from "./MemoryFields";

const memory: Memory = {
  id: "m",
  song: "晴天",
  date: "",
  stage: "",
  location: "",
  emotion: { type: "calm", intensity: 5 },
  content: "",
  createdAt: "",
  updatedAt: "",
};

describe("MemoryFieldChips", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    function Harness() {
      const [value, setValue] = useState(memory);
      return (
        <MemoryFieldChips
          memory={value}
          lifeStages={[{ name: "大学", start: "2016-09", end: "2020-06" }]}
          idPrefix="test"
          onField={(field, next) => setValue((current) => ({ ...current, [field]: next }))}
          onEmotion={(field, next) => setValue((current) => ({ ...current, emotion: { ...current.emotion, [field]: field === "intensity" ? Number(next) : next } }))}
        />
      );
    }
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const chip = (field: string) => host.querySelector<HTMLButtonElement>(`[aria-label^="${field}："]`)!;

  it("shows empty fields as add chips and fills them from popovers", () => {
    expect(chip("阶段").textContent).toBe("阶段");
    expect(chip("阶段").className).toContain("is-ghost");

    act(() => chip("阶段").click());
    const option = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((item) => item.textContent?.includes("大学"))!;
    act(() => option.click());
    expect(chip("阶段").textContent).toContain("大学");
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    act(() => chip("日期").click());
    const date = host.querySelector<HTMLInputElement>("#test-date")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(date, "2018Q3");
      date.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => date.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(chip("日期").textContent).toContain("2018Q3");
    expect(host.querySelector("#test-date")).toBeNull();
  });

  it("changes the emotion type without closing, so intensity can follow", () => {
    act(() => chip("情绪").click());
    const warm = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((item) => item.textContent?.includes("温暖"))!;
    act(() => warm.click());
    expect(chip("情绪").textContent).toContain("温暖 · 5");
    expect(host.querySelector("#test-emotion-intensity")).not.toBeNull();
  });
});
