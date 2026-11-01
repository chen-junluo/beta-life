import { Pencil } from "lucide-react";
import { useRef, useState } from "react";

const PLACEHOLDER = "点击添加这个面板的 slogan";

interface TopbarSloganProps {
  value: string;
  onSave: (value: string) => void;
}

export function TopbarSlogan({ value, onSave }: TopbarSloganProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const finished = useRef(false);

  function startEditing() {
    finished.current = false;
    setDraft(value);
  }

  function finish(save: boolean) {
    if (finished.current || draft === null) return;
    finished.current = true;
    const next = draft.trim();
    setDraft(null);
    if (save && next !== value) onSave(next);
  }

  if (draft === null) {
    return (
      <button
        type="button"
        className={value ? "topbar-slogan" : "topbar-slogan is-empty"}
        title={value || undefined}
        aria-label={value ? `编辑 slogan：${value}` : PLACEHOLDER}
        onClick={startEditing}
      >
        <span className="topbar-slogan-text">{value || PLACEHOLDER}</span>
        <Pencil size={11} aria-hidden="true" />
      </button>
    );
  }

  return (
    <input
      className="topbar-slogan-input"
      value={draft}
      placeholder={PLACEHOLDER}
      aria-label="编辑 slogan"
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}
