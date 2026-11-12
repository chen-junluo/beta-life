// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dayKey, type ActivityDay, type ActivityStatus, type DaySummary } from "../activity";
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
    const record: ActivityDay = {
      sessions: [
        { start: at(0), end: at(0) + 60 * 60_000, app: "Code", title: "ai.rs", category: "focus" },
        { start: at(0) + 60 * 60_000, end: at(0) + 90 * 60_000, app: "Google Chrome", title: "GitHub", domain: "news.ycombinator.com", category: null },
      ],
      apps: {
        Code: { kind: "app", key: "com.microsoft.VSCode", label: "Code", category: "focus" },
        "Google Chrome": { kind: "app", key: "com.google.Chrome", label: "Google Chrome", category: "neutral" },
      },
      domains: { "news.ycombinator.com": { kind: "domain", key: "ycombinator.com", label: "ycombinator.com", category: null } },
    };
    const summary: DaySummary = {
      date: dayKey(today),
      totals: { focus: 60 * 60_000, neutral: 0, slack: 0, none: 30 * 60_000 },
      longestFocus: { start: at(0), end: at(1) },
      topSlack: [],
      unclassified: [{ kind: "domain", key: "ycombinator.com", label: "ycombinator.com", todayMs: 30 * 60_000 }],
      periods: [{ id: "sleep", label: "睡眠", focus: 60 * 60_000, neutral: 0, slack: 0, none: 30 * 60_000 }],
      average: { days: 3, active: 120 * 60_000, focus: 90 * 60_000, slack: 10 * 60_000 },
      nudges: { count: 0, back: 0 },
    };
    mockedInvoke.mockImplementation((command) => Promise.resolve(({ load_activity_day: record, activity_status: status, load_daily_summary: summary } as Record<string, unknown>)[command]) as never);
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

    expect(host.querySelector(".timeline-cats")?.textContent).toContain("专注1h 00m");
    expect(host.querySelector(".timeline-cats")?.textContent).toContain("待分类30m");
    expect(host.querySelectorAll(".timeline-cat-band span")).toHaveLength(2);

    await act(async () => host.querySelectorAll<HTMLButtonElement>(".timeline-row")[1].click());
    expect(host.querySelector(".timeline-children")?.textContent).toContain("news.ycombinator.com");

    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".timeline-notice button")][0].click());
    expect(mockedInvoke).toHaveBeenCalledWith("request_accessibility");
  });

  it("classifies a site from its row and reloads the day", async () => {
    await act(async () => root.render(<TimelineView />));
    await act(async () => host.querySelectorAll<HTMLButtonElement>(".timeline-row")[1].click());
    const chip = host.querySelector<HTMLButtonElement>(".timeline-children .field-chip")!;
    expect(chip.getAttribute("aria-label")).toBe("ycombinator.com 的分类：待分类");
    await act(async () => chip.click());
    const slack = [...host.querySelectorAll<HTMLButtonElement>(".category-popover button")].find((button) => button.textContent === "摸鱼")!;
    mockedInvoke.mockClear();
    await act(async () => slack.click());
    expect(mockedInvoke).toHaveBeenCalledWith("set_activity_rule", { request: { kind: "domain", key: "ycombinator.com", name: "ycombinator.com", category: "slack" } });
    expect(mockedInvoke).toHaveBeenCalledWith("load_activity_day", expect.anything());
  });

  it("shows the day's digest and classifies its unclassified sites", async () => {
    await act(async () => root.render(<TimelineView />));
    const card = host.querySelector(".timeline-summary")!;
    expect(card.textContent).toContain("67%");
    expect(card.textContent).toContain("最长连续 1h 00m");
    expect(card.textContent).toContain("−30m");
    expect(card.textContent).toContain("今天没有摸鱼");
    const chip = card.querySelector<HTMLButtonElement>(".timeline-unclassified .field-chip")!;
    await act(async () => chip.click());
    const focus = [...card.querySelectorAll<HTMLButtonElement>(".category-popover button")].find((button) => button.textContent === "专注")!;
    await act(async () => focus.click());
    expect(mockedInvoke).toHaveBeenCalledWith("set_activity_rule", { request: { kind: "domain", key: "ycombinator.com", name: "ycombinator.com", category: "focus" } });
  });

  it("writes the day's digest to the diary from the header", async () => {
    const onWriteDiary = vi.fn();
    await act(async () => root.render(<TimelineView onWriteDiary={onWriteDiary} />));
    const button = [...host.querySelectorAll<HTMLButtonElement>(".timeline-head button")].find((item) => item.textContent?.includes("写进日记"))!;
    await act(async () => button.click());
    expect(onWriteDiary).toHaveBeenCalledWith(expect.objectContaining({ date: dayKey(today) }));
  });

  it("cannot go past today and offers a way back from earlier days", async () => {
    await act(async () => root.render(<TimelineView />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="后一天"]')?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="前一天"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="后一天"]')?.disabled).toBe(false);
    expect(host.textContent).toContain("回到今天");
  });
});
