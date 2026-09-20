import { Check, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hourLabel, periodForHour } from "../boardLogic";
import type { AppSettings, ContainerId, Habit, PeriodId, Placement } from "../types";

interface HabitEditorProps {
  habit: Habit | null;
  initialContainer: ContainerId | null;
  settings: AppSettings;
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

export function HabitEditor({
  habit,
  initialContainer,
  settings,
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
  const [tags, setTags] = useState(habit?.tags ?? "");
  const [kind, setKind] = useState<"period" | "hour">(initialPlacement.kind);
  const [period, setPeriod] = useState<PeriodId>(
    initialPlacement.kind === "period"
      ? initialPlacement.period
      : periodForHour(initialPlacement.hour, settings.periods),
  );
  const [hour, setHour] = useState(initialPlacement.kind === "hour" ? initialPlacement.hour : 9);
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
      tags: tags.trim(),
      placement: kind === "hour" ? { kind: "hour", hour } : { kind: "period", period },
      order: habit?.order ?? 0,
      sourceExcerpt: habit?.sourceExcerpt,
      createdAt: habit?.createdAt ?? now,
      updatedAt: now,
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="habit-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          <div>
            <span className="eyebrow">HABIT</span>
            <h2 id="habit-editor-title">{habit ? "编辑习惯" : "添加习惯"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={submit} className="sheet-form">
          <label>
            <span>习惯名称</span>
            <textarea
              className="habit-title-input"
              autoFocus
              rows={5}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={"例如：早餐后补充维生素\n\n也可以输入：\n- 第一步\n- 第二步"}
            />
          </label>

          <fieldset>
            <legend>时间精度</legend>
            <div className="segmented-control">
              <button type="button" className={kind === "period" ? "active" : ""} onClick={() => setKind("period")}>
                只定时段
              </button>
              <button type="button" className={kind === "hour" ? "active" : ""} onClick={() => setKind("hour")}>
                具体小时
              </button>
            </div>
          </fieldset>

          {kind === "period" ? (
            <label>
              <span>所属时段</span>
              <select value={period} onChange={(event) => setPeriod(event.target.value as PeriodId)}>
                {settings.periods.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              <span>具体小时</span>
              <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
                {Array.from({ length: 24 }, (_, value) => (
                  <option key={value} value={value}>
                    {hourLabel(value)} · {settings.periods.find((p) => p.id === periodForHour(value, settings.periods))?.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            <span>Tags</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="例如：健康, 每天, 低强度"
            />
          </label>

          <label>
            <span>备注</span>
            <textarea
              rows={6}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="可选：记录做法、条件或提醒"
            />
          </label>

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
        </form>
      </aside>
    </div>
  );
}
