// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { DEFAULT_ABILITY_FOREST, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS } from "./defaults";
import type { AbilityForest, AppSettings } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("App topbar slogans", () => {
  let host: HTMLDivElement;
  let root: Root;
  const mockedInvoke = vi.mocked(invoke);

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { slogans: _slogans, ...legacySettings } = structuredClone(DEFAULT_SETTINGS);
    mockedInvoke.mockImplementation((command) => {
      if (command === "load_app_state") {
        return Promise.resolve({
          board: structuredClone(DEFAULT_BOARD),
          settings: legacySettings,
          abilityForest: structuredClone(DEFAULT_ABILITY_FOREST),
          researchAgenda: structuredClone(DEFAULT_RESEARCH_AGENDA),
          hasApiKey: false,
        }) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mockedInvoke.mockReset();
  });

  const topbarSlogan = () => host.querySelector(".topbar .topbar-slogan-text")?.textContent;

  it("fills in default slogans when stored settings have none", () => {
    expect(host.querySelector(".topbar-tab")?.textContent).toBe("时间板");
    expect(topbarSlogan()).toBe("一天，不必精确到每一分钟。");
  });

  it("updates the topbar after saving a slogan in Settings", async () => {
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click());
    const sloganTab = Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
      .find((button) => button.textContent?.includes("Slogan"))!;
    act(() => sloganTab.click());

    const input = host.querySelector<HTMLInputElement>('[aria-label="时间板 slogan"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "慢慢来，比较快。");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-footer button"))
      .find((button) => button.textContent?.includes("保存设置"))!;
    await act(async () => saveButton.click());

    expect(topbarSlogan()).toBe("慢慢来，比较快。");
    const saved = mockedInvoke.mock.calls.filter(([command]) => command === "save_settings").at(-1)?.[1] as { settings: AppSettings };
    expect(saved.settings.slogans.board).toBe("慢慢来，比较快。");
    expect(saved.settings.slogans.recall).toBe(DEFAULT_SETTINGS.slogans.recall);
  });

  it("switches the ability tab between two maps and saves each map separately", async () => {
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="打开面板导航"]')!.click());
    const forestEntry = Array.from(host.querySelectorAll<HTMLButtonElement>(".workspace-drawer-list button"))
      .find((button) => button.textContent?.includes("能力森林"))!;
    act(() => forestEntry.click());

    const tab = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".ability-map-tab"))
      .find((button) => button.textContent === name)!;
    expect(tab("Long-term Vision").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".ability-tree")?.textContent).toContain("技术与产品");

    act(() => tab("Research Agenda").click());
    expect(host.querySelector(".ability-tree")?.textContent).toContain("研究方向");
    expect(host.querySelector(".ability-tree")?.textContent).not.toContain("技术与产品");

    act(() => tab("Research Agenda").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('[aria-label="地图名称"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "短期研究议程");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(tab("短期研究议程")).toBeDefined();
    const saved = mockedInvoke.mock.calls.filter(([command]) => command === "save_ability_forest").at(-1)?.[1] as { map: string; abilityForest: AbilityForest };
    expect(saved.map).toBe("research");
    expect(saved.abilityForest.name).toBe("短期研究议程");
    expect(saved.abilityForest.nodes[0].id).toBe("research-direction");
  });
});
