// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import { SettingsPanel } from "./SettingsPanel";

describe("SettingsPanel selects", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn();

    act(() => {
      root.render(
        <SettingsPanel
          settings={structuredClone(DEFAULT_SETTINGS)}
          hasApiKey={false}
          onClose={onClose}
          onSave={vi.fn().mockResolvedValue(undefined)}
          onApiKeyCleared={vi.fn()}
          onBoardImported={vi.fn()}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the styled hour menu and updates its selected option", () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="早上开始时间"]');
    expect(trigger).not.toBeNull();

    act(() => trigger!.click());
    const listbox = host.querySelector('[role="listbox"][aria-label="早上开始时间"]');
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(24);

    const eightOClock = Array.from(listbox!.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("08:00"));
    act(() => eightOClock!.click());

    expect(trigger!.textContent).toContain("08:00");
    expect(host.querySelector('[role="listbox"][aria-label="早上开始时间"]')).toBeNull();
  });

  it("keeps the settings dialog open when Escape only dismisses a select menu", () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="早上开始时间"]')!;
    act(() => trigger.click());
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the same styled menu for AI providers", () => {
    const providerTab = Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
      .find((button) => button.textContent?.includes("AI Provider"));
    act(() => providerTab!.click());

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="AI Provider"]')!;
    act(() => trigger.click());
    const customOption = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Custom / OpenAI-compatible"));
    act(() => customOption!.click());

    expect(trigger.textContent).toContain("Custom / OpenAI-compatible");
  });
});
