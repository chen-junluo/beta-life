// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ActivitySession, ActivityStatus } from "../activity";
import { TimelineView } from "./TimelineView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("TimelineView", () => {
  let host: HTMLDivElement;
  let root: Root;
  const mockedInvoke = vi.mocked(invoke);
  const today = new Date();
  const at = (hour: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).getTime();
  let status: ActivityStatus;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    status = { supported: true, accessibility: false, browsers: [{ name: "Microsoft Edge", access: "denied" }, { name: "Google Chrome", access: "granted" }] };
    const sessions: ActivitySession[] = [
      { start: at(0), end: at(0) + 60 * 60_000, app: "Code", title: "ai.rs" },
      { start: at(0) + 60 * 60_000, end: at(0) + 90 * 60_000, app: "Google Chrome", title: "GitHub", domain: "github.com" },
    ];
    mockedInvoke.mockImplementation((command) => Promise.resolve(({ load_activity_day: sessions, activity_status: status } as Record<string, unknown>)[command]) as never);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mockedInvoke.mockReset();
  });

  it("shows the day total, the band, ranked apps and the permission notices", async () => {
    await act(async () => root.render(<TimelineView />));
    expect(mockedInvoke).toHaveBeenCalledWith("load_activity_day", { date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(host.querySelector(".timeline-total strong")?.textContent).toBe("1h 30m");
    expect(host.querySelectorAll(".timeline-seg")).toHaveLength(2);
    expect([...host.querySelectorAll(".timeline-name")].map((name) => name.textContent)).toEqual(["Code", "Google Chrome"]);
    const notices = [...host.querySelectorAll(".timeline-notice")].map((notice) => notice.textContent);
    expect(notices[0]).toContain("辅助功能");
    expect(notices[1]).toContain("Microsoft Edge");
    expect(notices[1]).not.toContain("Google Chrome");

    await act(async () => host.querySelectorAll<HTMLButtonElement>(".timeline-row")[1].click());
    expect(host.querySelector(".timeline-children")?.textContent).toContain("github.com");

    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".timeline-notice button")][0].click());
    expect(mockedInvoke).toHaveBeenCalledWith("request_accessibility");
  });

  it("cannot go past today and offers a way back from earlier days", async () => {
    await act(async () => root.render(<TimelineView />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="后一天"]')?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="前一天"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="后一天"]')?.disabled).toBe(false);
    expect(host.textContent).toContain("回到今天");
  });
});
