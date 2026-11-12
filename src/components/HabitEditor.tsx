import { Check, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { splitTags } from "../simpleMarkdown";
import { obstacleText } from "../habitLogic";
import type { AppSettings, ContainerId, Habit, HabitObstacle, PeriodId, PeriodSetting, Placement } from "../types";
import { ChipPopover, TagChips, TimeChip } from "./ChipFields";
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
  const [obstacles, setObstacles] = useState<HabitObstacle[]>(habit?.obstacles ?? []);
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
      obstacles: obstacles.map((obstacle) => ({ ...obstacle, text: obstacleText(obstacle.text) })).filter((obstacle) => obstacle.text),
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
        <form onSubmit={submit} className="title-sheet-form">
          <header className="sheet-header title-header">
            <div className="title-header-main">
              <span className="eyebrow">HABIT · {habit ? "编辑" : "新建"}</span>
              <MarkdownEditor
                className="sheet-title-input"
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

          <div className="sheet-form title-sheet-body">
            <div className="chip-row">
              <TimeChip placement={placement} settings={settings} onChange={setPlacement} />
              <TagChips tags={tags} knownTags={knownTags} settings={settings} onChange={setTags} />
              {(habit?.obstacles?.length ?? 0) > 0 && (
                <ChipPopover label={`阻挠原因 · ${obstacles.length}`} popoverLabel="阻挠习惯的原因" popoverClassName="obstacle-popover">
                  {() => (
                    <>
                      <span className="obstacle-popover-title">【阻挠习惯的原因】bebe 问来、AI 整理的；写错了直接改或删</span>
                      {obstacles.length === 0 && <p className="obstacle-popover-empty">都删掉了，保存后生效</p>}
                      <ul>
                        {obstacles.map((obstacle, index) => (
                          <li key={index}>
                            <time>{obstacle.date ? obstacle.date.slice(5) : "—"}</time>
                            <input
                              value={obstacle.text}
                              aria-label={`${obstacle.date || "无日期"} 的原因`}
                              onChange={(event) => setObstacles((list) => list.map((item, position) => (position === index ? { ...item, text: event.target.value } : item)))}
                            />
                            <button type="button" className="icon-button" aria-label={`删除 ${obstacle.date || ""} 的原因`} onClick={() => setObstacles((list) => list.filter((_, position) => position !== index))}>
                              <X size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </ChipPopover>
              )}
            </div>

            <MarkdownEditor
              className="sheet-main-editor"
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
