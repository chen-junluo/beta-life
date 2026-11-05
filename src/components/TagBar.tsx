import { useEffect, useRef, useState } from "react";
import { TAG_ICON_CHOICES, tagIcon } from "../tagIcons";

interface TagBarProps {
  usage: Array<{ tag: string; count: number }>;
  tagIcons: Record<string, string>;
  pinned: string[];
  pinnedHabitCount: number;
  viewMode: string;
  onPreview: (tag: string | null) => void;
  onToggle: (tag: string) => void;
  onClear: () => void;
  onIconChange: (tag: string, icon: string) => void;
}

export function TagBar({
  usage,
  tagIcons,
  pinned,
  pinnedHabitCount,
  viewMode,
  onPreview,
  onToggle,
  onClear,
  onIconChange,
}: TagBarProps) {
  const [editing, setEditing] = useState(false);
  const [pickerTag, setPickerTag] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      if (pickerTag) setPickerTag(null);
      else if (editing) setEditing(false);
      else if (pinned.length > 0) onClear();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (pickerTag && !barRef.current?.contains(event.target as Node)) setPickerTag(null);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [editing, onClear, pickerTag, pinned.length]);

  if (usage.length === 0) return null;

  const status = editing
    ? "点击 tag 选择 icon"
    : pinned.length > 0
      ? `已聚焦 ${pinned.length} 个 tag · ${pinnedHabitCount} 个习惯 · Esc 退出`
      : "悬停预览 · 点击聚焦，可多选";

  function chooseIcon(tag: string, icon: string) {
    onIconChange(tag, icon);
    setPickerTag(null);
  }

  return (
    <div ref={barRef} className={`tag-bar ${editing ? "is-editing" : ""}`} data-view-mode={viewMode} role="toolbar" aria-label="Tags">
      <span className="tag-bar-label">TAGS</span>
      {usage.map(({ tag, count }) => {
        const icon = tagIcon(tagIcons, tag);
        const on = pinned.includes(tag);
        return (
          <span className="tag-pill-wrap" key={tag}>
            <button
              type="button"
              className={`tag-pill ${on && !editing ? "is-on" : ""}`}
              title={editing ? `为「${tag}」选择 icon` : tag}
              aria-pressed={editing ? undefined : on}
              aria-haspopup={editing ? "listbox" : undefined}
              aria-expanded={editing ? pickerTag === tag : undefined}
              onMouseEnter={() => !editing && onPreview(tag)}
              onMouseLeave={() => onPreview(null)}
              onClick={() => editing ? setPickerTag((current) => current === tag ? null : tag) : onToggle(tag)}
            >
              <span className={`tag-icon ${icon ? "" : "is-empty"}`} aria-hidden="true">{icon || "#"}</span>
              <span className="tag-pill-name">{tag}</span>
              <small>{count}</small>
            </button>
            {pickerTag === tag && (
              <div className="settings-select-menu tag-icon-menu" role="listbox" aria-label={`为「${tag}」选择 icon`}>
                <div className="tag-icon-menu-title">为「{tag}」选择 icon</div>
                <div className="tag-icon-grid">
                  {TAG_ICON_CHOICES.map((choice) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={choice === icon}
                      className={choice === icon ? "is-selected" : ""}
                      key={choice}
                      onClick={() => chooseIcon(tag, choice)}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={icon === ""}
                  className={`settings-select-option ${icon === "" ? "is-selected" : ""}`}
                  onClick={() => chooseIcon(tag, "")}
                >
                  无 icon（显示 #）
                </button>
              </div>
            )}
          </span>
        );
      })}
      <span className="tag-bar-status">{status}</span>
      {pinned.length > 0 && !editing && (
        <button type="button" className="tag-bar-action" onClick={onClear}>清除</button>
      )}
      <button
        type="button"
        className="tag-bar-action"
        onClick={() => {
          setEditing((current) => !current);
          setPickerTag(null);
          onPreview(null);
        }}
      >
        {editing ? "完成" : "编辑 icon"}
      </button>
    </div>
  );
}
