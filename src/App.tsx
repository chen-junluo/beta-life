import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Plus, Quote, Redo2, Settings, Sparkles, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { containerForPlacement, hourLabel, orderedPeriods, reindexItems } from "./boardLogic";
import { collectTags } from "./simpleMarkdown";
import { assignTagIcons } from "./tagIcons";
import { AiDock } from "./components/AiDock";
import { AiWorkbench } from "./components/AiWorkbench";
import { TimelineView } from "./components/TimelineView";
import { DiaryView } from "./components/DiaryView";
import { appendDiarySummary, restoreDiarySnapshot, type DiarySnapshot } from "./diaryStorage";
import { dayCode } from "./diaryLogic";
import { addObstacles, habitRates, habitStatsText, isLowRate, RATE_DAYS, shiftDate, type HabitRate } from "./habitLogic";
import { localDateKey } from "./pet/reminders";
import { useAssistant } from "./ai/useAssistant";
import type { AiPanelId } from "./ai/types";
import { summaryDiaryEntry } from "./activity";
import { usePanelHistory } from "./history";
import { restoreKnowledgeBundle, type KnowledgeBundle } from "./recallStorage";
import { restoreMemorySnapshot, type MemorySnapshot } from "./memoryStorage";
import { BoardView } from "./components/BoardView";
import { HabitEditor } from "./components/HabitEditor";
import { RecallView } from "./components/RecallView";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopbarSlogan } from "./components/TopbarSlogan";
import { WorkspaceDrawer, type WorkspaceSection } from "./components/WorkspaceDrawer";
import { MemoriesView } from "./components/MemoriesView";
import { DEFAULT_ABILITY_FOREST, DEFAULT_ABILITY_MAP_NAMES, DEFAULT_BOARD, DEFAULT_RESEARCH_AGENDA, DEFAULT_SETTINGS, DEFAULT_TAB_SLOGANS } from "./defaults";
import { AbilityForestView } from "./components/AbilityForestView";
import { AbilityMapTabs } from "./components/AbilityMapTabs";
import {
  PET_BOARD,
  PET_CHAT,
  PET_CHAT_RESOLVE,
  PET_CHAT_SCOPE,
  PET_CHAT_SEND,
  PET_CHAT_STOP,
  PET_CHAT_UNDO,
  PET_DIARY_SCOPE,
  PET_HABIT_REASONS,
  PET_HABIT_SUGGEST,
  PET_SUGGEST_SCOPE,
  PET_OPEN_TIMELINE,
  PET_SUMMARY_DIARY,
  PET_DOCK_ARRIVED,
  PET_MARK_DONE,
  PET_READY,
  PET_SUMMON_DOCK,
  PET_USER_HIDDEN,
  petChatSnapshot,
  type HabitSuggestOffer,
  type PetBoardSnapshot,
  type PetChatResolve,
  type PetHabitReasons,
  type PetChatUndo,
  type PetChatSend,
  type PetMarkDone,
  type PetSummaryDiary,
} from "./pet/bridge";
import type {
  AbilityForest,
  AbilityMapKind,
  AppSettings,
  BoardViewMode,
  BoardFile,
  ContainerId,
  Habit,
  HabitRecord,
  LoadedAppState,
  PeriodId,
  VaultIssue,
} from "./types";

type SaveState = "saved" | "saving" | "error";

const ABILITY_MAP_STATE_KEYS = { vision: "abilityForest", research: "researchAgenda" } as const;
const ABILITY_MAP_KINDS: AbilityMapKind[] = ["vision", "research"];

const PROTOTYPE_PERIOD_COLORS: Record<PeriodId, { legacy: string; current: string }> = {
  morning: { legacy: "#F2C879", current: "#F59E0B" },
  noon: { legacy: "#A8D8C8", current: "#10B981" },
  evening: { legacy: "#AEBFE3", current: "#6366F1" },
  sleep: { legacy: "#B9BCC4", current: "#64748B" },
};

const SECTION_LABELS: Record<WorkspaceSection, string> = {
  board: "时间板",
  recall: "回想",
  forest: "能力森林",
  memories: "记忆星云",
  diary: "日记",
};

function withSettingDefaults(settings: AppSettings): AppSettings {
  return { ...settings, slogans: { ...DEFAULT_TAB_SLOGANS, ...settings.slogans }, diary: { ...DEFAULT_SETTINGS.diary, ...settings.diary }, pet: { ...DEFAULT_SETTINGS.pet, ...settings.pet } };
}

function shortPeriodLabel(period: AppSettings["periods"][number]): string {
  if (period.id === "noon" && period.label === "中午") return "下午";
  return period.label.replace(/[（(].*$/, "").trim() || period.label;
}

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

/** Typing in one node's name or note merges into one undo step; anything else is its own step. */
function forestEditKey(map: AbilityMapKind, previous: AbilityForest, next: AbilityForest): string | undefined {
  if (previous.nodes.length !== next.nodes.length) return undefined;
  const changed = next.nodes.filter((node, index) => node !== previous.nodes[index]);
  if (changed.length !== 1) return undefined;
  const before = previous.nodes.find((node) => node.id === changed[0].id);
  if (!before) return undefined;
  const fields = (["name", "markdown", "level", "parentId", "order", "color"] as const).filter((field) => before[field] !== changed[0][field]);
  return fields.length === 1 && (fields[0] === "name" || fields[0] === "markdown") ? `${map}:${before.id}:${fields[0]}` : undefined;
}

/** Habits with a low rate on the last archived day, until bebe has offered suggestions for them. */
const SUGGEST_STORAGE_KEY = "beta-life:habit-suggest";

function readSuggestOffer(): HabitSuggestOffer | null {
  try {
    return JSON.parse(localStorage.getItem(SUGGEST_STORAGE_KEY) ?? "null") as HabitSuggestOffer | null;
  } catch {
    return null;
  }
}

/** Local `YYYY-MM-DD` a habit was created; a habit without a readable time counts as old. */
function createdDay(habit: Habit): string {
  const created = new Date(habit.createdAt);
  return Number.isNaN(created.getTime()) ? "0000-00-00" : localDateKey(created);
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
  const [forestSaveState, setForestSaveState] = useState<SaveState>("saved");
  const [editorHabit, setEditorHabit] = useState<Habit | null>(null);
  const [editorContainer, setEditorContainer] = useState<ContainerId | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [lifeStagesRevision, setLifeStagesRevision] = useState(0);
  const [recallRevision, setRecallRevision] = useState(0);
  const [memoriesRevision, setMemoriesRevision] = useState(0);
  const [diaryRevision, setDiaryRevision] = useState(0);
  const [viewMode, setViewMode] = useState<BoardViewMode>("global");
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("board");
  const [activeAbilityMap, setActiveAbilityMap] = useState<AbilityMapKind>("vision");
  const [showWorkspaceDrawer, setShowWorkspaceDrawer] = useState(false);
  /** The AI workbench covers the panel area; `activeSection` stays the panel it was opened from. */
  /** Full pages from the drawer replace the panel; `activeSection` stays the panel to return to. */
  const [page, setPage] = useState<"panel" | "workbench" | "timeline">("panel");
  const showWorkbench = page === "workbench";
  const history = usePanelHistory();
  const recordHistory = history.record;
  const [topbarActions, setTopbarActions] = useState<HTMLDivElement | null>(null);
  const workspaceDrawerTrigger = useRef<HTMLButtonElement>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const abilityForestSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const abilityForestSaveTimers = useRef<Record<AbilityMapKind, number | null>>({ vision: null, research: null });
  const pendingAbilityForests = useRef<Record<AbilityMapKind, AbilityForest | null>>({ vision: null, research: null });
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef<LoadedAppState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const boardFile = state?.board;
  useEffect(() => {
    if (!boardFile) return;
    const tags = collectTags(activeItems(boardFile).map((item) => item.tags));
    saveTagIcons((tagIcons) => assignTagIcons(tagIcons, tags));
  }, [boardFile]);

  useEffect(() => {
    let active = true;
    invoke<LoadedAppState>("load_app_state")
      .then((loaded) => {
        if (active) {
          const settings = withPrototypePalette(loaded.settings);
          const normalized = { ...loaded, settings: withSettingDefaults(settings) };
          setState(normalized);
          pendingAbilityForests.current = { vision: null, research: null };
          setForestSaveState("saved");
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
          setState({ board: DEFAULT_BOARD, settings: DEFAULT_SETTINGS, abilityForest: DEFAULT_ABILITY_FOREST, researchAgenda: DEFAULT_RESEARCH_AGENDA, hasApiKey: false });
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

  const changeAbilityForest = useCallback((map: AbilityMapKind, abilityForest: AbilityForest, immediate = false, record = true) => {
    const current = stateRef.current;
    if (!current) return;
    const previous = current[ABILITY_MAP_STATE_KEYS[map]];
    // View-only changes (zoom, pan, selection) keep the same nodes and positions and are not undo steps.
    if (record && (previous.nodes !== abilityForest.nodes || previous.mapPositions !== abilityForest.mapPositions)) {
      recordHistory("forest", {
        before: { map, forest: previous },
        after: { map, forest: abilityForest },
        key: forestEditKey(map, previous, abilityForest),
        restore: ({ map: target, forest }) => {
          const latest = stateRef.current?.[ABILITY_MAP_STATE_KEYS[target]];
          changeAbilityForest(target, { ...forest, mapState: latest?.mapState ?? forest.mapState }, true, false);
          setActiveAbilityMap(target);
        },
      });
    }
    const nextState = { ...current, [ABILITY_MAP_STATE_KEYS[map]]: abilityForest };
    stateRef.current = nextState;
    setState(nextState);
    const pending = pendingAbilityForests.current;
    const timers = abilityForestSaveTimers.current;
    const hasPending = () => pending.vision !== null || pending.research !== null;
    pending[map] = abilityForest;
    setForestSaveState("saving");
    if (timers[map] !== null) {
      window.clearTimeout(timers[map]!);
      timers[map] = null;
    }
    const persist = () => {
      timers[map] = null;
      const forestToSave = pending[map];
      if (!forestToSave) return;
      pending[map] = null;
      abilityForestSaveQueue.current = abilityForestSaveQueue.current
        .catch(() => undefined)
        .then(() => invoke<void>("save_ability_forest", { map, abilityForest: forestToSave }))
        .then(() => {
          if (!hasPending()) setForestSaveState("saved");
        })
        .catch((error) => {
          console.error(error);
          if (!hasPending()) setForestSaveState("error");
        });
    };
    if (immediate) persist();
    else timers[map] = window.setTimeout(persist, 420);
  }, [recordHistory]);

  const changeActiveAbilityForest = useCallback(
    (abilityForest: AbilityForest, immediate?: boolean) => changeAbilityForest(activeAbilityMap, abilityForest, immediate),
    [activeAbilityMap, changeAbilityForest],
  );

  const renameAbilityMap = useCallback((map: AbilityMapKind, name: string) => {
    const forest = stateRef.current?.[ABILITY_MAP_STATE_KEYS[map]];
    if (forest) changeAbilityForest(map, { ...forest, name }, true);
  }, [changeAbilityForest]);

  const queueSettingsSave = useCallback((settings: AppSettings) => {
    const pending = settingsSaveQueue.current
      .catch(() => undefined)
      .then(() => invoke<void>("save_settings", { settings }));
    settingsSaveQueue.current = pending;
    return pending;
  }, []);

  const applyBoard = useCallback((board: BoardFile) => {
    const current = stateRef.current;
    if (!current) return;
    const nextState = { ...current, board };
    stateRef.current = nextState;
    setState(nextState);
    queueBoardSave(board);
  }, [queueBoardSave]);

  const commitBoard = useCallback(
    (board: BoardFile) => {
      const previous = stateRef.current?.board;
      if (previous) recordHistory("board", { before: previous, after: board, restore: applyBoard });
      applyBoard(board);
    },
    [applyBoard, recordHistory],
  );

  /** One undo step for any number of knowledge records; undo writes them back and reloads the view. */
  const recordRecall = useCallback((before: KnowledgeBundle[], after: KnowledgeBundle[]) => recordHistory("recall", {
    before,
    after,
    restore: async (bundles) => {
      for (const bundle of bundles) await restoreKnowledgeBundle(bundle);
      setRecallRevision((revision) => revision + 1);
    },
  }), [recordHistory]);

  const recordMemories = useCallback((before: MemorySnapshot[], after: MemorySnapshot[]) => recordHistory("memories", {
    before,
    after,
    restore: async (snapshots) => {
      for (const snapshot of snapshots) await restoreMemorySnapshot(snapshot);
      setMemoriesRevision((revision) => revision + 1);
    },
  }), [recordHistory]);

  /** Days written back by undo or redo; the diary view re-reads the month. */
  const recordDiary = useCallback((before: DiarySnapshot[], after: DiarySnapshot[], key?: string) => recordHistory("diary", {
    before,
    after,
    key,
    restore: async (snapshots) => {
      for (const snapshot of snapshots) await restoreDiarySnapshot(snapshot);
      setDiaryRevision((revision) => revision + 1);
    },
  }), [recordHistory]);

  /** Last 7 archived days per habit, shown on the cards. */
  const [habitRateMap, setHabitRateMap] = useState<Record<string, HabitRate>>({});
  const [suggestOffer, setSuggestOffer] = useState<HabitSuggestOffer | null>(readSuggestOffer);

  const refreshHabitRates = useCallback(async (today: string) => {
    const from = shiftDate(today, -RATE_DAYS);
    const to = shiftDate(today, -1);
    const records = await invoke<HabitRecord[]>("load_habit_history", { from, to });
    setHabitRateMap(habitRates(records, from, to));
  }, []);

  /**
   * 0:00 (or the first launch on a later day): Rust archives the day the checks belong to, the checks
   * are cleared (not an undo step), Beta Life writes the day's statistics under the diary's
   * 【AI总结】 line, and habits with a low rate wait for bebe to offer suggestions.
   */
  const rolledDay = useRef<string | null>(null);
  const rollHabitDay = useCallback(async () => {
    const current = stateRef.current;
    const today = localDateKey(new Date());
    if (!current || !window.__TAURI_INTERNALS__ || rolledDay.current === today) return;
    rolledDay.current = today;
    const items = activeItems(current.board);
    try {
      const habits = items.map((item) => ({ habitId: item.id, title: item.title, done: Boolean(item.done), created: createdDay(item) }));
      const rolled = await invoke<string | null>("roll_habit_day", { request: { today, boardId: current.board.activeBoardId, habits } });
      if (rolled) {
        const latest = stateRef.current ?? current;
        const latestItems = activeItems(latest.board);
        if (latestItems.some((item) => item.done)) applyBoard(withActiveItems(latest.board, latestItems.map((item) => (item.done ? { ...item, done: false } : item))));
        const from = shiftDate(rolled, -(RATE_DAYS - 1));
        const rates = habitRates(await invoke<HabitRecord[]>("load_habit_history", { from, to: rolled }), from, rolled);
        const dayHabits = items.filter((item) => createdDay(item) <= rolled);
        const { pet, periods, diary } = latest.settings;
        const text = habitStatsText(dayHabits, rates, pet.habitLowPercent, periods);
        const [year, month, date] = rolled.split("-").map(Number);
        const code = dayCode(new Date(year, month - 1, date));
        if (text && await appendDiarySummary(code, text, "- 习惯：", diary.template)) setDiaryRevision((revision) => revision + 1);
        const low = dayHabits.filter((item) => isLowRate(rates[item.id], pet.habitLowPercent));
        const offer = low.length > 0 ? { date: rolled, day: code, habits: low.map((item) => ({ id: item.id, title: item.title, ...rates[item.id] })) } : null;
        localStorage.setItem(SUGGEST_STORAGE_KEY, JSON.stringify(offer));
        setSuggestOffer(offer);
      }
      await refreshHabitRates(today);
    } catch (error) {
      console.error(error);
      rolledDay.current = null;
    }
  }, [applyBoard, refreshHabitRates]);

  const loaded = state !== null;
  useEffect(() => {
    if (!loaded) return;
    void rollHabitDay();
    const interval = window.setInterval(() => void rollHabitDay(), 60_000);
    return () => window.clearInterval(interval);
  }, [loaded, rollHabitDay]);

  /** bebe's 「为什么没完成呢？」: the AI files the answer under each habit, written at once (one undo step). */
  const recordHabitReasons = useCallback(async ({ date, habitIds, text }: PetHabitReasons) => {
    const current = stateRef.current;
    if (!current || !text.trim()) return;
    const habits = activeItems(current.board).filter((item) => habitIds.includes(item.id));
    if (habits.length === 0) return;
    let reasons: Array<{ habitId: string; text: string }> | null = null;
    if (current.hasApiKey) {
      reasons = await invoke<Array<{ habitId: string; text: string }>>("ai_habit_reasons", { request: { text, habits: habits.map((item) => ({ id: item.id, title: item.title })) } })
        .catch((error) => {
          console.error(error);
          return null;
        });
    }
    // Without the AI the answer is kept as typed, under every habit asked about.
    reasons ??= habits.map((item) => ({ habitId: item.id, text }));
    const latest = stateRef.current ?? current;
    commitBoard(withActiveItems(latest.board, addObstacles(activeItems(latest.board), date, reasons, new Date().toISOString())));
  }, [commitBoard]);

  const [dockFocus, setDockFocus] = useState(0);
  /** The panel the dock starts new conversations from: the timeline page counts as its own (read only). */
  const dockPanel: AiPanelId = page === "timeline" ? "timeline" : activeSection;
  const assistant = useAssistant({
    activePanel: dockPanel,
    getState: () => stateRef.current,
    commitBoard,
    commitForest: (map, forest) => changeAbilityForest(map, forest, true),
    // AI writes recall and memories on disk, so the views reload after recording the step.
    recordRecall: (before, after) => {
      recordRecall(before, after);
      setRecallRevision((revision) => revision + 1);
    },
    recordMemories: (before, after) => {
      recordMemories(before, after);
      setMemoriesRevision((revision) => revision + 1);
    },
    recordDiary: (before, after) => {
      recordDiary(before, after);
      setDiaryRevision((revision) => revision + 1);
    },
    // Confirmed in a diff card; Settings → bebe is where they are changed back.
    commitPetSettings: (pet) => {
      const current = stateRef.current;
      if (!current) return;
      const settings = { ...current.settings, pet };
      const nextState = { ...current, settings };
      stateRef.current = nextState;
      setState(nextState);
      void queueSettingsSave(settings).catch((error) => console.error(error));
    },
  });

  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;

  /** md files beta-life could not read; they are skipped and left untouched. */
  const [vaultIssues, setVaultIssues] = useState<VaultIssue[]>([]);
  const clearHistory = history.clear;
  // Files edited in Obsidian: reload the panels they belong to; their undo steps no longer apply.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    void invoke<VaultIssue[] | undefined>("vault_issues").then((list) => setVaultIssues(list ?? [])).catch(console.error);
    const unlisteners = [
      listen<VaultIssue[]>("vault-issues", ({ payload }) => setVaultIssues(payload)),
      listen<{ panels: string[] }>("vault-changed", ({ payload }) => {
        const panels = new Set(payload.panels);
        if (panels.has("board") || panels.has("forest")) {
          void invoke<LoadedAppState>("load_app_state").then((loaded) => {
            const current = stateRef.current;
            if (!current) return;
            const next = { ...current };
            if (panels.has("board")) {
              next.board = loaded.board;
              clearHistory("board");
            }
            if (panels.has("forest")) {
              for (const map of ["vision", "research"] as const) {
                // A queued save of the old forest would overwrite the edit.
                const timer = abilityForestSaveTimers.current[map];
                if (timer !== null) window.clearTimeout(timer);
                abilityForestSaveTimers.current[map] = null;
                pendingAbilityForests.current[map] = null;
                const key = ABILITY_MAP_STATE_KEYS[map];
                const view = current[key].mapState;
                const selected = view?.selectedId;
                // Keep zoom, pan and selection while the selected node still exists.
                const keepView = view && (!selected || loaded[key].nodes.some((node) => node.id === selected));
                next[key] = keepView ? { ...loaded[key], mapState: view } : loaded[key];
              }
              setForestSaveState("saved");
              clearHistory("forest");
            }
            stateRef.current = next;
            setState(next);
          }).catch(console.error);
        }
        if (panels.has("recall")) {
          clearHistory("recall");
          setRecallRevision((revision) => revision + 1);
        }
        if (panels.has("memories")) {
          clearHistory("memories");
          setMemoriesRevision((revision) => revision + 1);
        }
        if (panels.has("diary")) {
          clearHistory("diary");
          setDiaryRevision((revision) => revision + 1);
        }
        if (panels.has("ai")) void assistantRef.current.refreshSummaries().catch(console.error);
      }),
    ];
    return () => unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
  }, [clearHistory]);
  const dockPanelRef = useRef(dockPanel);
  dockPanelRef.current = dockPanel;
  /** Minimized into bebe: the dock disappears until bebe is double-clicked or ⌘K. */
  const [dockHidden, setDockHidden] = useState(false);
  const [dockFlight, setDockFlight] = useState<{ x: number; y: number } | null>(null);
  const [dockExpand, setDockExpand] = useState(0);
  /** bebe hidden from the tray: no bebe to shrink into. */
  const [petUserHidden, setPetUserHidden] = useState(false);

  // bebe is the dock: Rust hides bebe while the focused window shows the dock in any form.
  const dockVisible = showWorkbench || !dockHidden;
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) void invoke("set_dock_visible", { visible: dockVisible }).catch(console.error);
  }, [dockVisible]);

  const petChat = petChatSnapshot(assistant.conversation, {
    hasApiKey: state?.hasApiKey ?? false,
    busy: assistant.busy,
    stopped: assistant.stopped,
    error: assistant.error,
  });
  const petChatRef = useRef(petChat);
  petChatRef.current = petChat;
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) void emitTo("pet", PET_CHAT, petChatRef.current).catch(console.error);
  }, [assistant.conversation, assistant.busy, assistant.stopped, assistant.error, state?.hasApiKey]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    void invoke<boolean>("pet_hidden_by_user").then(setPetUserHidden).catch(console.error);
    const unlisteners = [
      listen<boolean>(PET_USER_HIDDEN, ({ payload }) => setPetUserHidden(payload)),
      // Double-clicking bebe starts a new conversation; while a turn is running it shows that one instead.
      listen(PET_SUMMON_DOCK, () => {
        const { busy, startNew } = assistantRef.current;
        if (busy) setDockExpand((count) => count + 1);
        else startNew(dockPanelRef.current);
        setDockHidden(false);
        setDockFlight(null);
        setDockFocus((count) => count + 1);
      }),
      listen(PET_READY, () => void emitTo("pet", PET_CHAT, petChatRef.current)),
      listen<PetChatSend>(PET_CHAT_SEND, ({ payload }) => void assistantRef.current.send(payload.text, PET_CHAT_SCOPE)),
      listen<PetChatResolve>(PET_CHAT_RESOLVE, ({ payload }) => void assistantRef.current.resolveBatch(payload.batchId, payload.selectedIds)),
      listen(PET_CHAT_STOP, () => assistantRef.current.stop()),
      listen<PetChatUndo>(PET_CHAT_UNDO, ({ payload }) => void assistantRef.current.undoAction(payload.messageId)),
      // 写进日记 from bebe's evening summary: no model call, just the diff card to confirm.
      listen<PetSummaryDiary>(PET_SUMMARY_DIARY, ({ payload }) => void stageSummaryDiary(payload)),
      listen<HabitSuggestOffer>(PET_HABIT_SUGGEST, ({ payload }) => void stageHabitSuggestions(payload)),
      listen(PET_OPEN_TIMELINE, () => {
        setPage("timeline");
        void invoke("show_main_window").catch(console.error);
      }),
    ];
    return () => unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
  }, []);

  // Native file drops are off so the dock can take images; a file dropped anywhere else must not open in the window.
  useEffect(() => {
    const ignore = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", ignore);
    window.addEventListener("drop", ignore);
    return () => {
      window.removeEventListener("dragover", ignore);
      window.removeEventListener("drop", ignore);
    };
  }, []);

  // A conversation not started yet follows the page: nothing granted in the workbench (pick on the
  // right), @时间轴 read only on the timeline, and the panel's own pill back on a panel.
  const dockPlace = showWorkbench ? "workbench" : dockPanel;
  useEffect(() => {
    const { conversation, busy, task, scope, startNew } = assistantRef.current;
    if (conversation || busy || task) return;
    const granted = Object.keys(scope).length;
    const timelineOnly = granted === 1 && scope.timeline === "read";
    if (dockPlace === "workbench") {
      if (granted > 0) startNew(dockPanelRef.current, null, {});
    } else if (dockPlace === "timeline" ? !timelineOnly : timelineOnly || granted === 0) {
      startNew(dockPlace);
    }
  }, [dockPlace]);

  /**
   * 写进日记 from the timeline page or bebe's evening summary: the AI adds what the focus time was
   * spent on (timeline + that week's diary) under Beta Life's statistics; the diff card waits for the user.
   */
  function stageSummaryDiary({ date, day, text }: PetSummaryDiary) {
    return assistantRef.current.startTask("summarize_day", PET_DIARY_SCOPE, `把 ${date}（日记 ${day}）的活动总结写进日记。\n\nBeta Life 统计（原样放在最前面）：\n${text}`, `${day} 日记总结`);
  }

  /** 写建议 on bebe's offer after 0:00: the AI reads the reasons and the week's diary; the diff card waits for the user. */
  function stageHabitSuggestions({ date, day, habits }: HabitSuggestOffer) {
    const list = habits.map((habit) => `- ${habit.title}（id ${habit.id}）：近 ${RATE_DAYS} 天完成 ${habit.done}/${habit.total}`).join("\n");
    return assistantRef.current.startTask("suggest_habits", PET_SUGGEST_SCOPE, `给 ${date}（日记 ${day}）这几个完成率偏低的习惯写助推建议：\n${list}`, `${day} 助推建议`);
  }

  /** The timeline's 写进日记: the round runs in the dock. */
  function writeSummaryToDiary(entry: PetSummaryDiary) {
    setDockHidden(false);
    setDockFlight(null);
    setDockExpand((count) => count + 1);
    void stageSummaryDiary(entry);
  }

  /** AI 提取: a new conversation with the 提取习惯 chip and the board writable, ready for text or screenshots. */
  function startHabitExtraction() {
    assistant.startNew("board", "extract_habits");
    setDockHidden(false);
    setDockFlight(null);
    setDockFocus((count) => count + 1);
  }

  async function minimizeDock() {
    const target = window.__TAURI_INTERNALS__ ? await invoke<[number, number] | null>("pet_position_in_main").catch(() => null) : null;
    setDockFlight(target ? { x: target[0], y: target[1] } : { x: window.innerWidth, y: window.innerHeight });
  }

  function finishDockFlight() {
    setDockHidden(true);
    setDockFlight(null);
    if (window.__TAURI_INTERNALS__) void emitTo("pet", PET_DOCK_ARRIVED).catch(console.error);
  }

  const petItems = state ? activeItems(state.board) : null;
  const petPeriods = state?.settings.periods;
  const petSettings = state?.settings.pet;
  const suggestRef = useRef(suggestOffer);
  suggestRef.current = suggestOffer;
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !petItems || !petPeriods || !petSettings) return;
    void emitTo<PetBoardSnapshot>("pet", PET_BOARD, { items: petItems, periods: petPeriods, pet: petSettings, suggest: suggestOffer }).catch(console.error);
  }, [petItems, petPeriods, petSettings, suggestOffer]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const sendSnapshot = () => {
      const current = stateRef.current;
      if (!current) return;
      void emitTo<PetBoardSnapshot>("pet", PET_BOARD, { items: activeItems(current.board), periods: current.settings.periods, pet: current.settings.pet, suggest: suggestRef.current });
    };
    const unlisteners = [
      listen(PET_READY, sendSnapshot),
      listen<PetMarkDone>(PET_MARK_DONE, ({ payload }) => {
        const current = stateRef.current;
        if (!current) return;
        const items = activeItems(current.board);
        if (!items.some((item) => item.id === payload.habitId && !item.done)) return;
        commitBoard(withActiveItems(current.board, items.map((item) => (item.id === payload.habitId ? { ...item, done: true } : item))));
      }),
      listen<PetHabitReasons>(PET_HABIT_REASONS, ({ payload }) => void recordHabitReasons(payload)),
    ];
    return () => unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
  }, [commitBoard, recordHabitReasons]);

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
      if (!typing && page === "panel" && activeSection === "board" && event.key.toLowerCase() === "n" && !showEditor && !showSettings) {
        event.preventDefault();
        openCreate();
      }
      if (!typing && page === "panel" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) void history.redo(activeSection);
        else void history.undo(activeSection);
      }
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !showEditor && !showSettings) {
        event.preventDefault();
        setDockHidden(false);
        setDockFocus((count) => count + 1);
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
  }, [activeSection, page, showEditor, showSettings, history.undo, history.redo]);

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

  function saveTabSlogan(section: WorkspaceSection, slogan: string) {
    const current = stateRef.current;
    if (!current) return;
    const settings = { ...current.settings, slogans: { ...current.settings.slogans, [section]: slogan } };
    const nextState = { ...current, settings };
    stateRef.current = nextState;
    setState(nextState);
    void queueSettingsSave(settings).catch((error) => console.error(error));
  }

  function saveTagIcons(update: (tagIcons: Record<string, string>) => Record<string, string>) {
    const current = stateRef.current;
    if (!current) return;
    const tagIcons = update(current.settings.tagIcons);
    if (tagIcons === current.settings.tagIcons) return;
    const settings = { ...current.settings, tagIcons };
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
  const periods = orderedPeriods(state.settings);
  const viewModes: Array<{ id: BoardViewMode; label: string; title: string; color?: string }> = [
    { id: "global", label: "全局", title: "全局模式" },
    ...periods.map((period, index) => ({
      id: period.id,
      label: shortPeriodLabel(period),
      title: `${period.label} · ${hourLabel(period.startHour)}–${hourLabel(periods[(index + 1) % periods.length].startHour)}`,
      color: period.color,
    })),
  ];
  const dock = (
    <AiDock
      conversation={assistant.conversation}
      busy={assistant.busy}
      error={assistant.error}
      hasApiKey={state.hasApiKey}
      activePanel={dockPanel}
      scope={assistant.scope}
      onScopeChange={assistant.setScope}
      focusRequest={dockFocus}
      stopped={assistant.stopped}
      onStop={assistant.stop}
      onOpenSettings={() => setShowSettings(true)}
      onSend={(text, images) => void assistant.send(text, undefined, images)}
      supportsImages={state.settings.ai.supportsImages}
      task={assistant.task}
      onRemoveTask={() => assistant.setTask(null)}
      onResolveBatch={(batchId, selectedIds) => void assistant.resolveBatch(batchId, selectedIds)}
      onUndoAction={(messageId) => void assistant.undoAction(messageId)}
      onNewConversation={() => assistant.startNew(dockPanel)}
      onRename={assistant.rename}
      layout={showWorkbench ? "workbench" : "dock"}
      onOpenWorkbench={() => setPage("workbench")}
      onMinimize={petUserHidden ? undefined : () => void minimizeDock()}
      flightTarget={dockFlight}
      onFlightEnd={finishDockFlight}
      hidden={dockHidden && !showWorkbench}
      expandRequest={dockExpand}
    />
  );
  const globalDot = `conic-gradient(${periods.map((period, index) => `${period.color} 0 ${((index + 1) * 100) / periods.length}%`).join(", ")})`;

  return (
    <div className="app-shell">
      <header className="topbar" data-section={showWorkbench ? "ai" : page === "timeline" ? "timeline" : activeSection}>
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
        <h1 className="topbar-tab"><i aria-hidden="true" />{showWorkbench ? "AI 工作台" : page === "timeline" ? "时间轴" : SECTION_LABELS[activeSection]}</h1>
        {page === "timeline" ? (
          <div className="topbar-lead"><span className="ai-wb-origin">每天在前台的 app、网站和窗口，按专注 / 中性 / 摸鱼分类</span></div>
        ) : showWorkbench ? (
          <div className="topbar-lead"><span className="ai-wb-origin">所有 AI 对话；右侧设置这段对话能访问哪些 panel</span></div>
        ) : (
          <div className="topbar-lead">
            <Quote size={13} aria-hidden="true" />
            <TopbarSlogan
              key={activeSection}
              value={state.settings.slogans[activeSection]}
              onSave={(slogan) => saveTabSlogan(activeSection, slogan)}
            />
          </div>
        )}

        {page === "panel" && activeSection === "board" && (
          <nav className="period-switch" aria-label="时间板视图模式">
            {viewModes.map((mode) => (
              <button
                type="button"
                key={mode.id}
                className={viewMode === mode.id ? "active" : ""}
                style={mode.color ? ({ "--c": mode.color } as CSSProperties) : undefined}
                title={mode.title}
                aria-pressed={viewMode === mode.id}
                onClick={() => setViewMode(mode.id)}
              >
                <i aria-hidden="true" style={mode.color ? undefined : { background: globalDot }} />
                {mode.label}
              </button>
            ))}
          </nav>
        )}

        <div className="topbar-actions">
          {page === "panel" && <div className="history-actions">
            <button className="icon-button" onClick={() => void history.undo(activeSection)} disabled={!history.canUndo(activeSection)} title="撤销 ⌘Z" aria-label="撤销"><Undo2 size={18} /></button>
            <button className="icon-button" onClick={() => void history.redo(activeSection)} disabled={!history.canRedo(activeSection)} title="重做 ⇧⌘Z" aria-label="重做"><Redo2 size={18} /></button>
          </div>}
          {page === "panel" && activeSection === "board" && <>
            <span className={`save-state ${saveState}`}>
              {saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}
            </span>
            <button className="secondary-button" onClick={startHabitExtraction} disabled={assistant.busy} aria-label="AI 提取" title={assistant.busy ? "AI 正在回复，稍后再开始提取" : "从文字或截图提取习惯（在 AI 对话里进行）"}>
              <Sparkles size={16} /> <span className="topbar-label">AI 提取</span>
            </button>
            <button className="primary-button" onClick={() => openCreate()}>
              <Plus size={16} /> 新习惯 <kbd>N</kbd>
            </button>
          </>}
          {vaultIssues.length > 0 && (
            <span className="vault-issues" role="status" title={vaultIssues.map((issue) => `${issue.path}：${issue.message}`).join("\n")}>
              {vaultIssues.length} 个文件无法读取
            </span>
          )}
          <div className="topbar-tab-actions" ref={setTopbarActions} />
          <button className="icon-button settings-button" onClick={() => setShowSettings(true)} aria-label="设置"><Settings size={19} /></button>
        </div>
      </header>

      {history.notice && (
        <div key={history.notice.id} className={`history-toast ${history.notice.error ? "is-error" : ""}`} role="status">{history.notice.text}</div>
      )}

      <WorkspaceDrawer
        activeSection={activeSection}
        page={page === "panel" ? null : page}
        open={showWorkspaceDrawer}
        onOpenChange={setShowWorkspaceDrawer}
        onSectionChange={(section) => {
          setActiveSection(section);
          setPage("panel");
        }}
        onOpenPage={setPage}
        triggerRef={workspaceDrawerTrigger}
      />

      {showWorkbench ? <AiWorkbench
        summaries={assistant.summaries}
        conversation={assistant.conversation}
        busy={assistant.busy}
        scope={assistant.scope}
        onScopeChange={assistant.setScope}
        onOpen={(id) => void assistant.open(id)}
        onDelete={(id) => void assistant.remove(id)}
        onNew={() => assistant.startNew(activeSection, null, {})}
        onResolveBatch={(batchId, selectedIds) => void assistant.resolveBatch(batchId, selectedIds)}
      >{dock}</AiWorkbench> : page === "timeline" ? <TimelineView onWriteDiary={(summary) => void writeSummaryToDiary(summaryDiaryEntry(summary))} writeDisabled={assistant.busy} /> : activeSection === "recall" ? <RecallView
        settings={state.settings}
        hasApiKey={state.hasApiKey}
        onOpenSettings={() => setShowSettings(true)}
        topbarActions={topbarActions}
        revision={recallRevision}
        onHistory={(before, after) => recordRecall([before], [after])}
      /> : activeSection === "forest" ? <AbilityForestView
        key={activeAbilityMap}
        forest={state[ABILITY_MAP_STATE_KEYS[activeAbilityMap]]}
        saveState={forestSaveState}
        onForestChange={changeActiveAbilityForest}
        topbarActions={topbarActions}
        mapTabs={<AbilityMapTabs
          maps={ABILITY_MAP_KINDS.map((kind) => ({ kind, name: state[ABILITY_MAP_STATE_KEYS[kind]].name?.trim() || DEFAULT_ABILITY_MAP_NAMES[kind] }))}
          active={activeAbilityMap}
          onSelect={setActiveAbilityMap}
          onRename={renameAbilityMap}
        />}
      /> : activeSection === "memories" ? <MemoriesView
        hasApiKey={state.hasApiKey}
        onOpenSettings={() => setShowSettings(true)}
        lifeStagesRevision={lifeStagesRevision}
        dataRevision={memoriesRevision}
        onHistory={(before, after) => recordMemories([before], [after])}
      /> : activeSection === "diary" ? <DiaryView
        template={state.settings.diary.template}
        revision={diaryRevision}
        onHistory={(before, after, key) => recordDiary([before], [after], key)}
      /> : <main className="workspace-scroll">
        <BoardView
          items={board?.items ?? []}
          settings={state.settings}
          viewMode={viewMode}
          rates={habitRateMap}
          onItemsChange={updateItems}
          onCreate={openCreate}
          onEdit={openEdit}
          onSloganChange={savePeriodSlogan}
          onTagIconChange={(tag, icon) => saveTagIcons((tagIcons) => ({ ...tagIcons, [tag]: icon }))}
        />
      </main>}

      {!showWorkbench && dock}

      {loadError && !window.__TAURI_INTERNALS__ && (
        <div className="browser-warning">当前是浏览器预览模式；数据不会写入本地文件。请使用 <code>npm run tauri dev</code> 测试桌面能力。</div>
      )}

      {showEditor && (
        <HabitEditor
          key={editorHabit?.id ?? editorContainer ?? "new"}
          habit={editorHabit}
          initialContainer={editorContainer}
          settings={state.settings}
          knownTags={collectTags(activeItems(state.board).map((item) => item.tags))}
          onClose={() => setShowEditor(false)}
          onSave={saveHabit}
          onDelete={deleteHabit}
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
          onLifeStagesSaved={() => setLifeStagesRevision((revision) => revision + 1)}
        />
      )}
    </div>
  );
}
