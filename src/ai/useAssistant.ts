import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardFile, LoadedAppState } from "../types";
import { applyBoardBatch, boardIndex, createBoardSession } from "./boardTools";
import { runTurn } from "./turn";
import type { AiBatch, AiScope, ChatStepReply, Conversation, ConversationSummary } from "./types";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function localNow(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${WEEKDAYS[date.getDay()]}`;
}

/** Everything the model sees without calling a tool: the index of each panel the scope can read. */
export function assistantContext(scope: AiScope, state: LoadedAppState): string {
  return JSON.stringify({
    now: localNow(),
    ...(scope.board && { board: boardIndex(state.board, state.settings) }),
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "AI 请求失败，请检查 Provider 设置后重试。";
}

interface AssistantOptions {
  getState: () => LoadedAppState | null;
  /** Commits a confirmed batch as one undo step. */
  commitBoard: (board: BoardFile) => void;
}

/** Runs the assistant inside the main window, which owns the data, and keeps the conversation on disk. */
export function useAssistant({ getState, commitBoard }: AssistantOptions) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Conversation | null>(null);

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
        }
      })
      .catch((reason) => console.error(reason));
    return () => {
      active = false;
    };
  }, []);

  async function send(text: string, scope: AiScope) {
    const state = getState();
    const content = text.trim();
    if (!state || !content || busy) return;
    const now = new Date().toISOString();
    const base = current.current ?? { id: crypto.randomUUID(), title: content.slice(0, 40), panel: "board" as const, createdAt: now, updatedAt: now, messages: [] };
    const session = createBoardSession(state.board, state.settings);
    setBusy(true);
    setError(null);
    try {
      await runTurn(base.messages, content, scope, {
        step: (request) => invoke<ChatStepReply>("ai_chat_step", { request }),
        context: assistantContext(scope, state),
        runTool: session.run,
        onMessages: (messages) => persist({ ...base, messages, updatedAt: new Date().toISOString() }),
        panel: "board",
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  /** `selectedIds === null` cancels the batch; otherwise the selected changes are written as one undo step. */
  function resolveBatch(batchId: string, selectedIds: string[] | null) {
    const conv = current.current;
    const state = getState();
    const target = conv?.messages.find((message) => message.role === "batch" && message.batch.id === batchId);
    if (!conv || !state || target?.role !== "batch" || target.batch.status !== "pending") return;
    let batch: AiBatch;
    if (selectedIds === null) {
      batch = { ...target.batch, status: "cancelled" };
    } else {
      const selected = new Set(selectedIds);
      const changes = target.batch.changes.map((change) => ({ ...change, selected: selected.has(change.id) }));
      const result = applyBoardBatch(state.board, changes.filter((change) => change.selected));
      if (result.applied > 0) commitBoard(result.board);
      batch = { ...target.batch, status: "confirmed", changes, failed: result.failed };
    }
    persist({
      ...conv,
      updatedAt: new Date().toISOString(),
      messages: conv.messages.map((message) => (message.id === target.id ? { ...target, batch } : message)),
    });
  }

  function startNew() {
    if (busy) return;
    persist(null);
    setError(null);
  }

  return { conversation, busy, error, send, resolveBatch, startNew };
}
