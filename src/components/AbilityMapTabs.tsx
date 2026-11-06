import { Sprout, Trees } from "lucide-react";
import { useRef, useState } from "react";
import type { AbilityMapKind } from "../types";

interface AbilityMapTabsProps {
  maps: Array<{ kind: AbilityMapKind; name: string }>;
  active: AbilityMapKind;
  onSelect: (kind: AbilityMapKind) => void;
  onRename: (kind: AbilityMapKind, name: string) => void;
}

const MAP_ICONS = { vision: Trees, research: Sprout } as const;

/** Input width in `ch`; CJK glyphs are about two `ch` wide. */
function nameWidth(value: string): number {
  return Array.from(value).reduce((width, char) => width + (char.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);
}

/** Sheet tabs under the map: click switches maps, double-click renames in place. */
export function AbilityMapTabs({ maps, active, onSelect, onRename }: AbilityMapTabsProps) {
  const [editing, setEditing] = useState<AbilityMapKind | null>(null);
  const [draft, setDraft] = useState("");
  // Escape unmounts the input; some engines still fire blur on removal, so the cancel must survive it.
  const cancelled = useRef(false);

  function commit(kind: AbilityMapKind, previous: string) {
    const name = draft.trim();
    setEditing(null);
    if (cancelled.current) return;
    if (name && name !== previous) onRename(kind, name);
  }

  return (
    <div className="ability-map-tabs" role="tablist" aria-label="能力地图">
      {maps.map(({ kind, name }) => {
        const Icon = MAP_ICONS[kind];
        if (editing === kind) {
          return (
            <span key={kind} className="ability-map-tab is-active is-editing">
              <Icon size={13} aria-hidden="true" />
              <input
                className="ability-map-tab-input"
                aria-label="地图名称"
                value={draft}
                maxLength={40}
                style={{ width: `calc(${Math.max(nameWidth(draft), 4)}ch + 10px)` }}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commit(kind, name)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
                  if (event.key === "Escape") { cancelled.current = true; setEditing(null); }
                }}
              />
            </span>
          );
        }
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={kind === active}
            className={`ability-map-tab ${kind === active ? "is-active" : ""}`}
            title={`${name} · 双击重命名`}
            onClick={() => onSelect(kind)}
            onDoubleClick={() => { cancelled.current = false; setDraft(name); setEditing(kind); }}
          >
            <Icon size={13} aria-hidden="true" />
            <span>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
