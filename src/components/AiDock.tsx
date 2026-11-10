import { CircleAlert, CircleCheck, Eye, Layers, LoaderCircle, MessageSquarePlus, Pencil, Plus, Send, Shield, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { pendingBatch } from "../ai/turn";
import { changePanel, type AiAccess, type AiBatch, type AiPanelId, type AiScope, type ChangeKind, type CheckedToolCall, type Conversation, type ConversationMessage } from "../ai/types";
import { MarkdownContent } from "./MarkdownEditor";

export const AI_PANELS: Record<AiPanelId, { name: string; color: string }> = {
  board: { name: "时间板", color: "#d97706" },
  recall: { name: "回想", color: "#ea580c" },
  forest: { name: "能力森林", color: "#16a34a" },
  memories: { name: "记忆星云", color: "#6366f1" },
};
const PANEL_ORDER: AiPanelId[] = ["board", "recall", "forest", "memories"];
const ACCESS_LABELS: Record<AiAccess, string> = { read: "只读", write: "可改" };
const OP_LABELS: Record<ChangeKind, string> = { add: "新增", edit: "修改", move: "移动", del: "删除" };

const panelStyle = (panel: AiPanelId) => ({ "--ai-panel-color": AI_PANELS[panel].color }) as CSSProperties;

interface AiDockProps {
  conversation: Conversation | null;
  busy: boolean;
  error: string | null;
  hasApiKey: boolean;
  activePanel: AiPanelId;
  scope: AiScope;
  onScopeChange: (scope: AiScope) => void;
  /** Bump to focus the input (⌘K). */
  focusRequest: number;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
  onResolveBatch: (batchId: string, selectedIds: string[] | null) => void;
  onNewConversation: () => void;
}

interface Mention {
  /** Index of the "@" in the draft. */
  start: number;
  query: string;
  highlighted: number;
  access: Partial<Record<AiPanelId, AiAccess>>;
}

/** Messages from the latest user message onward. */
function latestRound(messages: ConversationMessage[]): ConversationMessage[] {
  const start = messages.map((message) => message.role).lastIndexOf("user");
  return start < 0 ? [] : messages.slice(start);
}

function scopeSummary(scope: AiScope): string {
  const parts = PANEL_ORDER.filter((panel) => scope[panel]).map((panel) => `${scope[panel] === "write" ? "可改" : "只读"}${AI_PANELS[panel].name}`);
  return parts.length > 0 ? `本条${parts.join(" · ")}` : "本条没有授权任何 panel";
}

function parseResult(content: string | undefined): Record<string, unknown> {
  try {
    return content ? (JSON.parse(content) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One readable line per read tool; writes appear in the diff card instead. */
function traceLabel(call: CheckedToolCall, result: Record<string, unknown>): string | null {
  const named = (value: unknown) => (typeof value === "string" && value ? `「${value.slice(0, 24)}」` : "");
  switch (call.name) {
    case "list_habits": return "读取了时间板的全部习惯";
    case "list_boards": return "查看了看板列表";
    case "list_nodes": return `读取了能力森林${named(result.name)}的节点`;
    case "read_node": return `读了节点${named(result.name)}的笔记`;
    case "list_knowledge": return "读取了知识列表";
    case "read_knowledge": return `读了知识${named(result.title)}`;
    case "list_due_reviews": return `查看了待复习的知识${Array.isArray(result.due) ? `（${result.due.length} 篇）` : ""}`;
    case "list_memories": return "读取了全部记忆";
    case "read_memory": return `读了记忆${named(result.song || result.content)}`;
    case "list_life_stages": return "查看了人生阶段";
    default: return null;
  }
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
  const panels = PANEL_ORDER.filter((panel) => batch.changes.some((change) => changePanel(change) === panel));
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
      {panels.map((panel) => (
        <div key={panel} className="ai-diff-group">
          {panels.length > 1 && <div className="ai-diff-panel" style={panelStyle(panel)}>{AI_PANELS[panel].name}</div>}
          {batch.changes.filter((change) => changePanel(change) === panel).map((change) => {
            const checked = pending ? selected.has(change.id) : change.selected;
            return (
              <label key={change.id} className={`ai-diff-row ${checked ? "" : "is-unchecked"}`}>
                <input type="checkbox" checked={checked} disabled={!pending} onChange={() => toggle(change.id)} />
                <span className={`ai-op ${change.kind}`}>{OP_LABELS[change.kind]}</span>
                <span className="ai-diff-text">
                  {change.title}
                  {change.detail && <small>{change.detail}</small>}
                  {failed.has(change.id) && <small className="ai-diff-failed">没有写入：{failed.get(change.id)}</small>}
                </span>
              </label>
            );
          })}
        </div>
      ))}
      <div className="ai-diff-foot">
        {pending ? (
          <>
            <small>{panels.length === 1 ? `确认后整批可在${AI_PANELS[panels[0]].name} ⌘Z 一次撤销` : "确认后每个 panel 各记一步，可在对应 panel ⌘Z 撤销"}</small>
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
  const results = new Map(round.flatMap((message) => (message.role === "tool" ? [[message.toolCallId, message.content] as const] : [])));
  return (
    <>
      {round.map((message) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="ai-msg-user-wrap">
              <div className="ai-msg-user">{message.content}</div>
              <div className="ai-msg-scope"><Shield size={11} aria-hidden="true" />{scopeSummary(message.scope)}</div>
            </div>
          );
        }
        if (message.role === "batch") return <DiffCard key={message.batch.id} batch={message.batch} onResolve={onResolve} />;
        if (message.role === "tool") return null;
        const trace = message.toolCalls.flatMap((call) => {
          const result = parseResult(results.get(call.id));
          const failure = call.error ?? (typeof result.error === "string" ? result.error : undefined);
          if (failure && result.status !== "staged") {
            return [<div key={call.id} className="is-error"><CircleAlert size={13} aria-hidden="true" />{call.name} 没有执行：{failure}</div>];
          }
          const label = traceLabel(call, result);
          return label ? [<div key={call.id}><CircleCheck size={13} aria-hidden="true" />{label}</div>] : [];
        });
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

export function AiDock({ conversation, busy, error, hasApiKey, activePanel, scope, onScopeChange, focusRequest, onOpenSettings, onSend, onResolveBatch, onNewConversation }: AiDockProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [mention, setMention] = useState<Mention | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bodyEnd = useRef<HTMLDivElement>(null);
  const messages = conversation?.messages ?? [];
  const round = latestRound(messages);
  const pendingId = pendingBatch(messages)?.id;
  const options = mention
    ? PANEL_ORDER.filter((panel) => !mention.query || AI_PANELS[panel].name.includes(mention.query) || panel.startsWith(mention.query.toLowerCase()))
    : [];

  useEffect(() => {
    if (pendingId) setOpen(true);
  }, [pendingId]);

  useEffect(() => {
    bodyEnd.current?.scrollIntoView?.({ block: "end" });
  }, [round.length, busy]);

  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  function resize() {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }

  function updateDraft(value: string, caret: number) {
    setDraft(value);
    resize();
    const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[2];
    setMention((current) => ({
      start: caret - query.length - 1,
      query,
      highlighted: current?.query === query ? current.highlighted : 0,
      access: current?.access ?? {},
    }));
  }

  function accessFor(panel: AiPanelId): AiAccess {
    return mention?.access[panel] ?? scope[panel] ?? (panel === activePanel ? "write" : "read");
  }

  function insertMention(panel: AiPanelId) {
    if (!mention) return;
    onScopeChange({ ...scope, [panel]: accessFor(panel) });
    const end = mention.start + 1 + mention.query.length;
    setDraft(draft.slice(0, mention.start) + draft.slice(end));
    setMention(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(mention.start, mention.start);
    });
  }

  function toggleMentionAccess(panel: AiPanelId) {
    setMention((current) => current && { ...current, access: { ...current.access, [panel]: accessFor(panel) === "write" ? "read" : "write" } });
  }

  function removePill(panel: AiPanelId) {
    const next = { ...scope };
    delete next[panel];
    onScopeChange(next);
  }

  function submit() {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
    setMention(null);
    setOpen(true);
    requestAnimationFrame(resize);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter while an IME is composing picks a candidate; it must not send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mention && options.length > 0) {
      const panel = options[Math.min(mention.highlighted, options.length - 1)];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, highlighted: (mention.highlighted + step + options.length) % options.length });
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        toggleMentionAccess(panel);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        insertMention(panel);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
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
        {mention && options.length > 0 && (
          <div className="ai-mention-menu" role="listbox" aria-label="选择要提及的 panel">
            {options.map((panel, index) => (
              <div
                key={panel}
                role="option"
                aria-selected={index === mention.highlighted}
                className={`ai-mention-row ${index === mention.highlighted ? "is-active" : ""}`}
                style={panelStyle(panel)}
                onMouseDown={(event) => { event.preventDefault(); insertMention(panel); }}
              >
                <span className="ai-mention-name">{AI_PANELS[panel].name}</span>
                <button
                  type="button"
                  className={`ai-mention-access ${accessFor(panel)}`}
                  onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); toggleMentionAccess(panel); }}
                >
                  {accessFor(panel) === "write" ? <Pencil size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}
                  {ACCESS_LABELS[accessFor(panel)]}
                </button>
              </div>
            ))}
            <div className="ai-mention-hint">↑↓ 选择 · Enter 插入 · Tab 切换只读 / 可改</div>
          </div>
        )}
        <div className="ai-dock-pills">
          {PANEL_ORDER.filter((panel) => scope[panel]).map((panel) => (
            <span key={panel} className="ai-at-pill" style={panelStyle(panel)}>
              <button
                type="button"
                className="ai-at-pill-main"
                onClick={() => onScopeChange({ ...scope, [panel]: scope[panel] === "write" ? "read" : "write" })}
                title={`${scope[panel] === "write" ? "可以读取和修改" : "只能读取"}${AI_PANELS[panel].name}，点击切换`}
              >
                @{AI_PANELS[panel].name}
                {scope[panel] === "write" ? <Pencil size={11} aria-label="可改" /> : <Eye size={11} aria-label="只读" />}
              </button>
              <button type="button" className="ai-at-pill-remove" onClick={() => removePill(panel)} aria-label={`移除 @${AI_PANELS[panel].name}`}>
                <X size={10} />
              </button>
            </span>
          ))}
          {!scope[activePanel] && (
            <button type="button" className="ai-at-ghost" style={panelStyle(activePanel)} onClick={() => onScopeChange({ ...scope, [activePanel]: "write" })}>
              <Plus size={11} aria-hidden="true" />@{AI_PANELS[activePanel].name}
            </button>
          )}
        </div>
        {hasApiKey ? (
          <textarea
            ref={input}
            className="ai-dock-input"
            rows={1}
            value={draft}
            placeholder={PANEL_ORDER.filter((panel) => scope[panel]).length > 1 ? "问 AI…（@ 添加 panel）" : `问 AI，或让它帮你改${AI_PANELS[activePanel].name}…（@ 添加 panel）`}
            aria-label="给 AI 助手发消息"
            onChange={(event) => updateDraft(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
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
