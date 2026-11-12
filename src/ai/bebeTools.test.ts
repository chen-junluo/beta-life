// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOARD, DEFAULT_SETTINGS } from "../defaults";
import { EMPTY_PLAN, type PetPlan } from "../pet/plan";
import type { LoadedAppState } from "../types";
import { applyPetSettings, describePetSettings } from "./bebeTools";
import { commitChanges, createToolSession, type AssistantData } from "./session";
import { runTurn, toWire } from "./turn";
import type { AiChange, ConversationMessage } from "./types";

const store = vi.hoisted(() => ({
  plan: null as unknown as PetPlan,
  profile: { style: ["少用感叹号"], about: [] as string[] },
  rules: { apps: [{ key: "com.valvesoftware.steam", name: "Steam", category: "slack" }], domains: [], keywords: [] } as Record<string, unknown[]>,
  calls: [] as Array<[string, unknown]>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    store.calls.push([command, args]);
    switch (command) {
      case "load_pet_plan": return store.plan;
      case "save_pet_plan": store.plan = args.plan as PetPlan; return null;
      case "load_pet_profile": return store.profile;
      case "save_pet_profile": store.profile = args.profile as typeof store.profile; return store.profile;
      case "load_activity_rules": return store.rules;
      case "save_activity_rules": store.rules = args.rules as typeof store.rules; return store.rules;
      case "load_activity_day": return { sessions: [], apps: { Notion: { kind: "app", key: "notion.id", label: "Notion", category: null } }, domains: {} };
      default: return null;
    }
  }),
}));

const data = (): AssistantData => ({ board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, forests: {} as AssistantData["forests"], knowledge: [], memories: [], lifeStages: [], diary: null, timeline: null });

beforeEach(() => {
  store.plan = EMPTY_PLAN;
  store.profile = { style: ["少用感叹号"], about: [] };
  store.calls = [];
});

describe("bebe tools", () => {
  it("applies plan tools at once and records how to undo them", async () => {
    const session = createToolSession(data());
    const outcome = await session.run({ id: "1", name: "schedule_reminder", arguments: { text: "喝水", minutes: 10 } });
    expect(outcome.change).toBeUndefined();
    expect(outcome.action?.label).toMatch(/提醒：喝水$/);
    expect(store.plan.reminders).toHaveLength(1);
    expect(outcome.action?.undo).toEqual({ kind: "unschedule", id: store.plan.reminders[0].id });
    const bad = await session.run({ id: "2", name: "snooze", arguments: {} });
    expect(JSON.parse(bad.content).error).toContain("either");
  });

  it("stages settings, preferences and classifications without saving", async () => {
    const session = createToolSession(data());
    const settings = await session.run({ id: "1", name: "set_bebe_settings", arguments: { slackCooldownMinutes: 45, quietHours: [{ days: ["wed"], start: "14:00", end: "16:00" }] } });
    expect(settings.change).toMatchObject({ panel: "bebe", kind: "edit", detail: "两次摸鱼提醒至少隔 30 分钟 → 45 分钟；安静时段 无 → 周三 14:00–16:00" });
    const again = await session.run({ id: "2", name: "set_bebe_settings", arguments: { slackCooldownMinutes: 45 } });
    expect(JSON.parse(again.content).error).toContain("Nothing changes");
    const remember = await session.run({ id: "3", name: "remember_preference", arguments: { section: "about", text: "周三下午要上课" } });
    expect(remember.change).toMatchObject({ kind: "add", title: "周三下午要上课", detail: "记住 · 我说过的" });
    const forget = await session.run({ id: "4", name: "forget_preference", arguments: { section: "style", text: "不存在" } });
    expect(JSON.parse(forget.content).error).toContain("No remembered item");
    const app = await session.run({ id: "5", name: "classify_activity", arguments: { kind: "app", name: "notion", category: "focus" } });
    expect(app.change?.arguments).toMatchObject({ targetKind: "app", key: "notion.id", label: "Notion" });
    const unknown = await session.run({ id: "6", name: "classify_activity", arguments: { kind: "app", name: "Figma", category: "focus" } });
    expect(JSON.parse(unknown.content).error).toContain("No app named");
    expect(store.calls.some(([command]) => command.startsWith("save_"))).toBe(false);
  });

  it("commits confirmed changes on the current data", async () => {
    const session = createToolSession(data());
    const changes = [
      (await session.run({ id: "1", name: "set_bebe_settings", arguments: { summaryLeadMinutes: 60 } })).change!,
      (await session.run({ id: "2", name: "remember_preference", arguments: { section: "style", text: "叫我小陈" } })).change!,
      (await session.run({ id: "3", name: "forget_preference", arguments: { section: "style", text: "少用感叹号" } })).change!,
      (await session.run({ id: "4", name: "classify_activity", arguments: { kind: "keyword", name: "课程", category: "focus" } })).change!,
      (await session.run({ id: "5", name: "classify_activity", arguments: { kind: "app", name: "Steam", category: "none" } })).change!,
    ] as AiChange[];
    const state = { board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, hasApiKey: true } as LoadedAppState;
    const targets = { getState: () => state, commitBoard: vi.fn(), commitForest: vi.fn(), recordRecall: vi.fn(), recordMemories: vi.fn(), recordDiary: vi.fn(), commitPetSettings: vi.fn() };
    expect(await commitChanges(changes, targets)).toEqual([]);
    expect(targets.commitPetSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS.pet, summaryLeadMinutes: 60 });
    expect(store.profile).toEqual({ style: ["叫我小陈"], about: [] });
    expect(store.rules.keywords).toEqual([{ keyword: "课程", category: "focus" }]);
    expect(store.calls).toContainEqual(["set_activity_rule", { request: { kind: "app", key: "com.valvesoftware.steam", name: "Steam", category: null } }]);
  });

  it("sorts quiet-hour days and rejects bad clock times", () => {
    const next = applyPetSettings(DEFAULT_SETTINGS.pet, { quietHours: [{ days: ["fri", "mon"], start: "23:00", end: "01:00" }] });
    expect(next.quietHours[0].days).toEqual(["mon", "fri"]);
    expect(describePetSettings(DEFAULT_SETTINGS.pet, next).detail).toBe("安静时段 无 → 周一、周五 23:00–01:00");
    expect(() => applyPetSettings(DEFAULT_SETTINGS.pet, { quietHours: [{ days: ["mon"], start: "9:00", end: "10:00" }] })).toThrow("HH:MM");
  });

  it("ends the turn on offered choices and tells the model about an undo", async () => {
    const session = createToolSession(data());
    const step = vi.fn()
      .mockResolvedValueOnce({ content: "只今晚，还是以后每天？", toolCalls: [{ id: "c1", name: "offer_choices", arguments: { options: ["只今晚", "以后每天"] } }] });
    const messages = await runTurn([], "晚上别提醒我了", {}, { step, context: "{}", runTool: session.run, onMessages: vi.fn() });
    expect(step).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)).toMatchObject({ role: "tool", choices: ["只今晚", "以后每天"] });

    const action = { label: "暂停提醒到 22:00", undo: { kind: "snooze" as const, previous: null }, undone: true };
    const history: ConversationMessage[] = [
      { id: "a", role: "assistant", content: "", toolCalls: [{ id: "c2", name: "snooze", arguments: { until: "22:00" } }], createdAt: "" },
      { id: "t", role: "tool", toolCallId: "c2", name: "snooze", content: JSON.stringify({ status: "done" }), action, createdAt: "" },
    ];
    expect(JSON.parse(toWire(history)[1].content)).toEqual({ status: "done", undoneByUser: true });
  });
});
