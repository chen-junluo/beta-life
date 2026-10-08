import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Plus, Redo2, Settings, Sparkles, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { containerForPlacement, reindexItems } from "./boardLogic";
import { AiPanel } from "./components/AiPanel";
import { BoardView } from "./components/BoardView";
import { HabitEditor } from "./components/HabitEditor";
import { RecallView } from "./components/RecallView";
import { SettingsPanel } from "./components/SettingsPanel";
import { WorkspaceDrawer, type WorkspaceSection } from "./components/WorkspaceDrawer";
import { DEFAULT_BOARD, DEFAULT_SETTINGS } from "./defaults";
import type {
  AiProposalItem,
  AppSettings,
  BoardViewMode,
  BoardFile,
  ContainerId,
  Habit,
  LoadedAppState,
  PeriodId,
} from "./types";

type SaveState = "saved" | "saving" | "error";

const PROTOTYPE_PERIOD_COLORS: Record<PeriodId, { legacy: string; current: string }> = {
  morning: { legacy: "#F2C879", current: "#F59E0B" },
  noon: { legacy: "#A8D8C8", current: "#10B981" },
  evening: { legacy: "#AEBFE3", current: "#6366F1" },
  sleep: { legacy: "#B9BCC4", current: "#64748B" },
};

function withPrototypePalette(settings: AppSettings): AppSettings {
  let changed = false;
  const periods = settings.periods.map((period) => {
    const palette = PROTOTYPE_PERIOD_COLORS[period.id];
    if (period.color.toUpperCase() !== palette.legacy) return period;
    changed = true;
    return { ...period, color: palette.current };
  });
  return changed ? { ...settings, periods } : settings;
}

function activeItems(boardFile: BoardFile): Habit[] {
  return boardFile.boards.find((board) => board.id === boardFile.activeBoardId)?.items ?? [];
}

function withActiveItems(boardFile: BoardFile, items: Habit[]): BoardFile {
  return {
    ...boardFile,
    boards: boardFile.boards.map((board) =>
      board.id === boardFile.activeBoardId ? { ...board, items: reindexItems(items) } : board,
    ),
  };
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "出现了未知错误";
}

async function applyZoom(percent: number) {
  const bounded = Math.min(150, Math.max(50, percent));
  if (window.__TAURI_INTERNALS__) {
    await getCurrentWebview().setZoom(bounded / 100);
  }
}

export default function App() {
  const [state, setState] = useState<LoadedAppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [editorHabit, setEditorHabit] = useState<Habit | null>(null);
  const [editorContainer, setEditorContainer] = useState<ContainerId | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [viewMode, setViewMode] = useState<BoardViewMode>("global");
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("board");
  const [showWorkspaceDrawer, setShowWorkspaceDrawer] = useState(false);
  const [undoStack, setUndoStack] = useState<BoardFile[]>([]);
  const [redoStack, setRedoStack] = useState<BoardFile[]>([]);
  const workspaceDrawerTrigger = useRef<HTMLButtonElement>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef<LoadedAppState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let active = true;
    invoke<LoadedAppState>("load_app_state")
      .then((loaded) => {
        if (active) {
          const settings = withPrototypePalette(loaded.settings);
          const normalized = settings === loaded.settings ? loaded : { ...loaded, settings };
          setState(normalized);
          void applyZoom(settings.appearance.zoomPercent);
          if (settings !== loaded.settings) {
            void invoke("save_settings", { settings }).catch((error) => console.error(error));
          }
        }
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(errorMessage(error));
        if (!window.__TAURI_INTERNALS__) {
          setState({ board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, hasApiKey: false });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const queueBoardSave = useCallback((board: BoardFile) => {
    setSaveState("saving");
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => invoke("save_board", { board }))
      .then(() => setSaveState("saved"))
      .catch((error) => {
        console.error(error);
        setSaveState("error");
      });
  }, []);

  const queueSettingsSave = useCallback((settings: AppSettings) => {
    const pending = settingsSaveQueue.current
      .catch(() => undefined)
      .then(() => invoke<void>("save_settings", { settings }));
    settingsSaveQueue.current = pending;
    return pending;
  }, []);

  const commitBoard = useCallback(
    (board: BoardFile, recordHistory = true) => {
      const previous = stateRef.current?.board;
      if (recordHistory && previous) {
        setUndoStack((current) => [...current.slice(-49), previous]);
        setRedoStack([]);
      }
      setState((current) => (current ? { ...current, board } : current));
      queueBoardSave(board);
    },
    [queueBoardSave],
  );

  function updateItems(items: Habit[]) {
    if (!state) return;
    commitBoard(withActiveItems(state.board, items));
  }

  function openCreate(container: ContainerId = "period:morning") {
    setEditorHabit(null);
    setEditorContainer(container);
    setShowEditor(true);
  }

  function openEdit(habit: Habit) {
    setEditorHabit(habit);
    setEditorContainer(null);
    setShowEditor(true);
  }

  function saveHabit(habit: Habit) {
    if (!state) return;
    const items = activeItems(state.board);
    const existing = items.find((item) => item.id === habit.id);
    let next: Habit[];

    if (!existing) {
      const target = containerForPlacement(habit.placement);
      next = [
        { ...habit, order: 0 },
        ...items.map((item) =>
          containerForPlacement(item.placement) === target ? { ...item, order: item.order + 1 } : item,
        ),
      ];
    } else {
      const source = containerForPlacement(existing.placement);
      const target = containerForPlacement(habit.placement);
      next = items.map((item) => (item.id === habit.id ? habit : item));
      if (source !== target) {
        next = next.map((item) => {
          if (item.id === habit.id) return { ...item, order: 0 };
          if (containerForPlacement(item.placement) === target) return { ...item, order: item.order + 1 };
          return item;
        });
      }
    }
    updateItems(next);
    setShowEditor(false);
  }

  function deleteHabit(id: string) {
    if (!state) return;
    updateItems(activeItems(state.board).filter((item) => item.id !== id));
    setShowEditor(false);
  }

  function importAiItems(proposals: AiProposalItem[]) {
    if (!state) return;
    const current = activeItems(state.board);
    const counts = new Map<ContainerId, number>();
    const positions = new Map<ContainerId, number>();

    proposals.forEach((proposal) => {
      const container = proposal.placement.kind === "hour"
        ? (`hour:${proposal.placement.hour ?? 9}` as ContainerId)
        : (`period:${proposal.placement.period ?? "morning"}` as ContainerId);
      counts.set(container, (counts.get(container) ?? 0) + 1);
    });

    const shifted = current.map((item) => {
      const count = counts.get(containerForPlacement(item.placement)) ?? 0;
      return count ? { ...item, order: item.order + count } : item;
    });
    const now = new Date().toISOString();
    const imported = proposals.map((proposal): Habit => {
      const placement = proposal.placement.kind === "hour"
        ? { kind: "hour" as const, hour: proposal.placement.hour ?? 9 }
        : { kind: "period" as const, period: (proposal.placement.period ?? "morning") as PeriodId };
      const container = containerForPlacement(placement);
      const order = positions.get(container) ?? 0;
      positions.set(container, order + 1);
      return {
        id: crypto.randomUUID(),
        title: proposal.title.trim(),
        description: proposal.reason?.trim() ?? "",
        tags: proposal.tags?.trim() ?? "",
        placement,
        order,
        sourceExcerpt: proposal.sourceExcerpt?.trim(),
        createdAt: now,
        updatedAt: now,
      };
    });
    updateItems([...imported, ...shifted]);
  }

  function undo() {
    if (!state || undoStack.length === 0) return;
    const previous = undoStack.at(-1)!;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, state.board]);
    commitBoard(previous, false);
  }

  function redo() {
    if (!state || redoStack.length === 0) return;
    const next = redoStack.at(-1)!;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, state.board]);
    commitBoard(next, false);
  }

  function updateZoomByKeyboard(nextPercent: number) {
    const current = stateRef.current;
    if (!current) return;
    const bounded = Math.min(150, Math.max(50, nextPercent));
    const settings = {
      ...current.settings,
      appearance: { ...current.settings.appearance, zoomPercent: bounded },
    };
    const nextState = { ...current, settings };
    stateRef.current = nextState;
    setState(nextState);
    void applyZoom(bounded);
    void queueSettingsSave(settings).catch((error) => console.error(error));
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (!typing && activeSection === "board" && event.key.toLowerCase() === "n" && !showEditor && !showAi && !showSettings) {
        event.preventDefault();
        openCreate();
      }
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (
        !typing &&
        activeSection === "board" &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !showEditor &&
        !showAi &&
        !showSettings
      ) {
        event.preventDefault();
        setShowAi(true);
      }
      if (!typing && event.altKey && ["+", "=", "-", "_", "0"].includes(event.key)) {
        event.preventDefault();
        const currentZoom = stateRef.current?.settings.appearance.zoomPercent ?? 100;
        if (event.key === "0") updateZoomByKeyboard(100);
        else if (event.key === "+" || event.key === "=") updateZoomByKeyboard(currentZoom + 10);
        else updateZoomByKeyboard(currentZoom - 10);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeSection, showEditor, showAi, showSettings]);

  async function saveSettings(settings: AppSettings, apiKey?: string) {
    await queueSettingsSave(settings);
    if (apiKey) await invoke("save_api_key", { apiKey });
    await applyZoom(settings.appearance.zoomPercent);
    setState((current) => current ? { ...current, settings, hasApiKey: current.hasApiKey || Boolean(apiKey) } : current);
  }

  function savePeriodSlogan(periodId: PeriodId, slogan: string) {
    const current = stateRef.current;
    if (!current) return;
    const settings = {
      ...current.settings,
      periods: current.settings.periods.map((period) =>
        period.id === periodId ? { ...period, slogan } : period,
      ),
    };
    const nextState = { ...current, settings };
    stateRef.current = nextState;
    setState(nextState);
    void queueSettingsSave(settings).catch((error) => console.error(error));
  }

  if (!state) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">β</div>
        <p>{loadError ? `无法载入应用：${loadError}` : "正在准备你的生活时间板…"}</p>
      </main>
    );
  }

  const board = state.board.boards.find((item) => item.id === state.board.activeBoardId) ?? state.board.boards[0];
  const count = board?.items.length ?? 0;
  const viewModes: Array<{ id: BoardViewMode; label: string }> = [
    { id: "global", label: "全局模式" },
    ...state.settings.periods.map((period) => ({
      id: period.id,
      label: period.id === "noon" && period.label === "中午" ? "下午" : period.label,
    })),
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-area">
          <button
            ref={workspaceDrawerTrigger}
            type="button"
            className="beta-menu-button"
            aria-label={showWorkspaceDrawer ? "关闭面板导航" : "打开面板导航"}
            aria-expanded={showWorkspaceDrawer}
            aria-controls="workspace-drawer"
            onClick={() => setShowWorkspaceDrawer((open) => !open)}
          >
            <span aria-hidden="true">β</span>
          </button>
          <div className="brand-lockup">
            <div className="brand-copy">
              <h1>Beta Life</h1>
              <span>{activeSection === "board" ? `${board?.name ?? "My Life"} · ${count} 个习惯` : "Recall Space · 本地知识"}</span>
            </div>
          </div>
        </div>

        <div className="topbar-actions">
          {activeSection === "board" && <>
            <div className="history-actions">
              <button className="icon-button" onClick={undo} disabled={undoStack.length === 0} title="撤销 ⌘Z"><Undo2 size={18} /></button>
              <button className="icon-button" onClick={redo} disabled={redoStack.length === 0} title="重做 ⇧⌘Z"><Redo2 size={18} /></button>
            </div>
            <span className={`save-state ${saveState}`}>
              {saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}
            </span>
            <button className="secondary-button" onClick={() => setShowAi(true)}>
              <Sparkles size={16} /> AI 提取 <kbd>⌘K</kbd>
            </button>
            <button className="primary-button" onClick={() => openCreate()}>
              <Plus size={16} /> 新习惯 <kbd>N</kbd>
            </button>
          </>}
          <button className="icon-button settings-button" onClick={() => setShowSettings(true)} aria-label="设置"><Settings size={19} /></button>
        </div>
      </header>

      <WorkspaceDrawer
        activeSection={activeSection}
        open={showWorkspaceDrawer}
        onOpenChange={setShowWorkspaceDrawer}
        onSectionChange={setActiveSection}
        triggerRef={workspaceDrawerTrigger}
      />

      {activeSection === "recall" ? <RecallView settings={state.settings} hasApiKey={state.hasApiKey} onOpenSettings={() => setShowSettings(true)} /> : <main className="workspace-scroll">
        <div className="board-intro">
          <div><span className="eyebrow">LIFE TEMPLATE</span><h2>一天，不必精确到每一分钟。</h2></div>
          <nav className="view-mode-switch" aria-label="时间板视图模式">
            {viewModes.map((mode) => (
              <button
                type="button"
                key={mode.id}
                className={viewMode === mode.id ? "active" : ""}
                aria-pressed={viewMode === mode.id}
                onClick={() => setViewMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </nav>
          <p>先把习惯放进大致时段；需要时再拖到具体小时。拖动卡片左侧把手即可重新安排。</p>
        </div>

        <BoardView
          items={board?.items ?? []}
          settings={state.settings}
          viewMode={viewMode}
          onItemsChange={updateItems}
          onCreate={openCreate}
          onEdit={openEdit}
          onSloganChange={savePeriodSlogan}
        />
      </main>}

      {loadError && !window.__TAURI_INTERNALS__ && (
        <div className="browser-warning">当前是浏览器预览模式；数据不会写入本地文件。请使用 <code>npm run tauri dev</code> 测试桌面能力。</div>
      )}

      {showEditor && (
        <HabitEditor
          key={editorHabit?.id ?? editorContainer ?? "new"}
          habit={editorHabit}
          initialContainer={editorContainer}
          settings={state.settings}
          onClose={() => setShowEditor(false)}
          onSave={saveHabit}
          onDelete={deleteHabit}
        />
      )}

      {showAi && (
        <AiPanel
          settings={state.settings}
          hasApiKey={state.hasApiKey}
          onClose={() => setShowAi(false)}
          onOpenSettings={() => { setShowAi(false); setShowSettings(true); }}
          onImport={importAiItems}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={state.settings}
          hasApiKey={state.hasApiKey}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          onApiKeyCleared={() => setState((current) => current ? { ...current, hasApiKey: false } : current)}
          onBoardImported={(imported) => commitBoard(imported)}
        />
      )}
    </div>
  );
}
