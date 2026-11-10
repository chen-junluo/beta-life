import { CircleAlert, CircleCheck, Layers, LoaderCircle, MessageSquarePlus, Pencil, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { pendingBatch } from "../ai/turn";
import type { AiBatch, AiScope, ChangeKind, Conversation, ConversationMessage } from "../ai/types";
import { MarkdownContent } from "./MarkdownEditor";

/** P2.1 has a fixed `@时间板 ✎` scope; P2.2 replaces it with @ mentions. */
const DOCK_SCOPE: AiScope = { board: "write" };

const OP_LABELS: Record<ChangeKind, string> = { add: "新增", edit: "修改", move: "移动", del: "删除" };

const READ_TRACE: Record<string, string> = {
  list_habits: "读取了时间板的全部习惯",
  list_boards: "查看了看板列表",
};

interface AiDockProps {
  conversation: Conversation | null;
  busy: boolean;
  error: string | null;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onSend: (text: string, scope: AiScope) => void;
  onResolveBatch: (batchId: string, selectedIds: string[] | null) => void;
  onNewConversation: () => void;
}

/** Messages from the latest user message onward. */
function latestRound(messages: ConversationMessage[]): ConversationMessage[] {
  const start = messages.map((message) => message.role).lastIndexOf("user");
  return start < 0 ? [] : messages.slice(start);
}

function resolvedLabel(batch: AiBatch): string {
  if (batch.status === "cancelled") return "已取消，没有写入任何修改";
  if (batch.status === "superseded") return "已作废：你发了新消息，这批修改没有写入";
  const failed = batch.failed?.length ?? 0;
  const applied = batch.changes.filter((change) => change.selected).length - failed;
  const skipped = batch.changes.filter((change) => !change.selected).length;
  return [`已写入 ${applied} 项`, skipped > 0 && `未勾选 ${skipped} 项`, failed > 0 && `失败 ${failed} 项`].filter(Boolean).join(" · ");
}

function DiffCard({ batch, onResolve }: { batch: AiBatch; onResolve: AiDockProps["onResolveBatch"] }) {
  const [selected, setSelected] = useState(() => new Set(batch.changes.filter((change) => change.selected).map((change) => change.id)));
  const pending = batch.status === "pending";
  const failed = new Map((batch.failed ?? []).map((entry) => [entry.changeId, entry.reason]));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={`ai-diff ${pending ? "" : "is-resolved"}`} aria-label="待确认修改">
      <div className="ai-diff-head"><Layers size={14} aria-hidden="true" />{pending ? `待确认修改 · ${batch.changes.length} 项` : "修改记录"}</div>
      {batch.changes.map((change) => (
        <label key={change.id} className={`ai-diff-row ${(pending ? selected.has(change.id) : change.selected) ? "" : "is-unchecked"}`}>
          <input
            type="checkbox"
            checked={pending ? selected.has(change.id) : change.selected}
            disabled={!pending}
            onChange={() => toggle(change.id)}
          />
          <span className={`ai-op ${change.kind}`}>{OP_LABELS[change.kind]}</span>
          <span className="ai-diff-text">
            {change.title}
            {change.detail && <small>{change.detail}</small>}
            {failed.has(change.id) && <small className="ai-diff-failed">没有写入：{failed.get(change.id)}</small>}
          </span>
        </label>
      ))}
      <div className="ai-diff-foot">
        {pending ? (
          <>
            <small>确认后整批可在时间板 ⌘Z 一次撤销</small>
            <button type="button" className="secondary-button" onClick={() => onResolve(batch.id, null)}>取消</button>
            <button type="button" className="primary-button" disabled={selected.size === 0} onClick={() => onResolve(batch.id, [...selected])}>
              确认 {selected.size} 项
            </button>
          </>
        ) : (
          <small>{resolvedLabel(batch)}</small>
        )}
      </div>
    </div>
  );
}

function RoundView({ round, onResolve }: { round: ConversationMessage[]; onResolve: AiDockProps["onResolveBatch"] }) {
  return (
    <>
      {round.map((message) => {
        if (message.role === "user") return <div key={message.id} className="ai-msg-user">{message.content}</div>;
        if (message.role === "batch") return <DiffCard key={message.batch.id} batch={message.batch} onResolve={onResolve} />;
        if (message.role === "tool") return null;
        const trace = message.toolCalls
          .filter((call) => call.error || READ_TRACE[call.name])
          .map((call) => (
            <div key={call.id} className={call.error ? "is-error" : ""}>
              {call.error ? <CircleAlert size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}
              {call.error ? `${call.name} 被拒绝：${call.error}` : READ_TRACE[call.name]}
            </div>
          ));
        return (
          <div key={message.id} className="ai-msg-assistant">
            {trace.length > 0 && <div className="ai-trace">{trace}</div>}
            {message.content.trim() && <MarkdownContent className="ai-msg-text" value={message.content} />}
          </div>
        );
      })}
    </>
  );
}

export function AiDock({ conversation, busy, error, hasApiKey, onOpenSettings, onSend, onResolveBatch, onNewConversation }: AiDockProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bodyEnd = useRef<HTMLDivElement>(null);
  const messages = conversation?.messages ?? [];
  const round = latestRound(messages);
  const pendingId = pendingBatch(messages)?.id;

  useEffect(() => {
    if (pendingId) setOpen(true);
  }, [pendingId]);

  useEffect(() => {
    bodyEnd.current?.scrollIntoView?.({ block: "end" });
  }, [round.length, busy]);

  function resize() {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }

  function submit() {
    if (!draft.trim() || busy) return;
    onSend(draft, DOCK_SCOPE);
    setDraft("");
    setOpen(true);
    requestAnimationFrame(resize);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter while an IME is composing picks a candidate; it must not send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }

  function resolve(batchId: string, selectedIds: string[] | null) {
    onResolveBatch(batchId, selectedIds);
    setOpen(false);
  }

  const showCard = (open || busy || Boolean(error)) && (round.length > 0 || busy || Boolean(error));

  return (
    <div className="ai-dock">
      {showCard && (
        <section className="ai-dock-card" aria-label="AI 最近一轮">
          <header className="ai-dock-head">
            <Sparkles size={14} aria-hidden="true" />
            <span>最近一轮</span>
            <button type="button" className="icon-button" onClick={onNewConversation} disabled={busy} aria-label="新对话" title="新对话">
              <MessageSquarePlus size={15} />
            </button>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} disabled={busy} aria-label="收起" title="收起">
              <X size={15} />
            </button>
          </header>
          <div className="ai-dock-body">
            <RoundView key={conversation?.id} round={round} onResolve={resolve} />
            {busy && <div className="ai-thinking"><LoaderCircle size={14} className="spin" aria-hidden="true" />思考中…</div>}
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div ref={bodyEnd} />
          </div>
        </section>
      )}
      <form className="ai-dock-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <span className="ai-at-pill" title="这条消息可以读取和修改时间板">@时间板 <Pencil size={11} aria-label="可改" /></span>
        {hasApiKey ? (
          <textarea
            ref={input}
            className="ai-dock-input"
            rows={1}
            value={draft}
            placeholder="问 AI，或让它帮你改时间板…"
            aria-label="给 AI 助手发消息"
            onChange={(event) => { setDraft(event.target.value); resize(); }}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <button type="button" className="ai-dock-setup" onClick={onOpenSettings}>先在 Settings 里保存 API key，才能使用 AI 助手</button>
        )}
        {conversation && !showCard && (
          <button type="button" className="icon-button" onClick={onNewConversation} disabled={busy} aria-label="新对话" title="新对话">
            <MessageSquarePlus size={16} />
          </button>
        )}
        <button type="submit" className="primary-button ai-dock-send" disabled={!hasApiKey || busy || !draft.trim()} aria-label="发送">
          {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
        </button>
      </form>
    </div>
  );
}
