import { Check, ChevronDown, Clock3, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { hourLabel, hoursForPeriod, orderedPeriods, periodForHour } from "../boardLogic";
import { splitTags } from "../simpleMarkdown";
import { tagIcon } from "../tagIcons";
import type { AppSettings, ContainerId, Habit, PeriodId, PeriodSetting, Placement } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";

interface HabitEditorProps {
  habit: Habit | null;
  initialContainer: ContainerId | null;
  settings: AppSettings;
  knownTags: string[];
  onClose: () => void;
  onSave: (habit: Habit) => void;
  onDelete: (id: string) => void;
}

function placementFromContainer(container: ContainerId | null): Placement {
  if (!container) return { kind: "period", period: "morning" };
  const [kind, value] = container.split(":");
  return kind === "hour"
    ? { kind: "hour", hour: Number(value) }
    : { kind: "period", period: value as PeriodId };
}

/**
 * Sheet width that keeps the time popover's period tabs on one line, so renamed (longer) periods never wrap.
 * Estimated from the labels: ~11px per CJK character and ~7px per other character at the 11px tab font,
 * plus 30px tab chrome per tab and 80px for strip, popover and sheet padding. The CSS clamps it to 560–760px.
 */
function sheetWidthForPeriods(periods: PeriodSetting[]): number {
  const labelWidth = (label: string) => [...label].reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? 11 : 7), 0);
  return Math.ceil(periods.reduce((sum, period) => sum + labelWidth(period.label) + 30, 0) + 80);
}

/** Open state for a chip popover that closes on outside clicks and Escape (without closing the sheet). */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const listener = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture phase: the sheet stops mousedown propagation before it would reach the document.
    document.addEventListener("mousedown", listener, true);
    return () => document.removeEventListener("mousedown", listener, true);
  }, [open]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };
  return { open, setOpen, ref, onKeyDown };
}

function TimeChip({ placement, settings, onChange }: {
  placement: Placement;
  settings: AppSettings;
  onChange: (placement: Placement) => void;
}) {
  const popover = usePopover();
  const currentPeriod = placement.kind === "period" ? placement.period : periodForHour(placement.hour, settings.periods);
  const [viewPeriod, setViewPeriod] = useState<PeriodId>(currentPeriod);
  const periods = orderedPeriods(settings);
  const period = settings.periods.find((item) => item.id === currentPeriod);
  const label = placement.kind === "hour" ? `${hourLabel(placement.hour)} · ${period?.label}` : `整个${period?.label}`;
  const viewHours = hoursForPeriod(viewPeriod, settings);
  const viewLabel = settings.periods.find((item) => item.id === viewPeriod)?.label;

  function pick(next: Placement) {
    onChange(next);
    popover.setOpen(false);
  }

  return (
    <div className="habit-chip-anchor is-time" ref={popover.ref} onKeyDown={popover.onKeyDown}>
      <button
        type="button"
        className={`habit-chip ${popover.open ? "is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-label={`时间：${label}`}
        onClick={() => {
          setViewPeriod(currentPeriod);
          popover.setOpen(!popover.open);
        }}
      >
        <Clock3 size={13} style={{ color: period?.color }} aria-hidden="true" />
        {label}
        <ChevronDown size={13} className="habit-chip-chevron" aria-hidden="true" />
      </button>
      {popover.open && (
        <div className="habit-popover habit-time-popover" role="dialog" aria-label="选择时间">
          <div className="habit-period-tabs" role="tablist">
            {periods.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.id}
                aria-selected={item.id === viewPeriod}
                className={item.id === viewPeriod ? "active" : ""}
                onClick={() => setViewPeriod(item.id)}
              >
                <i style={{ background: item.color }} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`habit-whole-period ${placement.kind === "period" && placement.period === viewPeriod ? "is-selected" : ""}`}
            onClick={() => pick({ kind: "period", period: viewPeriod })}
          >
            整个{viewLabel}
            <small>
              {hourLabel(viewHours[0])}–{hourLabel((viewHours[viewHours.length - 1] + 1) % 24)} · 不定小时
            </small>
          </button>
          <div className="habit-hour-grid">
            {viewHours.map((hour) => (
              <button
                type="button"
                key={hour}
                className={placement.kind === "hour" && placement.hour === hour ? "is-selected" : ""}
                onClick={() => pick({ kind: "hour", hour })}
              >
                {hourLabel(hour)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TagChips({ tags, knownTags, settings, onChange }: {
  tags: string[];
  knownTags: string[];
  settings: AppSettings;
  onChange: (tags: string[]) => void;
}) {
  const popover = usePopover();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const needle = query.trim().replace(/^#+/, "");
  const options = [...new Set([...tags, ...knownTags])].filter((tag) => tag.toLowerCase().includes(needle.toLowerCase()));
  const canCreate = needle !== "" && !options.some((tag) => tag === needle);
  const icon = (tag: string) => tagIcon(settings.tagIcons, tag) || "#";

  function toggle(tag: string) {
    onChange(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag]);
  }

  function openPicker() {
    setQuery("");
    setHighlighted(-1);
    popover.setOpen(true);
  }

  function onSearchKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlighted >= 0 && options[highlighted]) toggle(options[highlighted]);
      else if (needle) {
        if (!tags.includes(needle)) onChange([...tags, needle]);
        setQuery("");
      }
    }
  }

  return (
    <div className="habit-chip-anchor" ref={popover.ref} onKeyDown={popover.onKeyDown}>
      <div className="habit-tag-chips">
        {tags.map((tag) => (
          <button type="button" key={tag} className="habit-chip is-tag" onClick={openPicker} aria-label={`Tag：${tag}，点击编辑`}>
            <span aria-hidden="true">{icon(tag)}</span>
            {tag}
          </button>
        ))}
        <button
          type="button"
          className="habit-chip is-ghost"
          aria-haspopup="dialog"
          aria-expanded={popover.open}
          onClick={() => (popover.open ? popover.setOpen(false) : openPicker())}
        >
          <Plus size={13} aria-hidden="true" />
          {tags.length ? "Tag" : "添加 Tag"}
        </button>
      </div>
      {popover.open && (
        <div className="habit-popover habit-tag-popover" role="dialog" aria-label="选择 Tags">
          <label className="habit-tag-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              role="combobox"
              aria-label="搜索或新建 tag"
              aria-expanded="true"
              aria-controls="habit-tag-options"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(-1);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="搜索或新建 tag"
            />
          </label>
          <div className="habit-tag-options" id="habit-tag-options" role="listbox" aria-multiselectable="true" aria-label="Tags">
            {canCreate && (
              <button type="button" className="settings-select-option" onClick={() => { onChange([...tags, needle]); setQuery(""); }}>
                <span><Plus size={12} aria-hidden="true" /> 新建「{needle}」</span>
              </button>
            )}
            {options.map((tag, index) => (
              <button
                type="button"
                role="option"
                key={tag}
                tabIndex={-1}
                aria-selected={tags.includes(tag)}
                className={`settings-select-option ${tags.includes(tag) ? "is-selected" : ""} ${index === highlighted ? "is-highlighted" : ""}`}
                onClick={() => toggle(tag)}
              >
                <span>{icon(tag)} {tag}</span>
                {tags.includes(tag) && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
            {!canCreate && options.length === 0 && <p className="habit-tag-empty">还没有 tag，输入名称后回车新建</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function HabitEditor({
  habit,
  initialContainer,
  settings,
  knownTags,
  onClose,
  onSave,
  onDelete,
}: HabitEditorProps) {
  const initialPlacement = useMemo(
    () => habit?.placement ?? placementFromContainer(initialContainer),
    [habit, initialContainer],
  );
  const [title, setTitle] = useState(habit?.title ?? "");
  const [description, setDescription] = useState(habit?.description ?? "");
  const [tags, setTags] = useState(() => splitTags(habit?.tags ?? ""));
  const [placement, setPlacement] = useState<Placement>(initialPlacement);
  const [deleteArmed, setDeleteArmed] = useState(false);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const now = new Date().toISOString();
    onSave({
      id: habit?.id ?? crypto.randomUUID(),
      title: trimmedTitle,
      description: description.trim(),
      tags: tags.join(", "),
      placement,
      order: habit?.order ?? 0,
      sourceExcerpt: habit?.sourceExcerpt,
      createdAt: habit?.createdAt ?? now,
      updatedAt: now,
      done: habit?.done,
    });
  }

  function deleteHabit() {
    if (!habit) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    onDelete(habit.id);
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <aside
        className="side-sheet habit-editor"
        style={{ "--habit-sheet-width": `${sheetWidthForPeriods(settings.periods)}px` } as React.CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label={habit ? "编辑习惯" : "添加习惯"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form onSubmit={submit} className="habit-editor-form">
          <header className="sheet-header habit-editor-header">
            <div className="habit-editor-heading">
              <span className="eyebrow">HABIT · {habit ? "编辑" : "新建"}</span>
              <MarkdownEditor
                className="habit-title-input"
                autoFocus
                value={title}
                onChange={setTitle}
                aria-label="习惯名称"
                placeholder="习惯名称，例如：早餐后补充维生素"
              />
            </div>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={20} />
            </button>
          </header>

          <div className="sheet-form habit-editor-body">
            <div className="habit-meta-row">
              <TimeChip placement={placement} settings={settings} onChange={setPlacement} />
              <TagChips tags={tags} knownTags={knownTags} settings={settings} onChange={setTags} />
            </div>

            <MarkdownEditor
              className="habit-notes-input"
              value={description}
              onChange={setDescription}
              aria-label="备注"
              placeholder="备注：记录做法、条件或提醒，支持 Markdown"
            />

            {habit?.sourceExcerpt && (
              <div className="source-note">
                <span>AI 提取依据</span>
                <p>{habit.sourceExcerpt}</p>
              </div>
            )}

            <div className="sheet-actions">
              {habit && (
                <button
                  type="button"
                  className={`danger-button ${deleteArmed ? "armed" : ""}`}
                  onClick={deleteHabit}
                  aria-label={deleteArmed ? `确认删除 ${habit.title}` : `删除 ${habit.title}`}
                >
                  <Trash2 size={16} /> {deleteArmed ? "再次点击确认删除" : "删除"}
                </button>
              )}
              <button type="submit" className="primary-button" disabled={!title.trim()}>
                <Check size={17} /> 保存
              </button>
            </div>
          </div>
        </form>
      </aside>
    </div>
  );
}
