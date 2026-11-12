import { describe, expect, it } from "vitest";
import type { Conversation } from "../ai/types";
import { petChatSnapshot } from "./bridge";

const state = { hasApiKey: true, busy: false, stopped: false, error: null };

describe("petChatSnapshot", () => {
  it("shows only the latest round: last user message, the reply after it, and its batch", () => {
    const conversation: Conversation = {
      id: "c",
      title: "整理早上",
      panel: "board",
      createdAt: "",
      updatedAt: "",
      messages: [
        { id: "u1", role: "user", content: "第一轮", scope: { board: "write" }, createdAt: "" },
        { id: "a1", role: "assistant", content: "旧回复", toolCalls: [], createdAt: "" },
        { id: "b1", role: "batch", createdAt: "", batch: { id: "old", status: "confirmed", changes: [] } },
        { id: "u2", role: "user", content: "把喝水挪到下午", scope: { board: "write" }, createdAt: "" },
        { id: "a2", role: "assistant", content: "我先看看。", toolCalls: [], createdAt: "" },
        { id: "a3", role: "assistant", content: "", toolCalls: [], createdAt: "" },
        { id: "b2", role: "batch", createdAt: "", batch: { id: "new", status: "pending", changes: [] } },
      ],
    };
    const snapshot = petChatSnapshot(conversation, state);
    expect(snapshot).toMatchObject({ title: "整理早上", lastUser: "把喝水挪到下午", reply: "我先看看。" });
    expect(snapshot.batch?.id).toBe("new");
  });

  it("is empty without a conversation and keeps the run state", () => {
    expect(petChatSnapshot(null, { ...state, busy: true })).toEqual({ ...state, busy: true, title: null, lastUser: null, reply: null, batch: null, actions: [], choices: null });
  });

  it("carries the round's instant actions and offered choices", () => {
    const action = { label: "暂停提醒到 22:00", undo: { kind: "snooze" as const, previous: null } };
    const conversation: Conversation = {
      id: "c",
      title: "安静一下",
      panel: "board",
      createdAt: "",
      updatedAt: "",
      messages: [
        { id: "u1", role: "user", content: "今晚别提醒我", scope: {}, createdAt: "" },
        { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "snooze", arguments: {} }, { id: "c2", name: "offer_choices", arguments: {} }], createdAt: "" },
        { id: "t1", role: "tool", toolCallId: "c1", name: "snooze", content: "{}", action, createdAt: "" },
        { id: "t2", role: "tool", toolCallId: "c2", name: "offer_choices", content: "{}", choices: ["只今晚", "以后每天"], createdAt: "" },
      ],
    };
    const snapshot = petChatSnapshot(conversation, state);
    expect(snapshot.actions).toEqual([{ id: "t1", label: "暂停提醒到 22:00", undone: false }]);
    expect(snapshot.choices).toEqual(["只今晚", "以后每天"]);
  });
});
