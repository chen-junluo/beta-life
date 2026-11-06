import { Check, ChevronDown, Clock3, Plus, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hourLabel, hoursForPeriod, orderedPeriods, periodForHour } from "../boardLogic";
import { tagIcon } from "../tagIcons";
import type { AppSettings, PeriodId, Placement } from "../types";

/**
 * Open state for a chip popover: closes on outside clicks and on Escape (without closing the surrounding sheet),
 * and shifts left when it would overflow the chip row.
 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const listener = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture phase: sheets stop mousedown propagation before it would reach the document.
    document.addEventListener("mousedown", listener, true);
    return () => document.removeEventListener("mousedown", listener, true);
  }, [open]);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const row = popover?.closest(".chip-row");
    if (!popover || !row) return;
    const overflow = popover.getBoundingClientRect().right - row.getBoundingClientRect().right;
    if (overflow > 0) popover.style.left = `${-overflow}px`;
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };
  return { open, setOpen, ref, popoverRef, onKeyDown };
}

/** A property chip that opens a popover; `children` receives `close`. Empty values use the dashed `ghost` tone. */
export function ChipPopover({ label, icon, tone = "default", ariaLabel, popoverLabel, popoverClassName, rowAnchored, onOpen, children }: {
  label: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "tag" | "ghost";
  ariaLabel?: string;
  popoverLabel: string;
  popoverClassName?: string;
  /** Position against the whole chip row (for wide popovers) instead of the chip. */
  rowAnchored?: boolean;
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const popover = usePopover();
  return (
    <div className={`chip-anchor ${rowAnchored ? "is-row-anchored" : ""}`} ref={popover.ref} onKeyDown={popover.onKeyDown}>
      <button
        type="button"
        className={`field-chip ${tone !== "default" ? `is-${tone}` : ""} ${popover.open ? "is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!popover.open) onOpen?.();
          popover.setOpen(!popover.open);
        }}
      >
        {icon}
        {label}
        {tone === "default" && <ChevronDown size={13} className="field-chip-chevron" aria-hidden="true" />}
      </button>
      {popover.open && (
        <div className={`chip-popover ${popoverClassName ?? ""}`} role="dialog" aria-label={popoverLabel} ref={popover.popoverRef}>
          {children(() => popover.setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Habit time: period tabs, the whole period, or an hour inside it. */
export function TimeChip({ placement, settings, onChange }: {
  placement: Placement;
  settings: AppSettings;
  onChange: (placement: Placement) => void;
}) {
  const currentPeriod = placement.kind === "period" ? placement.period : periodForHour(placement.hour, settings.periods);
  const [viewPeriod, setViewPeriod] = useState<PeriodId>(currentPeriod);
  const period = settings.periods.find((item) => item.id === currentPeriod);
  const label = placement.kind === "hour" ? `${hourLabel(placement.hour)} · ${period?.label}` : `整个${period?.label}`;
  const viewHours = hoursForPeriod(viewPeriod, settings);
  const viewLabel = settings.periods.find((item) => item.id === viewPeriod)?.label;

  return (
    <ChipPopover
      label={label}
      icon={<Clock3 size={13} style={{ color: period?.color }} aria-hidden="true" />}
      ariaLabel={`时间：${label}`}
      popoverLabel="选择时间"
      popoverClassName="time-popover"
      rowAnchored
      onOpen={() => setViewPeriod(currentPeriod)}
    >
      {(close) => (
        <>
          <div className="period-tabs" role="tablist">
            {orderedPeriods(settings).map((item) => (
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
            className={`whole-period ${placement.kind === "period" && placement.period === viewPeriod ? "is-selected" : ""}`}
            onClick={() => { onChange({ kind: "period", period: viewPeriod }); close(); }}
          >
            整个{viewLabel}
            <small>{hourLabel(viewHours[0])}–{hourLabel((viewHours[viewHours.length - 1] + 1) % 24)} · 不定小时</small>
          </button>
          <div className="hour-grid">
            {viewHours.map((hour) => (
              <button
                type="button"
                key={hour}
                className={placement.kind === "hour" && placement.hour === hour ? "is-selected" : ""}
                onClick={() => { onChange({ kind: "hour", hour }); close(); }}
              >
                {hourLabel(hour)}
              </button>
            ))}
          </div>
        </>
      )}
    </ChipPopover>
  );
}

/** Tag chips plus a searchable multi-select popover that can also create tags. */
export function TagChips({ tags, knownTags, settings, onChange }: {
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

  function onSearchKeyDown(event: KeyboardEvent) {
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
    <div className="chip-anchor" ref={popover.ref} onKeyDown={popover.onKeyDown}>
      <div className="chip-group">
        {tags.map((tag) => (
          <button type="button" key={tag} className="field-chip is-tag" onClick={openPicker} aria-label={`Tag：${tag}，点击编辑`}>
            <span aria-hidden="true">{icon(tag)}</span>
            {tag}
          </button>
        ))}
        <button
          type="button"
          className="field-chip is-ghost"
          aria-haspopup="dialog"
          aria-expanded={popover.open}
          onClick={() => (popover.open ? popover.setOpen(false) : openPicker())}
        >
          <Plus size={13} aria-hidden="true" />
          {tags.length ? "Tag" : "添加 Tag"}
        </button>
      </div>
      {popover.open && (
        <div className="chip-popover tag-popover" role="dialog" aria-label="选择 Tags" ref={popover.popoverRef}>
          <label className="chip-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              role="combobox"
              aria-label="搜索或新建 tag"
              aria-expanded="true"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(-1);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="搜索或新建 tag"
            />
          </label>
          <div className="chip-options" role="listbox" aria-multiselectable="true" aria-label="Tags">
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
            {!canCreate && options.length === 0 && <p className="chip-empty">还没有 tag，输入名称后回车新建</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Popover body for a single text value; Enter closes. */
export function ChipTextInput({ value, onChange, close, placeholder, id, label, hint }: {
  value: string;
  onChange: (value: string) => void;
  close: () => void;
  placeholder?: string;
  id?: string;
  label: string;
  hint?: string;
}) {
  return (
    <label className="chip-text-field">
      <span>{label}</span>
      <input
        id={id}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            close();
          }
        }}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}
