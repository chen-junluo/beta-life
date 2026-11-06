// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "../defaults";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
          onLifeStagesSaved={vi.fn()}
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

  it("edits one AI prompt at a time through the prompt tabs", () => {
    const promptNav = Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button")).find((button) => button.textContent?.includes("AI Prompt"))!;
    act(() => promptNav.click());
    expect(host.querySelectorAll(".prompt-field-card textarea")).toHaveLength(1);

    const memoryTab = Array.from(host.querySelectorAll<HTMLButtonElement>('.prompt-nav [role="tab"]')).find((tab) => tab.textContent === "记忆分析")!;
    act(() => memoryTab.click());
    const textarea = host.querySelector<HTMLTextAreaElement>(".prompt-field-card textarea")!;
    expect(textarea.value).toBe(DEFAULT_SETTINGS.ai.memoryAnalysisPrompt);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "自定义记忆分析");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const extractionTab = Array.from(host.querySelectorAll<HTMLButtonElement>('.prompt-nav [role="tab"]')).find((tab) => tab.textContent === "习惯提取")!;
    act(() => extractionTab.click());
    expect(host.querySelector<HTMLTextAreaElement>(".prompt-field-card textarea")!.value).toBe(DEFAULT_SETTINGS.ai.extractionPrompt);
    act(() => memoryTab.click());
    expect(host.querySelector<HTMLTextAreaElement>(".prompt-field-card textarea")!.value).toBe("自定义记忆分析");
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

describe("SettingsPanel destructive actions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onApiKeyCleared: ReturnType<typeof vi.fn>;
  let onLifeStagesSaved: ReturnType<typeof vi.fn>;

  function openSection(label: string) {
    const tab = Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
      .find((button) => button.textContent?.includes(label))!;
    act(() => tab.click());
  }

  function findButton(text: string) {
    return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(text))!;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Tauri's macOS WKWebView returns false from window.confirm without showing a dialog.
    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onApiKeyCleared = vi.fn();
    onLifeStagesSaved = vi.fn();
    act(() => {
      root.render(
        <SettingsPanel
          settings={structuredClone(DEFAULT_SETTINGS)}
          hasApiKey
          onClose={vi.fn()}
          onSave={vi.fn().mockResolvedValue(undefined)}
          onApiKeyCleared={onApiKeyCleared}
          onBoardImported={vi.fn()}
          onLifeStagesSaved={onLifeStagesSaved}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("clears the API key after a second in-app click", async () => {
    openSection("AI Provider");
    await act(async () => findButton("清除已保存的 API key").click());
    expect(invoke).not.toHaveBeenCalled();

    await act(async () => findButton("再次点击确认清除").click());
    expect(invoke).toHaveBeenCalledWith("delete_api_key");
    expect(onApiKeyCleared).toHaveBeenCalled();
  });

  it("opens the board import picker only after a second in-app click", () => {
    openSection("数据");
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    act(() => findButton("导入 Board JSON").click());
    expect(pickerClick).not.toHaveBeenCalled();
    expect(host.textContent).toContain("导入会替换当前时间板");

    act(() => findButton("再次点击选择文件").click());
    expect(pickerClick).toHaveBeenCalledTimes(1);
  });

  it("edits life stage ranges and saves them with the settings", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "load_life_stages" ? [{ name: "本科", start: "2019-09", end: "2023-08" }] : undefined,
    );
    await act(async () => openSection("记忆阶段"));
    const endInput = host.querySelector<HTMLInputElement>('[aria-label="本科结束月份"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    act(() => {
      setValue.call(endInput, "2019-08");
      endInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => findButton("保存设置").click());
    expect(invoke).not.toHaveBeenCalledWith("save_life_stages", expect.anything());
    expect(host.textContent).toContain("开始时间不能晚于结束时间");

    act(() => {
      setValue.call(endInput, "2024-06");
      endInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => findButton("保存设置").click());
    expect(invoke).toHaveBeenCalledWith("save_life_stages", { stages: [{ name: "本科", start: "2019-09", end: "2024-06" }] });
    expect(onLifeStagesSaved).toHaveBeenCalledTimes(1);
  });
});
