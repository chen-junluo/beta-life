import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { hourLabel } from "../boardLogic";
import type { Habit, PeriodSetting } from "../types";
import { PET_BOARD, PET_MARK_DONE, PET_READY, type PetBoardSnapshot, type PetMarkDone } from "./bridge";
import { isSleepPeriod, localDateKey, reminderSlot } from "./reminders";
import { SpritePlayer, preloadStrips, type PetManifest } from "./sprite";

const ASSET_BASE = "/assets/bebe/";
const TICK_MS = 30_000;
const SNOOZE_MS = 15 * 60_000;
const FOCUS_MS = 5 * 60_000;
const DRAG_THRESHOLD = 4;
const DRAG_SETTLE_MS = 250;
const DAY_STORAGE_KEY = "bebe:day";
const isTauri = Boolean(window.__TAURI_INTERNALS__);

type Bubble =
  | { kind: "reminder"; hour: number; queue: Habit[] }
  | { kind: "focus"; habit: Habit; endsAt: number }
  | { kind: "checkin"; habit: Habit };

interface DayMemory {
  date: string;
  reminded: string[];
  skipped: string[];
}

function loadDay(now: Date): DayMemory {
  const date = localDateKey(now);
  try {
    const stored = JSON.parse(localStorage.getItem(DAY_STORAGE_KEY) ?? "null") as DayMemory | null;
    if (stored?.date === date) return stored;
  } catch {
    // A corrupt entry only loses today's skip list.
  }
  return { date, reminded: [], skipped: [] };
}

function saveDay(day: DayMemory) {
  localStorage.setItem(DAY_STORAGE_KEY, JSON.stringify(day));
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Dev-only browser preview: `pet.html?state=alert&bubble=reminder`. */
function devPreview(): { state: string | null; bubble: Bubble | null } {
  if (!import.meta.env.DEV || isTauri) return { state: null, bubble: null };
  const params = new URLSearchParams(location.search);
  const habit: Habit = {
    id: "preview",
    title: "写 RQ2 文献综述：整理三篇核心论文",
    description: "",
    tags: "",
    placement: { kind: "hour", hour: 14 },
    order: 0,
    createdAt: "",
    updatedAt: "",
  };
  const bubbles: Record<string, Bubble> = {
    reminder: { kind: "reminder", hour: 14, queue: [habit, { ...habit, id: "second", title: "回复导师邮件" }] },
    focus: { kind: "focus", habit, endsAt: Date.now() + FOCUS_MS },
    checkin: { kind: "checkin", habit },
  };
  return { state: params.get("state"), bubble: bubbles[params.get("bubble") ?? ""] ?? null };
}

export function PetApp() {
  const preview = useRef(devPreview()).current;
  const spriteRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SpritePlayer | null>(null);
  const manifestRef = useRef<PetManifest | null>(null);
  const [items, setItems] = useState<Habit[]>([]);
  const [periods, setPeriods] = useState<PeriodSetting[]>([]);
  const [bubble, setBubble] = useState<Bubble | null>(preview.bubble);
  const [snoozed, setSnoozed] = useState<{ until: number; hour: number; queue: Habit[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dayRef = useRef<DayMemory>(loadDay(new Date()));
  const dragRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const sleeping = isSleepPeriod(new Date(now), periods);
  const baseState = preview.state ?? (sleeping ? "sleep" : "idle");
  const baseStateRef = useRef(baseState);
  baseStateRef.current = baseState;

  const play = useCallback((state: string) => playerRef.current?.play(state), []);

  // Load the manifest, preload all strips, then start the base state.
  useEffect(() => {
    let cancelled = false;
    void fetch(`${ASSET_BASE}pet.json`)
      .then((response) => response.json() as Promise<PetManifest>)
      .then(async (manifest) => {
        await preloadStrips(manifest, ASSET_BASE);
        if (cancelled || !spriteRef.current) return;
        manifestRef.current = manifest;
        playerRef.current = new SpritePlayer(spriteRef.current, manifest, ASSET_BASE);
        playerRef.current.play(baseStateRef.current);
      });
    return () => {
      cancelled = true;
      playerRef.current?.stop();
    };
  }, []);

  // Return to the base state when it changes (entering or leaving sleep), unless a one-shot is playing.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || player.state === "drag" || player.state === "alert" || player.state === "happy") return;
    if (player.state !== baseState) player.play(baseState);
  }, [baseState]);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<PetBoardSnapshot>(PET_BOARD, ({ payload }) => {
      setItems(payload.items);
      setPeriods(payload.periods);
    });
    void unlisten.then(() => emitTo("main", PET_READY));
    return () => void unlisten.then((stop) => stop());
  }, []);

  // A coarse clock drives reminders; the focus countdown ticks every second only while visible.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), bubble?.kind === "focus" ? 1000 : TICK_MS);
    return () => clearInterval(interval);
  }, [bubble?.kind]);

  const pendingOnly = useCallback(
    (queue: Habit[]) => {
      const live = new Map(items.map((item) => [item.id, item]));
      return queue.flatMap((habit) => {
        const current = live.get(habit.id);
        return current && !current.done && !dayRef.current.skipped.includes(habit.id) ? [current] : [];
      });
    },
    [items],
  );

  // Decide whether to raise a reminder bubble.
  useEffect(() => {
    if (preview.bubble) return;
    const date = new Date(now);
    if (dayRef.current.date !== localDateKey(date)) dayRef.current = loadDay(date);

    if (bubble?.kind === "focus" && now >= bubble.endsAt) {
      setBubble({ kind: "checkin", habit: bubble.habit });
      play("alert");
      return;
    }
    if (bubble || sleeping) return;
    if (snoozed) {
      if (now < snoozed.until) return;
      setSnoozed(null);
      const queue = pendingOnly(snoozed.queue);
      if (queue.length === 0) return;
      setBubble({ kind: "reminder", hour: snoozed.hour, queue });
      play("alert");
      return;
    }
    const slot = reminderSlot(date, items, periods);
    if (!slot || dayRef.current.reminded.includes(slot.key)) return;
    dayRef.current = { ...dayRef.current, reminded: [...dayRef.current.reminded, slot.key] };
    saveDay(dayRef.current);
    const queue = pendingOnly(slot.habits);
    if (queue.length === 0) return;
    setBubble({ kind: "reminder", hour: date.getHours(), queue });
    play("alert");
  }, [now, items, periods, bubble, sleeping, snoozed, pendingOnly, play, preview.bubble]);

  // Keep the reminder queue in sync when to-dos are finished from the main window.
  useEffect(() => {
    if (bubble?.kind !== "reminder" || preview.bubble) return;
    const queue = pendingOnly(bubble.queue);
    if (queue.length !== bubble.queue.length) setBubble(queue.length ? { ...bubble, queue } : null);
  }, [items, bubble, pendingOnly, preview.bubble]);

  // Fit the transparent window to the pet plus bubble so empty space never blocks clicks.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !isTauri) return;
    const resize = () => void invoke("resize_pet_window", { width: stage.offsetWidth, height: stage.offsetHeight });
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  function advance(queue: Habit[], hour: number) {
    setBubble(queue.length ? { kind: "reminder", hour, queue } : null);
  }

  function markDone(habit: Habit, rest: Habit[], hour: number) {
    if (isTauri) void emitTo<PetMarkDone>("main", PET_MARK_DONE, { habitId: habit.id });
    play("happy");
    advance(rest, hour);
  }

  function skipToday(habit: Habit, rest: Habit[], hour: number) {
    dayRef.current = { ...dayRef.current, skipped: [...dayRef.current.skipped, habit.id] };
    saveDay(dayRef.current);
    advance(rest, hour);
  }

  function snooze(queue: Habit[], hour: number) {
    setSnoozed({ until: Date.now() + SNOOZE_MS, hour, queue });
    setBubble(null);
  }

  function startFocus(habit: Habit) {
    play("happy");
    setBubble({ kind: "focus", habit, endsAt: Date.now() + FOCUS_MS });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.screenX, y: event.screenY, dragging: false };
  }

  async function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const manifest = manifestRef.current;
    if (!drag || drag.dragging || !manifest || !isTauri) return;
    if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < DRAG_THRESHOLD) return;
    drag.dragging = true;
    const resumeState = playerRef.current?.state ?? baseStateRef.current;
    play("drag");

    // Put the cursor on the sprite's grab point (cell px → CSS px) before handing off to the OS drag.
    const [grabX, grabY] = manifest.states.drag.grabPoint ?? [manifest.cell.width / 2, manifest.cell.height / 2];
    const scale = manifest.display.width / manifest.cell.width;
    const rect = spriteRef.current!.getBoundingClientRect();
    await invoke("move_pet_window_by", { dx: event.clientX - (rect.left + grabX * scale), dy: event.clientY - (rect.top + grabY * scale) });

    const petWindow = getCurrentWindow();
    let settle: ReturnType<typeof setTimeout> | undefined;
    let dragReturned = false;
    const finish = () => {
      if (!dragReturned) return;
      stopMoved();
      dragRef.current = null;
      const resume = manifest.states[resumeState];
      play(resume && !resume.loop ? resume.then ?? baseStateRef.current : resumeState === "drag" ? baseStateRef.current : resumeState);
    };
    const unlistenMoved = await petWindow.onMoved(() => {
      clearTimeout(settle);
      settle = setTimeout(finish, DRAG_SETTLE_MS);
    });
    const stopMoved = () => {
      clearTimeout(settle);
      unlistenMoved();
    };
    await petWindow.startDragging().catch(console.error);
    dragReturned = true;
    settle = setTimeout(finish, DRAG_SETTLE_MS);
  }

  function onPointerUp() {
    const drag = dragRef.current;
    if (drag && !drag.dragging) {
      dragRef.current = null;
      if (isTauri) void invoke("show_main_window");
    }
  }

  return (
    <div className="pet-stage" ref={stageRef}>
      {bubble && (
        <section className="pet-bubble" role="dialog" aria-live="polite" aria-label="bebe 提醒">
          {bubble.kind === "reminder" && (
            <>
              <span className="pet-bubble-meta">
                {hourLabel(bubble.hour)}
                {bubble.queue.length > 1 ? ` · 还有 ${bubble.queue.length - 1} 项` : ""}
              </span>
              <p className="pet-bubble-text">
                该做「{bubble.queue[0].title}」了，先做 5 分钟？
              </p>
              <div className="pet-bubble-actions">
                <button type="button" className="primary-button" onClick={() => startFocus(bubble.queue[0])}>开始 5 分钟</button>
                <button type="button" className="secondary-button" onClick={() => markDone(bubble.queue[0], bubble.queue.slice(1), bubble.hour)}>已完成</button>
                <button type="button" className="secondary-button" onClick={() => snooze(bubble.queue, bubble.hour)}>稍后提醒</button>
                <button type="button" className="secondary-button" onClick={() => skipToday(bubble.queue[0], bubble.queue.slice(1), bubble.hour)}>今天跳过</button>
              </div>
            </>
          )}
          {bubble.kind === "focus" && (
            <>
              <span className="pet-bubble-meta">专注中</span>
              <p className="pet-bubble-text">{bubble.habit.title}</p>
              <strong className="pet-countdown" aria-label="剩余时间">{formatCountdown(bubble.endsAt - now)}</strong>
            </>
          )}
          {bubble.kind === "checkin" && (
            <>
              <span className="pet-bubble-meta">5 分钟到了</span>
              <p className="pet-bubble-text">「{bubble.habit.title}」继续做，还是先休息一下？</p>
              <div className="pet-bubble-actions">
                <button type="button" className="primary-button" onClick={() => { play("happy"); setBubble(null); }}>继续</button>
                <button type="button" className="secondary-button" onClick={() => snooze([bubble.habit], new Date().getHours())}>休息 15 分钟</button>
              </div>
            </>
          )}
        </section>
      )}
      <div
        ref={spriteRef}
        className="pet-sprite"
        role="img"
        aria-label={sleeping ? "bebe 在睡觉" : "bebe"}
        title="点击打开 beta-life，拖动可以移动"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
