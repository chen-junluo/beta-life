import { Bot, BrainCircuit, CalendarDays, ChartNoAxesGantt, NotebookPen, Sparkles, Sprout, X } from "lucide-react";
import { useCallback, useEffect, useRef, type RefObject } from "react";

export type WorkspaceSection = "board" | "recall" | "forest" | "memories" | "diary";
/** Full pages at the bottom of the drawer; they replace the panel until the user returns. */
export type WorkspacePage = "timeline" | "workbench";

interface WorkspaceDrawerProps {
  activeSection: WorkspaceSection;
  /** The full page showing, if any; `activeSection` is the panel it was opened from. */
  page: WorkspacePage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSectionChange: (section: WorkspaceSection) => void;
  onOpenPage: (page: WorkspacePage) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export function WorkspaceDrawer({
  activeSection,
  page,
  open,
  onOpenChange,
  onSectionChange,
  onOpenPage,
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

  const current = page === "workbench" ? "ai" : page ?? activeSection;

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
            className={`workspace-drawer-item ${current === "board" ? "active" : ""}`}
            data-section="board"
            aria-current={current === "board" ? "page" : undefined}
            onClick={() => selectSection("board")}
          >
            <CalendarDays size={18} aria-hidden="true" />
            <span>时间板</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${current === "recall" ? "active" : ""}`}
            data-section="recall"
            aria-current={current === "recall" ? "page" : undefined}
            onClick={() => selectSection("recall")}
          >
            <BrainCircuit size={18} aria-hidden="true" />
            <span>回想</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${current === "forest" ? "active" : ""}`}
            data-section="forest"
            aria-current={current === "forest" ? "page" : undefined}
            onClick={() => selectSection("forest")}
          >
            <Sprout size={18} aria-hidden="true" />
            <span>能力森林</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${current === "memories" ? "active" : ""}`}
            data-section="memories"
            aria-current={current === "memories" ? "page" : undefined}
            onClick={() => selectSection("memories")}
          >
            <Sparkles size={18} aria-hidden="true" />
            <span>记忆星云</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${current === "diary" ? "active" : ""}`}
            data-section="diary"
            aria-current={current === "diary" ? "page" : undefined}
            onClick={() => selectSection("diary")}
          >
            <NotebookPen size={18} aria-hidden="true" />
            <span>日记</span>
          </button>
        </nav>

        {/* Full pages sit at the bottom and stack upward: the AI workbench last, the timeline above it. */}
        <nav className="workspace-drawer-list workspace-drawer-pages" aria-label="页面">
          <button
            type="button"
            className={`workspace-drawer-item ${current === "timeline" ? "active" : ""}`}
            data-section="timeline"
            aria-current={current === "timeline" ? "page" : undefined}
            onClick={() => {
              onOpenPage("timeline");
              closeDrawer();
            }}
          >
            <ChartNoAxesGantt size={18} aria-hidden="true" />
            <span>时间轴</span>
          </button>
          <button
            type="button"
            className={`workspace-drawer-item ${current === "ai" ? "active" : ""}`}
            data-section="ai"
            aria-current={current === "ai" ? "page" : undefined}
            onClick={() => {
              onOpenPage("workbench");
              closeDrawer();
            }}
          >
            <Bot size={18} aria-hidden="true" />
            <span>AI 工作台</span>
          </button>
        </nav>

        <footer className="workspace-drawer-footer">
          <span>当前面板</span>
          <strong>{page === "workbench" ? "AI 工作台" : page === "timeline" ? "时间轴" : activeSection === "board" ? "时间板" : activeSection === "recall" ? "回想" : activeSection === "forest" ? "能力森林" : activeSection === "memories" ? "记忆星云" : "日记"}</strong>
        </footer>
      </aside>
    </>
  );
}
