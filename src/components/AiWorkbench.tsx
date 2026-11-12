import { MessageSquarePlus, Search, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import tools from "../ai/tools.json";
import { pendingBatch } from "../ai/turn";
import type { AiBatch, AiPanelId, AiScope, Conversation, ConversationMessage, ConversationSummary } from "../ai/types";
import { AI_PANELS, DiffCard, PANEL_ORDER, PICKER_LABELS, PICKER_LEVELS, levelsFor, levelTitle, panelStyle, parseResult, traceLabel, type PickerAccess } from "./AiDock";

const TOOL_PANELS = new Map(tools.map((tool) => [tool.name, tool.panel as AiPanelId]));
const DAY = 24 * 60 * 60 * 1000;

interface AiWorkbenchProps {
  summaries: ConversationSummary[];
  conversation: Conversation | null;
  busy: boolean;
  scope: AiScope;
  onScopeChange: (scope: AiScope) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onResolveBatch: (batchId: string, selectedIds: string[] | null) => void;
  /** The conversation column: the dock in workbench layout. */
  children: ReactNode;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateGroup(iso: string, today: number): string {
  const day = startOfDay(new Date(iso));
  if (day >= today) return "今天";
  if (day >= today - DAY) return "昨天";
  if (day >= today - 6 * DAY) return "最近 7 天";
  return "更早";
}

function timeLabel(iso: string, today: number): string {
  const date = new Date(iso);
  if (startOfDay(date) >= today) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** What the AI read in this conversation, one line per read tool call, without repeats. */
export function readLog(messages: ConversationMessage[]): Array<{ panel: AiPanelId; label: string }> {
  const results = new Map(messages.flatMap((message) => (message.role === "tool" ? [[message.toolCallId, message.content] as const] : [])));
  const seen = new Set<string>();
  return messages.flatMap((message) => (message.role === "assistant" ? message.toolCalls : [])).flatMap((call) => {
    const panel = TOOL_PANELS.get(call.name);
    const result = parseResult(results.get(call.id));
    const label = panel && !call.error && !result.error ? traceLabel(call, result) : null;
    if (!panel || !label || seen.has(`${panel}:${label}`)) return [];
    seen.add(`${panel}:${label}`);
    return [{ panel, label }];
  });
}

function PanelTag({ panel }: { panel: AiPanelId }) {
  return <span className="ai-panel-tag" style={panelStyle(panel)}>{AI_PANELS[panel].name}</span>;
}

/** V7: conversation list, the shared conversation, and a side column for scope, pending changes and what was read. */
export function AiWorkbench({ summaries, conversation, busy, scope, onScopeChange, onOpen, onDelete, onNew, onResolveBatch, children }: AiWorkbenchProps) {
  const [query, setQuery] = useState("");
  const [panelFilter, setPanelFilter] = useState<AiPanelId | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const today = startOfDay(new Date());
  const needle = query.trim().toLowerCase();
  const visible = summaries.filter((entry) => (!panelFilter || entry.panel === panelFilter) && (!needle || entry.title.toLowerCase().includes(needle)));
  const groups = visible.reduce<Array<{ name: string; items: ConversationSummary[] }>>((list, entry) => {
    const name = dateGroup(entry.updatedAt, today);
    const group = list.find((item) => item.name === name);
    if (group) group.items.push(entry);
    else list.push({ name, items: [entry] });
    return list;
  }, []);
  const messages = conversation?.messages ?? [];
  const pending: AiBatch | null = pendingBatch(messages);
  const reads = readLog(messages);
  const started = messages.some((message) => message.role === "user");

  function setAccess(panel: AiPanelId, access: PickerAccess) {
    const next = { ...scope };
    if (access === "off") delete next[panel];
    else next[panel] = access;
    onScopeChange(next);
  }

  function remove(id: string) {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    onDelete(id);
  }

  return (
    <main className="ai-workbench">
      <aside className="ai-wb-list" aria-label="对话列表">
        <button type="button" className="primary-button ai-wb-new" onClick={onNew} disabled={busy}>
          <MessageSquarePlus size={15} aria-hidden="true" />新对话
        </button>
        <label className="ai-wb-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话标题" aria-label="搜索对话标题" />
        </label>
        <div className="ai-wb-filters" role="group" aria-label="按来源 panel 筛选">
          <button type="button" className={panelFilter === null ? "is-on" : ""} aria-pressed={panelFilter === null} onClick={() => setPanelFilter(null)}>全部</button>
          {PANEL_ORDER.map((panel) => (
            <button key={panel} type="button" style={panelStyle(panel)} className={panelFilter === panel ? "is-on" : ""} aria-pressed={panelFilter === panel} onClick={() => setPanelFilter(panelFilter === panel ? null : panel)}>
              {AI_PANELS[panel].name}
            </button>
          ))}
        </div>
        <div className="ai-wb-groups">
          {groups.length === 0 && <p className="ai-wb-empty">{summaries.length === 0 ? "还没有对话" : "没有符合条件的对话"}</p>}
          {groups.map((group) => (
            <section key={group.name} className="ai-wb-group">
              <h5>{group.name}</h5>
              {group.items.map((entry) => {
                const current = entry.id === conversation?.id;
                return (
                  <div key={entry.id} className={`ai-wb-item ${current ? "is-current" : ""}`} onMouseLeave={() => armed === entry.id && setArmed(null)}>
                    <button type="button" className="ai-wb-item-main" onClick={() => onOpen(entry.id)} disabled={busy && !current} aria-current={current ? "true" : undefined} title={entry.title}>
                      <span className="ai-wb-item-title">{entry.title}</span>
                      <small><PanelTag panel={entry.panel} />{timeLabel(entry.updatedAt, today)}</small>
                    </button>
                    <button
                      type="button"
                      className={`ai-wb-delete ${armed === entry.id ? "armed" : ""}`}
                      onClick={() => remove(entry.id)}
                      onBlur={() => armed === entry.id && setArmed(null)}
                      disabled={busy && current}
                      aria-label={armed === entry.id ? `再次点击确认删除「${entry.title}」` : `删除「${entry.title}」`}
                      title={armed === entry.id ? "再次点击确认删除" : "删除对话"}
                    >
                      <Trash2 size={13} aria-hidden="true" />{armed === entry.id && "确认删除"}
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </aside>

      <div className="ai-wb-main">{children}</div>

      <aside className="ai-wb-side" aria-label="对话详情">
        <section>
          <h5>权限{started && <small>下一条消息生效</small>}</h5>
          <div className="ai-wb-scope">
            {PANEL_ORDER.map((panel) => {
              const access = scope[panel] ?? "off";
              return (
                <div key={panel} className="ai-mention-row" style={panelStyle(panel)}>
                  <span className="ai-mention-name">{AI_PANELS[panel].name}</span>
                  <span className="ai-mention-seg" role="radiogroup" aria-label={`${AI_PANELS[panel].name}的权限`}>
                    {PICKER_LEVELS.map((level) => (
                      <button key={level} type="button" role="radio" aria-checked={access === level} className={access === level ? `is-on ${level}` : ""} disabled={busy || !levelsFor(panel).includes(level)} title={levelTitle(panel, level)} onClick={() => setAccess(panel, level)}>
                        {PICKER_LABELS[level]}
                      </button>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h5>待确认修改</h5>
          {pending ? <DiffCard key={pending.id} batch={pending} onResolve={onResolveBatch} /> : <p className="ai-wb-empty">没有待确认的修改</p>}
        </section>
        <section>
          <h5>本次读过的内容</h5>
          {reads.length === 0 ? <p className="ai-wb-empty">这段对话还没有读取任何内容</p> : (
            <ul className="ai-wb-reads">
              {reads.map((entry) => <li key={`${entry.panel}:${entry.label}`}><PanelTag panel={entry.panel} />{entry.label}</li>)}
            </ul>
          )}
        </section>
      </aside>
    </main>
  );
}
