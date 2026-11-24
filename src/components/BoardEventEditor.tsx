import { Bell, ExternalLink, Trash2, X } from "lucide-react";
import { ChipPopover, TagChips } from "./ChipFields";
import { MarkdownEditor } from "./MarkdownEditor";
import { canLink, md, projectOfTag, projectsOnEvent, type BoardEvent, type Project } from "../boardEvents";
import type { AppSettings } from "../types";

const DAYS = [1, 3, 7, 14, 30];

/** `提醒` chip: a bubble on the day, plus any number of days before. */
function RemindChip({ remind, onChange }: { remind: BoardEvent["remind"]; onChange: (remind: BoardEvent["remind"]) => void }) {
  const parts = [remind.onDay ? "当天" : null, ...remind.daysBefore.map((days) => `提前 ${days} 天`)].filter(Boolean);
  return (
    <ChipPopover
      label={parts.length ? parts.join(" · ") : "不提醒"}
      icon={<Bell size={13} aria-hidden="true" />}
      tone={parts.length ? "default" : "ghost"}
      popoverLabel="事项提醒"
    >
      {() => (
        <div className="ms-pick-fields">
          <label>
            <input type="checkbox" checked={remind.onDay} onChange={(event) => onChange({ ...remind, onDay: event.target.checked })} />
            当天提醒{remind.onDay ? "（有时间的 point 准点冒泡）" : ""}
          </label>
          <div className="ms-days-grid">
            {DAYS.map((days) => (
              <button
                key={days}
                type="button"
                className={remind.daysBefore.includes(days) ? "is-on" : ""}
                aria-pressed={remind.daysBefore.includes(days)}
                onClick={() => onChange({ ...remind, daysBefore: remind.daysBefore.includes(days) ? remind.daysBefore.filter((item) => item !== days) : [...remind.daysBefore, days].sort((a, b) => a - b) })}
              >
                {days} 天
              </button>
            ))}
          </div>
        </div>
      )}
    </ChipPopover>
  );
}

/**
 * One event in the right column: title, then chips (shape / tag / dates / chain / reminders), then the note.
 * The tag is a normal editable tag — a new personal item just starts at `个人事项/工作`.
 */
export function BoardEventEditor({ draft, isNew, events, projects, settings, knownTags, lookup, onPatch, onSave, onDelete, onCancel, onLookup }: {
  draft: BoardEvent;
  isNew: boolean;
  events: BoardEvent[];
  projects: Project[];
  settings: AppSettings;
  knownTags: string[];
  lookup: boolean;
  onPatch: (patch: Partial<BoardEvent>) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onLookup?: () => void;
}) {
  const span = draft.shape === "span";
  const previous = events.find((event) => event.next === draft.id);
  const onChain = projectsOnEvent(draft.id, events, projects);
  // 还没保存的新事项：只看它自己的 tag 是不是某个 project 的 tag
  const own = projectOfTag(draft.tags[0], projects);
  const owners = onChain.length ? onChain : own ? [own] : [];
  // 查官网 only makes sense on a venue row: a `分类/名称` tag that is not a project's.
  const venue = draft.tags[0]?.includes("/") && !own ? draft.tags[0] : null;
  const setShape = (shape: BoardEvent["shape"]) => onPatch(shape === "span" ? { shape, time: null } : { shape, end: null, endEst: false });

  return (
    <div className="ms-form">
      <div className="ms-eyebrow">事项 · {span ? "SPAN 截止→通知" : "POINT 单点"} · {isNew ? "新建" : "编辑"}</div>
      <input className="ms-title-input" value={draft.title} placeholder="事项名称，例如：ISR 投稿" aria-label="事项名称" onChange={(event) => onPatch({ title: event.target.value })} />

      <div className="chip-row" style={{ marginBottom: 0 }}>
        <span className="ms-seg" role="group" aria-label="形态">
          <button type="button" className={span ? "" : "is-on"} aria-pressed={!span} onClick={() => setShape("point")}>point</button>
          <button type="button" className={span ? "is-on" : ""} aria-pressed={span} onClick={() => setShape("span")}>span</button>
        </span>

        <TagChips tags={draft.tags} knownTags={knownTags} settings={settings} onChange={(tags) => onPatch({ tags })} />

        <ChipPopover label={`${span ? "截止" : "due"} ${md(draft.date, draft.dateEst)}`} ariaLabel="日期" popoverLabel="选择日期">
          {() => (
            <div className="ms-pick-fields">
              <label><input type="date" value={draft.date} onChange={(event) => event.target.value && onPatch({ date: event.target.value })} aria-label={span ? "截止日期" : "due 日期"} /></label>
              <label>
                <input type="checkbox" checked={draft.dateEst} onChange={(event) => onPatch({ dateEst: event.target.checked })} />
                EST（官方日期未公布，显示 ~）
              </label>
            </div>
          )}
        </ChipPopover>

        {span ? (
          <ChipPopover label={draft.end ? `通知 ${md(draft.end, draft.endEst)}` : "+ 通知日"} tone={draft.end ? "default" : "ghost"} ariaLabel="通知日期" popoverLabel="通知日期">
            {() => (
              <div className="ms-pick-fields">
                <label><input type="date" value={draft.end ?? ""} min={draft.date} onChange={(event) => onPatch({ end: event.target.value || null })} aria-label="通知日期" /></label>
                <label>
                  <input type="checkbox" checked={draft.endEst} disabled={!draft.end} onChange={(event) => onPatch({ endEst: event.target.checked })} />
                  EST（通知日未公布）
                </label>
                {draft.end && <button type="button" className="secondary-button" onClick={() => onPatch({ end: null, endEst: false })}>改成「通知未定」</button>}
              </div>
            )}
          </ChipPopover>
        ) : (
          <ChipPopover label={draft.time ?? "+ 时间"} tone={draft.time ? "default" : "ghost"} ariaLabel="时间" popoverLabel="时间">
            {() => (
              <div className="ms-pick-fields">
                <label><input type="time" value={draft.time ?? ""} onChange={(event) => onPatch({ time: event.target.value || null })} aria-label="时间" /></label>
                {draft.time && <button type="button" className="secondary-button" onClick={() => onPatch({ time: null })}>不设时间</button>}
              </div>
            )}
          </ChipPopover>
        )}

        {previous && <span className="field-chip is-ghost" title={`上一站：${previous.title}`}>← {previous.title}</span>}

        <label className="field-chip ms-chip-pick" title="下一站：chain 只能单向，会成环的选项置灰">
          下一站
          <select
            aria-label="下一站"
            value={draft.next ?? ""}
            onChange={(event) => onPatch({ next: event.target.value || null })}
          >
            <option value="">无</option>
            {[...events].sort((a, b) => a.date.localeCompare(b.date)).map((event) => (
              <option key={event.id} value={event.id} disabled={!canLink(draft.id, event.id, events)}>{event.title} · {md(event.date, event.dateEst)}</option>
            ))}
          </select>
        </label>

        {owners.map((project) => <span key={project.id} className="field-chip is-tag">{project.tag}</span>)}

        <RemindChip remind={draft.remind} onChange={(remind) => onPatch({ remind })} />
      </div>

      <p className="rule-help">tag 随时可改；个人事项默认 <code>个人事项/工作</code>，子类可选 生活 / 学习 / 关系 / 行政。带 tag 的 point 会进甘特，没有 tag 的只在月历；<code>tags[0]</code> 决定进哪一行。</p>

      <MarkdownEditor className="ms-note-editor" value={draft.note} onChange={(note) => onPatch({ note })} aria-label="事项备注" placeholder="备注：投稿要求、准备事项…支持 Markdown" rows={3} />

      <div className="ms-row-btns">
        {!isNew && <button type="button" className="danger-button" onClick={onDelete}><Trash2 size={14} /> 删除</button>}
        <span className="ms-right">
          {lookup && venue && <button type="button" className="secondary-button" onClick={onLookup}><ExternalLink size={14} /> bebe 查官网</button>}
          <button type="button" className="secondary-button" onClick={onCancel}><X size={14} /> 取消</button>
          <button type="button" className="primary-button" disabled={!draft.title.trim() || !draft.date} onClick={onSave}>保存</button>
        </span>
      </div>
    </div>
  );
}
