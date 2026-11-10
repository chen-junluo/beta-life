import { useCallback, useEffect, useRef, useState } from "react";

export type HistoryPanel = "board" | "forest" | "recall" | "memories";

/** One undoable change: the value before and after, and how to write either one back. */
export interface HistoryChange<T> {
  before: T;
  after: T;
  /** Must write `value` without recording history again. */
  restore: (value: T) => void | Promise<void>;
  /** Consecutive changes with the same key inside COALESCE_MS merge into one step (typing). */
  key?: string;
}

interface HistoryEntry extends HistoryChange<unknown> {
  at: number;
}

type Stacks = Record<HistoryPanel, { undo: HistoryEntry[]; redo: HistoryEntry[] }>;

export interface HistoryNotice {
  id: number;
  text: string;
  error?: boolean;
}

const LIMIT = 50;
const COALESCE_MS = 1500;
const EMPTY: Stacks = {
  board: { undo: [], redo: [] },
  forest: { undo: [], redo: [] },
  recall: { undo: [], redo: [] },
  memories: { undo: [], redo: [] },
};

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "未知错误";
}

/** Independent undo/redo stacks per panel, kept in the main window so they survive panel switches. */
export function usePanelHistory() {
  const [stacks, setStacks] = useState<Stacks>(EMPTY);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  const stacksRef = useRef(stacks);
  const running = useRef(false);

  const update = useCallback((next: (current: Stacks) => Stacks) => {
    stacksRef.current = next(stacksRef.current);
    setStacks(stacksRef.current);
  }, []);

  const record = useCallback(<T,>(panel: HistoryPanel, change: HistoryChange<T>) => {
    const now = Date.now();
    update((current) => {
      const { undo } = current[panel];
      const last = undo.at(-1);
      const entry = change as HistoryChange<unknown>;
      const merged = change.key && last?.key === change.key && now - last.at < COALESCE_MS
        ? [...undo.slice(0, -1), { ...last, after: change.after, at: now }]
        : [...undo.slice(-(LIMIT - 1)), { ...entry, at: now }];
      return { ...current, [panel]: { undo: merged, redo: [] } };
    });
  }, [update]);

  const step = useCallback(async (panel: HistoryPanel, direction: "undo" | "redo") => {
    if (running.current) return;
    const stack = stacksRef.current[panel];
    const entry = direction === "undo" ? stack.undo.at(-1) : stack.redo.at(-1);
    if (!entry) return;
    running.current = true;
    try {
      await entry.restore(direction === "undo" ? entry.before : entry.after);
      update((current) => {
        const { undo, redo } = current[panel];
        return {
          ...current,
          [panel]: direction === "undo"
            ? { undo: undo.slice(0, -1), redo: [...redo, entry] }
            : { undo: [...undo, entry], redo: redo.slice(0, -1) },
        };
      });
      setNotice({ id: nextNoticeId(), text: direction === "undo" ? "已撤销" : "已重做" });
    } catch (error) {
      setNotice({ id: nextNoticeId(), text: `${direction === "undo" ? "撤销" : "重做"}失败：${errorMessage(error)}`, error: true });
    } finally {
      running.current = false;
    }
  }, [update]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 4000 : 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return {
    record,
    undo: useCallback((panel: HistoryPanel) => step(panel, "undo"), [step]),
    redo: useCallback((panel: HistoryPanel) => step(panel, "redo"), [step]),
    canUndo: (panel: HistoryPanel) => stacks[panel].undo.length > 0,
    canRedo: (panel: HistoryPanel) => stacks[panel].redo.length > 0,
    notice,
  };
}

let noticeCount = 0;
function nextNoticeId(): number {
  noticeCount += 1;
  return noticeCount;
}
