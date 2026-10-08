import { BrainCircuit, CalendarDays, X } from "lucide-react";
import { useCallback, useEffect, useRef, type RefObject } from "react";

export type WorkspaceSection = "board" | "recall";

interface WorkspaceDrawerProps {
  activeSection: WorkspaceSection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSectionChange: (section: WorkspaceSection) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export function WorkspaceDrawer({
  activeSection,
  open,
  onOpenChange,
  onSectionChange,
  triggerRef,
}: WorkspaceDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeDrawer = useCallback(() => {
    onOpenChange(false);
    triggerRef.current?.focus();
  }, [onOpenChange, triggerRef]);

  useEffect(() => {
    if (!open) return;
    drawerRef.current
      ?.querySelector<HTMLButtonElement>(".workspace-drawer-item.active")
      ?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDrawer, open]);

  function selectSection(section: WorkspaceSection) {
    onSectionChange(section);
    closeDrawer();
  }

  return (
    <>
      <div
        className={`workspace-drawer-scrim ${open ? "is-open" : ""}`}
        aria-hidden="true"
        onClick={closeDrawer}
      />
      <aside
        ref={drawerRef}
        id="workspace-drawer"
        className={`workspace-drawer ${open ? "is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-drawer-title"
        aria-label="工作空间面板导航"
        aria-hidden={!open}
        inert={!open}
      >
        <header className="workspace-drawer-header">
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h2 id="workspace-drawer-title">选择面板</h2>
          </div>
          <button
            type="button"
            className="icon-button workspace-drawer-close"
            aria-label="关闭导航抽屉"
            onClick={closeDrawer}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <nav className="workspace-drawer-list" aria-label="面板">
          <button
            type="button"
            className={`workspace-drawer-item ${activeSection === "board" ? "active" : ""}`}
            aria-current={activeSection === "board" ? "page" : undefined}
            onClick={() => selectSection("board")}
          >
            <CalendarDays size={18} aria-hidden="true" />
            <span>时间板</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${activeSection === "recall" ? "active" : ""}`}
            aria-current={activeSection === "recall" ? "page" : undefined}
            onClick={() => selectSection("recall")}
          >
            <BrainCircuit size={18} aria-hidden="true" />
            <span>回想</span>
          </button>
        </nav>

        <footer className="workspace-drawer-footer">
          <span>当前面板</span>
          <strong>{activeSection === "board" ? "时间板" : "回想"}</strong>
        </footer>
      </aside>
    </>
  );
}
