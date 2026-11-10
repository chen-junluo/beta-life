import type { AiBatch, AiScope, ChatStepReply, ConversationMessage, ToolOutcome, AiToolCall, WireMessage } from "./types";

export interface TurnDeps {
  step: (request: { messages: WireMessage[]; scope: AiScope; context: string }) => Promise<ChatStepReply>;
  /** Index of every readable panel, taken once at the start of the turn. */
  context: string;
  runTool: (call: AiToolCall) => ToolOutcome | Promise<ToolOutcome>;
  /** Called after every change so the UI and storage follow the turn as it runs. */
  onMessages: (messages: ConversationMessage[]) => void;
  /** Aborting stops the loop; the step in flight is discarded, finished steps are kept. */
  signal?: AbortSignal;
}

function changeLabel(change: AiBatch["changes"][number]): string {
  const created = change.createdId ? ` -> new id ${change.createdId}` : "";
  return `${change.name}(${JSON.stringify(change.arguments)})${created}`;
}

/** What the model learns about a resolved batch on its next turn. */
export function batchNote(batch: AiBatch): string {
  const failed = new Map((batch.failed ?? []).map((entry) => [entry.changeId, entry.reason]));
  const list = (changes: AiBatch["changes"]) => changes.map((change) => `- ${changeLabel(change)}`).join("\n");
  if (batch.status === "confirmed") {
    const applied = batch.changes.filter((change) => change.selected && !failed.has(change.id));
    const unchecked = batch.changes.filter((change) => !change.selected);
    const broken = batch.changes.filter((change) => failed.has(change.id));
    return [
      "The user confirmed the staged batch.",
      applied.length > 0 && `Applied:\n${list(applied)}`,
      unchecked.length > 0 && `Unchecked by the user, not applied:\n${list(unchecked)}`,
      broken.length > 0 && `Failed, not applied:\n${broken.map((change) => `- ${changeLabel(change)}: ${failed.get(change.id)}`).join("\n")}`,
    ].filter(Boolean).join("\n");
  }
  const reason = batch.status === "superseded"
    ? "The user did not confirm the staged batch and sent a new message instead, so it was discarded. Nothing was applied"
    : "The user cancelled the staged batch. Nothing was applied";
  return `${reason}:\n${list(batch.changes)}`;
}

export function toWire(messages: ConversationMessage[]): WireMessage[] {
  return messages.flatMap((message): WireMessage[] => {
    switch (message.role) {
      case "user":
        return [{ role: "user", content: message.content }];
      case "assistant":
        return [{ role: "assistant", content: message.content, toolCalls: message.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) }];
      case "tool":
        return [{ role: "tool", content: message.content, toolCallId: message.toolCallId }];
      case "batch":
        return message.batch.status === "pending" ? [] : [{ role: "note", content: batchNote(message.batch) }];
    }
  });
}

export function pendingBatch(messages: ConversationMessage[]): AiBatch | null {
  for (const message of messages) {
    if (message.role === "batch" && message.batch.status === "pending") return message.batch;
  }
  return null;
}

const stamp = () => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString() });

/** Thrown by runTurn when the user pressed stop. */
export class TurnStopped extends Error {
  constructor() {
    super("stopped");
    this.name = "TurnStopped";
  }
}

/**
 * One user turn: call the model, run read tools, stage write tools, repeat until the model answers
 * without tools. There is no step limit (the user can stop the turn); a step that stages any write
 * ends the turn and the batch waits for the user.
 */
export async function runTurn(history: ConversationMessage[], text: string, scope: AiScope, deps: TurnDeps): Promise<ConversationMessage[]> {
  let messages: ConversationMessage[] = [
    ...history.map((message) =>
      message.role === "batch" && message.batch.status === "pending"
        ? { ...message, batch: { ...message.batch, status: "superseded" as const } }
        : message,
    ),
    { ...stamp(), role: "user", content: text, scope },
  ];
  deps.onMessages(messages);
  const changes: AiBatch["changes"] = [];
  const stopped = () => deps.signal?.aborted === true;

  while (!stopped()) {
    const reply = await deps.step({ messages: toWire(messages), scope, context: deps.context });
    if (stopped()) break;
    const results: ConversationMessage[] = [];
    // Sequential: a later write in the same step may build on an earlier staged one.
    for (const call of reply.toolCalls) {
      const outcome = call.error ? { content: JSON.stringify({ error: call.error }) } : await deps.runTool(call);
      if (outcome.change) changes.push(outcome.change);
      results.push({ ...stamp(), role: "tool", toolCallId: call.id, name: call.name, content: outcome.content });
    }
    messages = [...messages, { ...stamp(), role: "assistant", content: reply.content, toolCalls: reply.toolCalls }, ...results];
    if (reply.toolCalls.length === 0 || changes.length > 0) break;
    deps.onMessages(messages);
  }

  if (changes.length > 0) {
    messages = [...messages, { ...stamp(), role: "batch", batch: { id: crypto.randomUUID(), status: "pending", changes } }];
  }
  if (stopped() && changes.length === 0) throw new TurnStopped();
  deps.onMessages(messages);
  return messages;
}
