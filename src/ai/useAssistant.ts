import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadedAppState } from "../types";
import { assistantContext, commitChanges, createToolSession, loadAssistantData, type CommitTargets } from "./session";
import { runTurn, TurnStopped } from "./turn";
import { AI_TASKS, defaultAccess, type AiBatch, type AiImageDraft, type AiPanelId, type AiScope, type AiTask, type ChatStepReply, type Conversation, type ConversationMessage, type ConversationSummary } from "./types";

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

/** Newest first, like the Rust index. */
function upsertSummary(list: ConversationSummary[], { messages: _messages, ...summary }: Conversation): ConversationSummary[] {
  return [summary, ...list.filter((entry) => entry.id !== summary.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

interface AssistantOptions extends Omit<CommitTargets, "getState"> {
  getState: () => LoadedAppState | null;
  /** Panel a new conversation starts from; its pill is prefilled as writable. */
  activePanel: AiPanelId;
}

/** Runs the assistant inside the main window, which owns the data, and keeps the conversation on disk. */
export function useAssistant({ activePanel, ...targets }: AssistantOptions) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [scope, setScope] = useState<AiScope>({ [activePanel]: defaultAccess(activePanel) });
  /** Chip of a new conversation started from an entry action; it goes out with the first message. */
  const [task, setTask] = useState<AiTask | null>(null);
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
    if (next) setSummaries((list) => upsertSummary(list, next));
    if (next && window.__TAURI_INTERNALS__) {
      void invoke("save_ai_conversation", { conversation: next }).catch((reason) => setError(`对话保存失败：${errorMessage(reason)}`));
    }
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let active = true;
    invoke<ConversationSummary[]>("list_ai_conversations")
      .then((list) => {
        if (active) setSummaries((local) => list.reduce<ConversationSummary[]>((merged, entry) => (merged.some((item) => item.id === entry.id) ? merged : [...merged, entry]), local));
        return list[0] ? invoke<Conversation>("load_ai_conversation", { id: list[0].id }) : null;
      })
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

  /** `newScope` and `start` apply only when this message starts a conversation (bebe uses its own default). */
  async function send(text: string, newScope?: AiScope, images: AiImageDraft[] = [], start?: { task: AiTask; title: string }) {
    const state = targetsRef.current.getState();
    const content = text.trim();
    if (!state || (!content && images.length === 0) || busy) return;
    const now = new Date().toISOString();
    const isFirstTurn = (current.current?.messages.length ?? 0) === 0;
    const turnTask = isFirstTurn ? start?.task ?? task : null;
    const firstTitle = start?.title ?? (content.replace(/\s+/g, " ").slice(0, 20) || (turnTask ? AI_TASKS[turnTask].label : "图片"));
    const base = current.current ?? { id: crypto.randomUUID(), title: firstTitle, panel: turnTask ? AI_TASKS[turnTask].panel : activePanel, createdAt: now, updatedAt: now, messages: [] };
    const turnScope = isFirstTurn && newScope ? newScope : scope;
    if (turnScope !== scope) setScope(turnScope);
    if (turnTask) setTask(null);
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setStopped(false);
    try {
      const data = await loadAssistantData(turnScope, state);
      const session = createToolSession(data);
      const messages = await runTurn(base.messages, content, turnScope, {
        step: (request) => invoke<ChatStepReply>("ai_chat_step", { request }),
        context: assistantContext(turnScope, data),
        runTool: session.run,
        // After stop, a late step must not overwrite a conversation the user has moved on with.
        onMessages: (messages) => {
          if (controller.signal.aborted) return;
          // Keep a title the user (or auto-naming) set while the turn was running.
          const latest = current.current?.id === base.id ? current.current : base;
          persist({ ...latest, messages, updatedAt: new Date().toISOString() });
        },
        signal: controller.signal,
      }, { images, task: turnTask ?? undefined });
      if (isFirstTurn && !start) {
        const reply = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
        void autoTitle(base.id, firstTitle, content || firstTitle, reply?.role === "assistant" ? reply.content : "");
      }
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

  /** Names a new conversation after its first round; keeps the fallback title if naming fails or the user renamed it. */
  async function autoTitle(id: string, fallback: string, text: string, reply: string) {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      const title = await invoke<string>("ai_generate_title", { request: { text, reply } });
      const conv = current.current;
      if (title && conv?.id === id && conv.title === fallback) persist({ ...conv, title });
    } catch (reason) {
      console.error(reason);
    }
  }

  function rename(title: string) {
    const conv = current.current;
    const next = title.trim().slice(0, 60);
    if (!conv || !next || next === conv.title) return;
    persist({ ...conv, title: next });
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

  /** A new conversation started by an entry action (写进日记) and sent right away: its task, scope and first message. */
  async function startTask(nextTask: AiTask, turnScope: AiScope, text: string, title: string) {
    if (busy) return;
    current.current = null;
    setConversation(null);
    await send(text, turnScope, [], { task: nextTask, title });
  }

  /** `nextTask` pre-fills the chip of an entry action (e.g. 提取习惯 on the board). */
  /** `scope` overrides the default (the start panel's pill); the workbench starts with none. */
  function startNew(panel: AiPanelId, nextTask: AiTask | null = null, scope?: AiScope) {
    if (busy) return;
    persist(null);
    setTask(nextTask);
    const start = nextTask ? AI_TASKS[nextTask].panel : panel;
    setScope(scope ?? { [start]: defaultAccess(start) });
    setError(null);
    setStopped(false);
  }

  /** Re-reads the list after the AI folder changed outside beta-life (an exported md was deleted). */
  async function refreshSummaries() {
    if (!window.__TAURI_INTERNALS__) return;
    const list = await invoke<ConversationSummary[]>("list_ai_conversations");
    setSummaries(list);
    if (current.current && !busy && !list.some((entry) => entry.id === current.current?.id)) startNew(activePanel);
  }

  /** Switches the shared conversation (dock and workbench) to a saved one. */
  async function open(id: string) {
    if (busy || current.current?.id === id) return;
    try {
      const loaded = await invoke<Conversation>("load_ai_conversation", { id });
      current.current = loaded;
      setConversation(loaded);
      setTask(null);
      setScope(scopeOf(loaded.messages) ?? { [loaded.panel]: defaultAccess(loaded.panel) });
      setError(null);
      setStopped(false);
    } catch (reason) {
      setError(`对话载入失败：${errorMessage(reason)}`);
    }
  }

  async function remove(id: string) {
    if (busy && current.current?.id === id) return;
    try {
      await invoke("delete_ai_conversation", { id });
    } catch (reason) {
      setError(`对话删除失败：${errorMessage(reason)}`);
      return;
    }
    setSummaries((list) => list.filter((entry) => entry.id !== id));
    if (current.current?.id === id) startNew(activePanel);
  }

  return { conversation, summaries, scope, setScope, task, setTask, busy, error, stopped, send, stop, resolveBatch, startTask, startNew, rename, open, remove, refreshSummaries };
}
