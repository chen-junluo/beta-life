import { describe, expect, it, vi } from "vitest";
import { batchNote, MAX_STEPS, pendingBatch, runTurn, toWire } from "./turn";
import type { AiChange, ChatStepReply, ConversationMessage, ToolOutcome, WireMessage } from "./types";

const change = (id: string, selected = true): AiChange => ({
  id,
  toolCallId: `call-${id}`,
  name: "delete_habit",
  arguments: { id },
  kind: "del",
  title: id,
  detail: "",
  selected,
});

function deps(replies: ChatStepReply[], runTool: (name: string) => ToolOutcome = () => ({ content: "{}" })) {
  const requests: WireMessage[][] = [];
  return {
    requests,
    deps: {
      step: vi.fn(async ({ messages }: { messages: WireMessage[] }) => {
        requests.push(messages);
        return replies.shift()!;
      }),
      context: "{}",
      runTool: (call: { name: string }) => runTool(call.name),
      onMessages: vi.fn(),
      panel: "board" as const,
    },
  };
}

describe("assistant turn", () => {
  it("feeds read results back until the model answers", async () => {
    const { deps: d, requests } = deps([
      { content: "", toolCalls: [{ id: "c1", name: "list_habits", arguments: {} }] },
      { content: "你有 3 个习惯。", toolCalls: [] },
    ], () => ({ content: '{"habits":[]}' }));
    const messages = await runTurn([], "我有哪些习惯？", { board: "read" }, d);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(requests[1].at(-1)).toEqual({ role: "tool", content: '{"habits":[]}', toolCallId: "c1" });
  });

  it("ends the turn right after a step that stages writes and records a pending batch", async () => {
    const { deps: d } = deps([
      { content: "", toolCalls: [{ id: "c1", name: "delete_habit", arguments: { id: "a" } }, { id: "c2", name: "add_habit", arguments: {}, error: "missing required field `title`" }] },
    ], () => ({ content: '{"status":"staged"}', change: change("a") }));
    const messages = await runTurn([], "删掉喝水", { board: "write" }, d);
    expect(d.step).toHaveBeenCalledTimes(1);
    const rejected = messages.find((message) => message.role === "tool" && message.toolCallId === "c2");
    expect(rejected).toMatchObject({ content: '{"error":"missing required field `title`"}' });
    expect(pendingBatch(messages)?.changes).toEqual([change("a")]);
  });

  it("supersedes a pending batch when the user sends a new message", async () => {
    const history: ConversationMessage[] = [
      { id: "b", role: "batch", createdAt: "", batch: { id: "batch", panel: "board", status: "pending", changes: [change("a")] } },
    ];
    const { deps: d, requests } = deps([{ content: "好的", toolCalls: [] }]);
    const messages = await runTurn(history, "算了", { board: "write" }, d);
    expect(pendingBatch(messages)).toBeNull();
    expect(requests[0][0]).toMatchObject({ role: "note", content: expect.stringContaining("discarded") });
  });

  it("stops with an error after the step limit", async () => {
    const replies = Array.from({ length: MAX_STEPS }, (_, index) => ({ content: "", toolCalls: [{ id: `c${index}`, name: "list_habits", arguments: {} }] }));
    const { deps: d } = deps(replies);
    await expect(runTurn([], "?", { board: "read" }, d)).rejects.toThrow(`${MAX_STEPS} 步`);
    expect(d.onMessages).toHaveBeenCalled();
  });

  it("tells the model what was applied, unchecked and failed", () => {
    const note = batchNote({
      id: "batch",
      panel: "board",
      status: "confirmed",
      changes: [change("a"), change("b", false), { ...change("c"), name: "add_habit", createdId: "new-1" }],
      failed: [{ changeId: "c", reason: "gone" }],
    });
    expect(note).toContain('Applied:\n- delete_habit({"id":"a"})');
    expect(note).toContain('Unchecked by the user, not applied:\n- delete_habit({"id":"b"})');
    expect(note).toContain('Failed, not applied:\n- add_habit({"id":"c"}) -> new id new-1: gone');
    expect(toWire([{ id: "x", role: "batch", createdAt: "", batch: { id: "p", panel: "board", status: "pending", changes: [] } }])).toEqual([]);
  });
});
