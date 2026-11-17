import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export function SettingsSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  label: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const triggerBounds = rootRef.current.getBoundingClientRect();
    const scrollBounds = rootRef.current.closest(".settings-content")?.getBoundingClientRect();
    const lowerBoundary = Math.min(window.innerHeight, scrollBounds?.bottom ?? window.innerHeight);
    const spaceBelow = lowerBoundary - triggerBounds.bottom;
    setDropUp(spaceBelow < 238 && triggerBounds.top > spaceBelow);
  }, [open]);

  function moveSelection(direction: 1 | -1) {
    const nextIndex = (selectedIndex + direction + options.length) % options.length;
    onChange(options[nextIndex].value);
    setOpen(true);
  }

  return (
    <div
      className={`settings-select ${open ? "is-open" : ""} ${dropUp ? "opens-up" : ""}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>(".settings-select-trigger")?.focus();
        }
      }}
    >
      <button
        type="button"
        className="settings-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            onChange(options[event.key === "Home" ? 0 : options.length - 1].value);
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="settings-select-menu" id={listboxId} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`settings-select-option ${option.value === value ? "is-selected" : ""}`}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
