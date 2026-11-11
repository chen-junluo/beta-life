import { Check } from "lucide-react";
import { CATEGORIES, categoryMeta, UNCLASSIFIED, type ActivityCategory } from "../activity";
import { ChipPopover } from "./ChipFields";

/** Focus / neutral / slack picker; `allowNone` adds 待分类 (removes the rule). */
export function CategoryChip({ category, name, allowNone = true, onChange }: {
  category: ActivityCategory | null;
  /** What is being classified, for the accessible label. */
  name: string;
  allowNone?: boolean;
  onChange: (category: ActivityCategory | null) => void;
}) {
  const meta = categoryMeta(category);
  const options: Array<{ id: ActivityCategory | null; label: string; color: string }> = allowNone ? [...CATEGORIES, { id: null, ...UNCLASSIFIED }] : CATEGORIES;
  return (
    <ChipPopover
      label={meta.label}
      icon={<i className="category-dot" style={{ background: meta.color }} aria-hidden="true" />}
      tone={category ? "default" : "ghost"}
      ariaLabel={`${name} 的分类：${meta.label}`}
      popoverLabel={`给 ${name} 分类`}
      popoverClassName="category-popover"
    >
      {(close) => (
        <div className="chip-options">
          {options.map((option) => (
            <button
              type="button"
              key={option.id ?? "none"}
              className={`settings-select-option ${option.id === category ? "is-selected" : ""}`}
              onClick={() => {
                if (option.id !== category) onChange(option.id);
                close();
              }}
            >
              <span className="category-option"><i className="category-dot" style={{ background: option.color }} aria-hidden="true" />{option.label}</span>
              {option.id === category && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </ChipPopover>
  );
}
