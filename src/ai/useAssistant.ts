import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadedAppState } from "../types";
import { assistantContext, commitChanges, createToolSession, loadAssistantData, type CommitTargets } from "./session";
import { runTurn, TurnStopped } from "./turn";
import type { AiBatch, AiPanelId, AiScope, ChatStepReply, Conversation, ConversationMessage, ConversationSummary } from "./types";

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "AI 请求失败，请检查 Provider 设置后重试。";
}

/** Pills stay with the conversation: restore the scope of its latest message. */
function scopeOf(messages: ConversationMessage[]): AiScope | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return message.scope;
  }
  return null;
}

interface AssistantOptions extends Omit<CommitTargets, "getState"> {
  getState: () => LoadedAppState | null;
  /** Panel a new conversation starts from; its pill is prefilled as writable. */
  activePanel: AiPanelId;
}

/** Runs the assistant inside the main window, which owns the data, and keeps the conversation on disk. */
export function useAssistant({ activePanel, ...targets }: AssistantOptions) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [scope, setScope] = useState<AiScope>({ [activePanel]: "write" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const current = useRef<Conversation | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const persist = useCallback((next: Conversation | null) => {
    current.current = next;
    setConversation(next);
    if (next && window.__TAURI_INTERNALS__) {
      void invoke("save_ai_conversation", { conversation: next }).catch((reason) => setError(`对话保存失败：${errorMessage(reason)}`));
    }
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    invoke<ConversationSummary[]>("list_ai_conversations")
      .then((list) => (list[0] ? invoke<Conversation>("load_ai_conversation", { id: list[0].id }) : null))
      .then((loaded) => {
        if (active && loaded && !current.current) {
          current.current = loaded;
          setConversation(loaded);
          const restored = scopeOf(loaded.messages);
          if (restored) setScope(restored);
        }
      })
      .catch((reason) => console.error(reason));
    return () => {
      active = false;
    };
  }, []);

  async function send(text: string) {
    const state = targetsRef.current.getState();
    const content = text.trim();
    if (!state || !content || busy) return;
    const now = new Date().toISOString();
    const base = current.current ?? { id: crypto.randomUUID(), title: content.slice(0, 40), panel: activePanel, createdAt: now, updatedAt: now, messages: [] };
    const turnScope = scope;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setStopped(false);
    try {
      const data = await loadAssistantData(turnScope, state);
      const session = createToolSession(data);
      await runTurn(base.messages, content, turnScope, {
        step: (request) => invoke<ChatStepReply>("ai_chat_step", { request }),
        context: assistantContext(turnScope, data),
        runTool: session.run,
        // After stop, a late step must not overwrite a conversation the user has moved on with.
        onMessages: (messages) => {
          if (!controller.signal.aborted) persist({ ...base, messages, updatedAt: new Date().toISOString() });
        },
        signal: controller.signal,
      });
    } catch (reason) {
      if (controller.signal.aborted || reason instanceof TurnStopped) return;
      setError(errorMessage(reason));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  /** Ends the running turn; the request in flight finishes in the background and is ignored. */
  function stop() {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setStopped(true);
  }

  /** `selectedIds === null` cancels the batch; otherwise the selected changes are written, one undo step per panel. */
  async function resolveBatch(batchId: string, selectedIds: string[] | null) {
    const conv = current.current;
    const target = conv?.messages.find((message) => message.role === "batch" && message.batch.id === batchId);
    if (!conv || target?.role !== "batch" || target.batch.status !== "pending") return;
    let batch: AiBatch;
    if (selectedIds === null) {
      batch = { ...target.batch, status: "cancelled" };
    } else {
      const selected = new Set(selectedIds);
      const changes = target.batch.changes.map((change) => ({ ...change, selected: selected.has(change.id) }));
      // Mark it resolved first so a second click cannot apply the batch twice.
      persist({ ...conv, messages: conv.messages.map((message) => (message.id === target.id ? { ...target, batch: { ...target.batch, status: "confirmed", changes } } : message)) });
      const failed = await commitChanges(changes.filter((change) => change.selected), targetsRef.current);
      batch = { ...target.batch, status: "confirmed", changes, failed };
    }
    const latest = current.current ?? conv;
    persist({
      ...latest,
      updatedAt: new Date().toISOString(),
      messages: latest.messages.map((message) => (message.id === target.id ? { ...target, batch } : message)),
    });
  }

  function startNew(panel: AiPanelId) {
    if (busy) return;
    persist(null);
    setScope({ [panel]: "write" });
    setError(null);
    setStopped(false);
  }

  return { conversation, scope, setScope, busy, error, stopped, send, stop, resolveBatch, startNew };
}
