import { AtSign, ChevronUp, CircleAlert, CircleCheck, Eye, Layers, LoaderCircle, MessageSquarePlus, Pencil, Plus, Send, Shield, Sparkles, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
type PickerAccess = AiAccess | "off";
const PICKER_LEVELS: PickerAccess[] = ["off", "read", "write"];
const PICKER_LABELS: Record<PickerAccess, string> = { off: "不访问", read: "只读", write: "可改" };
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
  /** The user stopped the last turn. */
  stopped: boolean;
  onStop: () => void;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
  onResolveBatch: (batchId: string, selectedIds: string[] | null) => void;
  onNewConversation: () => void;
  onRename: (title: string) => void;
}

/** The @ picker edits all four panels at once; nothing changes until it is confirmed. */
interface Picker {
  draft: AiScope;
  highlighted: number;
  /** Where the typed "@query" starts, or null when opened with the @ button. */
  start: number | null;
  query: string;
  /** Before the first message the picker opens from the composer; afterwards from the scope dots in the header. */
  anchor: "composer" | "header";
}

function scopeText(scope: AiScope): string {
  const parts = PANEL_ORDER.filter((panel) => scope[panel]).map((panel) => `${scope[panel] === "write" ? "可改" : "只读"}${AI_PANELS[panel].name}`);
  return parts.length > 0 ? parts.join(" · ") : "没有授权任何 panel";
}

const sameScope = (left: AiScope, right: AiScope) => PANEL_ORDER.every((panel) => left[panel] === right[panel]);

/** The conversation's permissions as colored circles (pen = can modify, eye = read only); click to change. */
function ScopeDots({ scope, activePanel, disabled, onEdit, onAddActive }: { scope: AiScope; activePanel: AiPanelId; disabled: boolean; onEdit: () => void; onAddActive: () => void }) {
  const panels = PANEL_ORDER.filter((panel) => scope[panel]);
  return (
    <div className="ai-scope-dots">
      <button
        type="button"
        className="ai-scope-edit"
        disabled={disabled}
        aria-label={`权限：${scopeText(scope)}。点击修改`}
        title={`${scopeText(scope)}（点击修改，下一条消息生效）`}
        onMouseDown={(event) => { event.preventDefault(); onEdit(); }}
      >
        {panels.length === 0 ? <span className="ai-scope-none">无权限</span> : panels.map((panel) => (
          <span key={panel} className="ai-scope-dot" style={panelStyle(panel)}>
            {scope[panel] === "write" ? <Pencil size={10} aria-hidden="true" /> : <Eye size={10} aria-hidden="true" />}
          </span>
        ))}
      </button>
      {!scope[activePanel] && (
        <button
          type="button"
          className="ai-scope-dot is-ghost"
          style={panelStyle(activePanel)}
          disabled={disabled}
          onClick={onAddActive}
          aria-label={`加入 @${AI_PANELS[activePanel].name}（可改）`}
          title={`加入 @${AI_PANELS[activePanel].name}（可改）`}
        >
          <Plus size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The conversation name, renamed in place. */
function TitleEditor({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    const finish = () => {
      onRename(editing);
      setEditing(null);
    };
    return (
      <input
        className="ai-dock-title-input"
        value={editing}
        autoFocus
        aria-label="对话名称"
        maxLength={60}
        onChange={(event) => setEditing(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") finish();
          if (event.key === "Escape") setEditing(null);
        }}
      />
    );
  }
  return (
    <button type="button" className="ai-dock-title" onClick={() => setEditing(title)} title={`${title}（点击重命名）`}>
      <span>{title}</span>
      <Pencil size={11} aria-hidden="true" />
    </button>
  );
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
  // Batch reads return { items }; conversations saved before that hold a single object.
  const items = (Array.isArray(result.items) ? result.items : [result]) as Array<Record<string, unknown>>;
  const names = (key: (item: Record<string, unknown>) => unknown) => {
    const list = items.filter((item) => !item.error).map((item) => named(key(item))).filter(Boolean);
    return list.length > 3 ? `${list.slice(0, 3).join("")}等 ${list.length} 条` : list.join("");
  };
  switch (call.name) {
    case "list_habits": return "读取了时间板的全部习惯";
    case "list_boards": return "查看了看板列表";
    case "list_nodes": return `读取了能力森林${named(result.name)}的节点`;
    case "read_node": return `读了节点${names((item) => item.name)}的笔记`;
    case "list_knowledge": return "读取了知识列表";
    case "read_knowledge": return `读了知识${names((item) => item.title)}`;
    case "list_due_reviews": return `查看了待复习的知识${Array.isArray(result.due) ? `（${result.due.length} 篇）` : ""}`;
    case "list_memories": return "读取了全部记忆";
    case "read_memory": return `读了记忆${names((item) => item.song || item.content)}`;
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

/** The whole conversation; a scope line appears only where the permissions changed. */
function ConversationView({ messages, onResolve }: { messages: ConversationMessage[]; onResolve: AiDockProps["onResolveBatch"] }) {
  const results = new Map(messages.flatMap((message) => (message.role === "tool" ? [[message.toolCallId, message.content] as const] : [])));
  let previousScope: AiScope | null = null;
  return (
    <>
      {messages.map((message) => {
        if (message.role === "user") {
          const changed = previousScope !== null && !sameScope(previousScope, message.scope);
          previousScope = message.scope;
          return (
            <div key={message.id} className="ai-msg-user-wrap">
              <div className="ai-msg-user">{message.content}</div>
              {changed && <div className="ai-msg-scope"><Shield size={11} aria-hidden="true" />权限改为：{scopeText(message.scope)}</div>}
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

function panelMatches(panel: AiPanelId, query: string): boolean {
  return !query || AI_PANELS[panel].name.includes(query) || panel.startsWith(query.toLowerCase());
}

export function AiDock({ conversation, busy, error, hasApiKey, activePanel, scope, onScopeChange, focusRequest, stopped, onStop, onOpenSettings, onSend, onResolveBatch, onNewConversation, onRename }: AiDockProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [flow, setFlow] = useState({ indent: 0, top: 0 });
  /** Long first message: pills get their own row above the text instead of overlapping it. */
  const [stacked, setStacked] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const bodyEnd = useRef<HTMLDivElement>(null);
  const messages = conversation?.messages ?? [];
  const pendingId = pendingBatch(messages)?.id;
  const pills = PANEL_ORDER.filter((panel) => scope[panel]);
  // Permissions are chosen once in the composer; after the first message it is plain text.
  const isNew = !messages.some((message) => message.role === "user");

  useEffect(() => {
    if (pendingId) setOpen(true);
  }, [pendingId]);

  useEffect(() => {
    bodyEnd.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, busy, open]);

  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  // Pills sit in the text flow: the first text line starts after the last pill, later lines wrap under them.
  useLayoutEffect(() => {
    const container = pillsRef.current;
    if (!container) return;
    const measure = () => {
      const last = container.lastElementChild as HTMLElement | null;
      if (!last) {
        setFlow({ indent: 0, top: 0 });
      } else {
        const indent = last.offsetLeft + last.offsetWidth + 6;
        // Too little room left on the pill line: start the text on the next line.
        setFlow(indent > container.clientWidth - 72 ? { indent: 0, top: last.offsetTop + last.offsetHeight + 4 } : { indent, top: last.offsetTop });
      }
      requestAnimationFrame(resize);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scope, activePanel, hasApiKey, isNew]);

  useLayoutEffect(() => {
    resize();
  }, [stacked, isNew]);

  function resize() {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    // Text spilling past its first line would scroll under the overlaid pills: stack them instead.
    if (pillsRef.current?.childElementCount && element.scrollHeight > element.clientHeight + 2) setStacked(true);
    element.style.height = `${Math.min(element.scrollHeight, 156)}px`;
  }

  function openPicker(start: number | null, query: string, anchor: Picker["anchor"] = "composer") {
    setPicker((current) => {
      const highlighted = query ? Math.max(0, PANEL_ORDER.findIndex((panel) => panelMatches(panel, query))) : current?.highlighted ?? Math.max(0, PANEL_ORDER.indexOf(activePanel));
      return { draft: current?.draft ?? { ...scope }, highlighted, start, query, anchor };
    });
  }

  function updateDraft(value: string, caret: number) {
    setDraft(value);
    if (!value) setStacked(false);
    resize();
    // Typing @ picks panels only before the first message; later an @ is just text.
    const match = isNew ? /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret)) : null;
    if (match) openPicker(caret - match[2].length - 1, match[2]);
    else if (picker?.start !== null) setPicker(null);
  }

  function setPickerAccess(panel: AiPanelId, access: PickerAccess) {
    setPicker((current) => {
      if (!current) return current;
      const next = { ...current.draft };
      if (access === "off") delete next[panel];
      else next[panel] = access;
      return { ...current, draft: next };
    });
  }

  function stepPickerAccess(direction: 1 | -1) {
    if (!picker) return;
    const panel = PANEL_ORDER[picker.highlighted];
    const level = PICKER_LEVELS.indexOf(picker.draft[panel] ?? "off");
    setPickerAccess(panel, PICKER_LEVELS[Math.max(0, Math.min(PICKER_LEVELS.length - 1, level + direction))]);
  }

  function applyPicker() {
    if (!picker) return;
    onScopeChange(picker.draft);
    const { start, query } = picker;
    setPicker(null);
    if (start === null) return;
    setDraft(draft.slice(0, start) + draft.slice(start + 1 + query.length));
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(start, start);
    });
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
    setStacked(false);
    setPicker(null);
    setOpen(true);
    requestAnimationFrame(resize);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter while an IME is composing picks a candidate; it must not send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (picker) {
      const keys: Record<string, () => void> = {
        ArrowDown: () => setPicker({ ...picker, highlighted: (picker.highlighted + 1) % PANEL_ORDER.length }),
        ArrowUp: () => setPicker({ ...picker, highlighted: (picker.highlighted + PANEL_ORDER.length - 1) % PANEL_ORDER.length }),
        ArrowRight: () => stepPickerAccess(1),
        ArrowLeft: () => stepPickerAccess(-1),
        Tab: () => {
          const panel = PANEL_ORDER[picker.highlighted];
          const level = PICKER_LEVELS.indexOf(picker.draft[panel] ?? "off");
          setPickerAccess(panel, PICKER_LEVELS[(level + 1) % PICKER_LEVELS.length]);
        },
        Enter: applyPicker,
        Escape: () => setPicker(null),
      };
      const action = keys[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
      return;
    }
    // Backspace at the very start deletes the last pill, like a chip in a token field.
    const target = event.currentTarget;
    if (isNew && event.key === "Backspace" && target.selectionStart === 0 && target.selectionEnd === 0 && pills.length > 0) {
      event.preventDefault();
      removePill(pills[pills.length - 1]);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  function resolve(batchId: string, selectedIds: string[] | null) {
    onResolveBatch(batchId, selectedIds);
    setOpen(false);
  }

  const showCard = (open || busy || Boolean(error)) && (messages.length > 0 || busy || Boolean(error));
  const flowStyle = stacked ? { textIndent: 0, paddingTop: 4 } : { textIndent: flow.indent, paddingTop: 4 + flow.top };

  const pickerMenu = picker && (
    <div className={`ai-mention-menu ${picker.anchor === "header" ? "is-header" : ""}`} role="dialog" aria-label="选择 AI 可以访问的 panel">
      <div className="ai-mention-title">{picker.anchor === "header" ? "修改这段对话的权限（下一条消息生效）" : "选择 AI 可以访问的 panel"}</div>
      {PANEL_ORDER.map((panel, index) => {
        const access = picker.draft[panel] ?? "off";
        return (
          <div
            key={panel}
            className={`ai-mention-row ${index === picker.highlighted ? "is-active" : ""}`}
            style={panelStyle(panel)}
            onMouseDown={(event) => { event.preventDefault(); setPicker({ ...picker, highlighted: index }); }}
          >
            <span className="ai-mention-name">{AI_PANELS[panel].name}</span>
            <span className="ai-mention-seg" role="radiogroup" aria-label={`${AI_PANELS[panel].name}的权限`}>
              {PICKER_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={access === level}
                  className={access === level ? `is-on ${level}` : ""}
                  onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); setPicker({ ...picker, highlighted: index }); setPickerAccess(panel, level); }}
                >
                  {PICKER_LABELS[level]}
                </button>
              ))}
            </span>
          </div>
        );
      })}
      <div className="ai-mention-foot">
        <span>↑↓ 选行 · ←→ 切换 · Enter 确定</span>
        <button type="button" className="secondary-button" onMouseDown={(event) => { event.preventDefault(); setPicker(null); }}>取消</button>
        <button type="button" className="primary-button" onMouseDown={(event) => { event.preventDefault(); applyPicker(); }}>确定</button>
      </div>
    </div>
  );

  return (
    <div className="ai-dock">
      {showCard && (
        <section className="ai-dock-card" aria-label="AI 对话">
          <header className="ai-dock-head">
            <Sparkles size={14} aria-hidden="true" />
            {conversation ? <TitleEditor key={conversation.id} title={conversation.title} onRename={onRename} /> : <span className="ai-dock-title-static">新对话</span>}
            {!isNew && (
              <ScopeDots
                scope={scope}
                activePanel={activePanel}
                disabled={!hasApiKey}
                onEdit={() => {
                  input.current?.focus();
                  if (picker) setPicker(null);
                  else openPicker(null, "", "header");
                }}
                onAddActive={() => onScopeChange({ ...scope, [activePanel]: "write" })}
              />
            )}
            <button type="button" className="ai-dock-new" onClick={onNewConversation} disabled={busy}>
              <MessageSquarePlus size={14} aria-hidden="true" />新对话
            </button>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} disabled={busy} aria-label="收起" title="收起">
              <X size={15} />
            </button>
            {picker?.anchor === "header" && pickerMenu}
          </header>
          <div className="ai-dock-body">
            <ConversationView key={conversation?.id} messages={messages} onResolve={resolve} />
            {busy && <div className="ai-thinking"><LoaderCircle size={14} className="spin" aria-hidden="true" />思考中…</div>}
            {stopped && !busy && <div className="ai-thinking">已停止。可以补充说明后再发一次。</div>}
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div ref={bodyEnd} />
          </div>
        </section>
      )}
      <form className="ai-dock-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {picker?.anchor === "composer" && pickerMenu}
        <div className={`ai-dock-field ${stacked && isNew ? "is-stacked" : ""}`}>
          {isNew && (
            <div className="ai-dock-pills" ref={pillsRef}>
              {pills.map((panel) => (
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
          )}
          {hasApiKey ? (
            <textarea
              ref={input}
              className="ai-dock-input"
              rows={1}
              value={draft}
              style={isNew ? flowStyle : undefined}
              placeholder={!isNew ? "继续对话…" : pills.length > 1 ? "问 AI…（@ 选择 panel）" : `问 AI，或让它帮你改${AI_PANELS[activePanel].name}…（@ 选择 panel）`}
              aria-label="给 AI 助手发消息"
              onChange={(event) => updateDraft(event.target.value, event.target.selectionStart ?? event.target.value.length)}
              onKeyDown={handleKeyDown}
              onBlur={() => setPicker(null)}
            />
          ) : (
            <button type="button" className="ai-dock-setup" style={isNew ? flowStyle : undefined} onClick={onOpenSettings}>先在 Settings 里保存 API key，才能使用 AI 助手</button>
          )}
        </div>
        {isNew && (
          <button
            type="button"
            className="icon-button ai-dock-at"
            disabled={!hasApiKey}
            aria-label="选择 AI 可以访问的 panel"
            title="选择 AI 可以访问的 panel"
            onMouseDown={(event) => {
              event.preventDefault();
              input.current?.focus();
              if (picker) setPicker(null);
              else openPicker(null, "");
            }}
          >
            <AtSign size={16} />
          </button>
        )}
        {!isNew && !showCard && (
          <button type="button" className="icon-button ai-dock-expand" onClick={() => setOpen(true)} aria-label="展开对话" title={`展开「${conversation?.title ?? "对话"}」`}>
            <ChevronUp size={17} />
          </button>
        )}
        {busy ? (
          <button type="button" className="primary-button ai-dock-send" onClick={onStop} aria-label="停止" title="停止">
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="primary-button ai-dock-send" disabled={!hasApiKey || !draft.trim()} aria-label="发送">
            <Send size={15} />
          </button>
        )}
      </form>
    </div>
  );
}
