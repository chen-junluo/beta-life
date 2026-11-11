// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DiaryView } from "./DiaryView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The real editor is covered by its own tests; a textarea keeps this test about loading and saving.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, "aria-label": label }: { value: string; onChange: (value: string) => void; "aria-label"?: string }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const OCT = [{ id: "261031", date: "261031", title: "261031周六", body: "- 万圣节" }];
const NOV = [{ id: "261110", date: "261110", title: "261110周二", body: "- 读书" }];

describe("DiaryView", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onHistory = vi.fn();
  const mocked = vi.mocked(invoke);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 10, 11, 9));
    mocked.mockReset();
    onHistory.mockReset();
    mocked.mockImplementation(async (command: string, args?: unknown) => {
      const request = (args as { request?: { month: string; body: string; id: string | null } })?.request;
      switch (command) {
        case "list_diary_months": return ["2610", "2611"];
        case "load_diary_month": return { month: (args as { month: string }).month, days: (args as { month: string }).month === "2610" ? OCT : NOV };
        case "save_diary_day": return { status: "saved", id: request!.id ?? "261111", month: { month: "2611", days: [...NOV, { id: "261111", date: "261111", title: "261111周三", body: request!.body }] } };
        default: return null;
      }
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(800); });
  const type = (value: string) => act(() => {
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("opens today from the template and writes it on the first edit", async () => {
    act(() => root.render(<DiaryView template="- " revision={0} onHistory={onHistory} />));
    await flush();
    expect([...host.querySelectorAll(".diary-day-title")].map((node) => node.textContent)).toEqual(["261110周二", "写今天 · 261111周三"]);
    expect(host.querySelector(".diary-page-head h3")?.textContent).toBe("261111周三");
    expect(host.querySelector("textarea")!.value).toBe("- ");
    expect(mocked.mock.calls.some(([command]) => command === "save_diary_day")).toBe(false);

    type("- 写日记");
    await flush();
    expect(mocked).toHaveBeenCalledWith("save_diary_day", { request: { month: "2611", id: null, date: "261111", base: null, body: "- 写日记", force: false } });
    expect(onHistory).toHaveBeenCalledWith({ month: "2611", id: "261111", date: "261111", body: null }, { month: "2611", id: "261111", date: "261111", body: "- 写日记" }, "2611/261111");
    expect(host.querySelector(".diary-today-badge")?.textContent).toBe("今天");
  });

  it("saves free-form bodies and refuses only another day heading", async () => {
    act(() => root.render(<DiaryView template="- " revision={0} onHistory={onHistory} />));
    await flush();
    act(() => (host.querySelector(".diary-day") as HTMLButtonElement).click());
    await flush();
    type("一段话，没有列表也可以");
    await flush();
    expect(mocked).toHaveBeenCalledWith("save_diary_day", { request: expect.objectContaining({ id: "261110", base: "- 读书", body: "一段话，没有列表也可以" }) });
    mocked.mockClear();
    type("一段话\n\n## 261112周四");
    await flush();
    expect(host.querySelector(".diary-message")?.textContent).toContain("日期标题");
    expect(mocked.mock.calls.some(([command]) => command === "save_diary_day")).toBe(false);
  });

  it("asks before overwriting a day changed elsewhere", async () => {
    act(() => root.render(<DiaryView template="- " revision={0} onHistory={onHistory} />));
    await flush();
    act(() => (host.querySelector(".diary-day") as HTMLButtonElement).click());
    await flush();
    mocked.mockImplementationOnce(async () => ({ status: "conflict", current: "- 在 Obsidian 里改的" }));
    type("- 我的修改");
    await flush();
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("在别处被改过");
    await act(async () => (host.querySelector(".diary-conflict .secondary-button") as HTMLButtonElement).click());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector("textarea")!.value).toBe("- 在 Obsidian 里改的");
  });

  it("steps to an older month", async () => {
    act(() => root.render(<DiaryView template="- " revision={0} onHistory={onHistory} />));
    await flush();
    await act(async () => (host.querySelector('[aria-label="上个月"]') as HTMLButtonElement).click());
    await flush();
    expect(host.querySelector(".diary-month strong")?.textContent).toBe("2026 年 10 月");
    expect(host.querySelector("textarea")!.value).toBe("- 万圣节");
  });
});
