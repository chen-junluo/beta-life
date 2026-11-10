import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { MessageCircle, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { hourLabel } from "../boardLogic";
import { DiffCard } from "../components/AiDock";
import { renderMarkdown } from "../markdown";
import type { Habit, PeriodSetting } from "../types";
import {
  PET_BOARD,
  PET_CHAT,
  PET_CHAT_RESOLVE,
  PET_CHAT_SEND,
  PET_CHAT_STOP,
  PET_DOCK_ARRIVED,
  PET_MARK_DONE,
  PET_PRESENCE,
  PET_READY,
  type PetBoardSnapshot,
  type PetChatResolve,
  type PetChatSend,
  type PetChatSnapshot,
  type PetMarkDone,
} from "./bridge";
import { isSleepPeriod, localDateKey, reminderSlot } from "./reminders";
import { SpritePlayer, preloadStrips, type PetManifest } from "./sprite";

const ASSET_BASE = "/assets/bebe/";
const TICK_MS = 30_000;
const SNOOZE_MS = 15 * 60_000;
const FOCUS_MS = 5 * 60_000;
const DRAG_THRESHOLD = 4;
const DAY_STORAGE_KEY = "bebe:day";
const isTauri = Boolean(window.__TAURI_INTERNALS__);

type Bubble =
  | { kind: "reminder"; hour: number; queue: Habit[] }
  | { kind: "focus"; habit: Habit; endsAt: number }
  | { kind: "checkin"; habit: Habit }
  | { kind: "chat" };

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

/** Dev-only browser preview: `pet.html?state=alert&bubble=reminder` (or `bubble=chat`). */
function devPreview(): { state: string | null; bubble: Bubble | null; chat: PetChatSnapshot | null } {
  if (!import.meta.env.DEV || isTauri) return { state: null, bubble: null, chat: null };
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
    chat: { kind: "chat" },
  };
  const chat: PetChatSnapshot = {
    hasApiKey: true,
    busy: false,
    stopped: false,
    error: null,
    title: "下午安排写作",
    lastUser: "下午帮我加一个写 RQ2 文献综述的时间块，再把喝水挪到晚上",
    reply: "好的，我在**下午**加了「写 RQ2 文献综述」，并把「喝水」移到晚上。确认后生效：",
    batch: {
      id: "preview",
      status: "pending",
      changes: [
        { id: "a", panel: "board", toolCallId: "1", name: "add_habit", arguments: {}, kind: "add", title: "写 RQ2 文献综述", detail: "下午", selected: true },
        { id: "b", panel: "board", toolCallId: "2", name: "move_habit", arguments: {}, kind: "move", title: "起床后喝一大杯温水", detail: "早上 → 晚上", selected: true },
      ],
    },
  };
  return { state: params.get("state"), bubble: bubbles[params.get("bubble") ?? ""] ?? null, chat: params.get("bubble") === "chat" ? chat : null };
}

/** Chat with the assistant from bebe; the main window runs it on the shared conversation. */
function PetChat({ chat, onClose }: { chat: PetChatSnapshot | null; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const busy = chat?.busy ?? false;

  // The pet window is created unfocused; take focus so typing (and the IME) goes to the input.
  useEffect(() => {
    const focus = () => input.current?.focus();
    if (isTauri) void invoke("focus_pet_window").catch(console.error).finally(focus);
    else focus();
  }, []);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [chat?.lastUser, chat?.reply, busy, chat?.batch?.status]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    if (isTauri) void emitTo<PetChatSend>("main", PET_CHAT_SEND, { text });
    setDraft("");
  }

  function resolve(batchId: string, selectedIds: string[] | null) {
    if (isTauri) void emitTo<PetChatResolve>("main", PET_CHAT_RESOLVE, { batchId, selectedIds });
  }

  const blockLinks = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
  };
  const hasRound = Boolean(chat && (chat.lastUser || chat.reply || chat.batch || chat.error || busy || chat.stopped));

  return (
    <section
      className="pet-bubble pet-chat"
      role="dialog"
      aria-label="和 bebe 对话"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="pet-chat-head">
        <span className="pet-bubble-meta" title={chat?.title ?? undefined}>{chat?.title ?? "和 bebe 说"}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭对话" title="关闭（Esc）">
          <X size={14} />
        </button>
      </header>
      {hasRound && chat && (
        <div className="pet-chat-body" ref={body}>
          {chat.lastUser && <p className="pet-chat-user">{chat.lastUser}</p>}
          {chat.reply && <div className="md-content pet-chat-reply" onClick={blockLinks} dangerouslySetInnerHTML={{ __html: renderMarkdown(chat.reply) }} />}
          {chat.batch && <DiffCard key={chat.batch.id} batch={chat.batch} onResolve={resolve} />}
          {busy && <span className="pet-chat-status">bebe 在想…</span>}
          {chat.stopped && !busy && <span className="pet-chat-status">已停止</span>}
          {chat.error && <p className="inline-error" role="alert">{chat.error}</p>}
        </div>
      )}
      {chat && !chat.hasApiKey ? (
        <p className="pet-chat-status">先在 beta-life 的 Settings 里保存 API key，才能和 bebe 对话</p>
      ) : (
        <form className="pet-chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea
            ref={input}
            rows={2}
            value={draft}
            placeholder={chat?.lastUser ? "继续说…" : "让 bebe 帮你看看或改改时间板…"}
            aria-label="给 bebe 发消息"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter while an IME is composing picks a candidate; it must not send.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="primary-button" onClick={() => isTauri && void emitTo("main", PET_CHAT_STOP)} aria-label="停止" title="停止">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="primary-button" disabled={!draft.trim()} aria-label="发送">
              <Send size={14} />
            </button>
          )}
        </form>
      )}
    </section>
  );
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
  /** bebe makes way while the focused main window shows the dock (decided in pet.rs). */
  const [away, setAway] = useState(false);
  const [chat, setChat] = useState<PetChatSnapshot | null>(preview.chat);
  const chatBusy = chat?.busy ?? false;

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
    if (!player || ["drag", "alert", "happy", "thinking"].includes(player.state ?? "")) return;
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

  useEffect(() => {
    if (!isTauri) return;
    void invoke<boolean>("pet_makes_way").then(setAway).catch(console.error);
    const unlisteners = [
      listen<boolean>(PET_PRESENCE, ({ payload }) => setAway(payload)),
      listen<PetChatSnapshot>(PET_CHAT, ({ payload }) => setChat(payload)),
      listen(PET_DOCK_ARRIVED, () => play("happy")),
    ];
    return () => unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
  }, [play]);

  // Think while the assistant works, wherever the message was sent from.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (chatBusy) player.play("thinking");
    else if (player.state === "thinking") player.play(baseStateRef.current);
  }, [chatBusy]);

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
    // While bebe makes way for the dock, reminders wait until it is back on the desktop.
    if (bubble || sleeping || away) return;
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
  }, [now, items, periods, bubble, sleeping, away, snoozed, pendingOnly, play, preview.bubble]);

  // Keep the reminder queue in sync when to-dos are finished from the main window.
  useEffect(() => {
    if (bubble?.kind !== "reminder" || preview.bubble) return;
    const queue = pendingOnly(bubble.queue);
    if (queue.length !== bubble.queue.length) setBubble(queue.length ? { ...bubble, queue } : null);
  }, [items, bubble, pendingOnly, preview.bubble]);

  // The window never resizes; Rust lets clicks through everywhere except bebe and the bubble.
  // offset* ignores the bubble's entry transform, so the regions match the settled layout.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !isTauri) return;
    const report = () => {
      const origin = stage.getBoundingClientRect();
      // While making way bebe is invisible and every click goes through.
      const regions = away ? [] : [...stage.querySelectorAll<HTMLElement>(".pet-sprite, .pet-bubble, .pet-chat-open")].map((element) => ({
        x: origin.left + element.offsetLeft,
        y: origin.top + element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }));
      void invoke("set_pet_hit_regions", { regions });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [away]);

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
    if (!drag || drag.dragging || !isTauri) return;
    if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < DRAG_THRESHOLD) return;
    drag.dragging = true;
    const resumeState = playerRef.current?.state ?? baseStateRef.current;
    play("drag");
    // Resolves only once the left mouse button is released (the OS drag call itself returns immediately).
    await invoke("drag_pet_window").catch(console.error);
    dragRef.current = null;
    const resume = manifestRef.current?.states[resumeState];
    play(resume && !resume.loop ? resume.then ?? baseStateRef.current : resumeState === "drag" ? baseStateRef.current : resumeState);
  }

  // A single click does nothing; double-click opens the dock with a new conversation.
  function onPointerUp() {
    const drag = dragRef.current;
    if (drag && !drag.dragging) dragRef.current = null;
  }

  return (
    <div className={`pet-stage ${away ? "is-away" : ""}`} ref={stageRef} aria-hidden={away}>
      {bubble?.kind === "chat" && <PetChat chat={chat} onClose={() => setBubble(null)} />}
      {bubble && bubble.kind !== "chat" && (
        <section className="pet-bubble" role="dialog" aria-live="polite" aria-label="bebe 提醒">
          {bubble.kind === "reminder" && (
            <>
              <span className="pet-bubble-meta">
                {hourLabel(bubble.hour)}
                {bubble.queue.length > 1 ? ` · 还有 ${bubble.queue.length - 1} 项` : ""}
              </span>
              <p className="pet-bubble-text" title={bubble.queue[0].title}>
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
              <p className="pet-bubble-text" title={bubble.habit.title}>{bubble.habit.title}</p>
              <strong className="pet-countdown" aria-label="剩余时间">{formatCountdown(bubble.endsAt - now)}</strong>
            </>
          )}
          {bubble.kind === "checkin" && (
            <>
              <span className="pet-bubble-meta">5 分钟到了</span>
              <p className="pet-bubble-text" title={bubble.habit.title}>「{bubble.habit.title}」继续做，还是先休息一下？</p>
              <div className="pet-bubble-actions">
                <button type="button" className="primary-button" onClick={() => { play("happy"); setBubble(null); }}>继续</button>
                <button type="button" className="secondary-button" onClick={() => snooze([bubble.habit], new Date().getHours())}>休息 15 分钟</button>
              </div>
            </>
          )}
        </section>
      )}
      <div className="pet-row">
        {!bubble && (
          <button type="button" className="icon-button pet-chat-open" onClick={() => setBubble({ kind: "chat" })} aria-label="和 bebe 对话" title="和 bebe 对话">
            <MessageCircle size={15} />
          </button>
        )}
        <div
          ref={spriteRef}
          className="pet-sprite"
          role="img"
          aria-label={sleeping ? "bebe 在睡觉" : "bebe"}
          title="双击新开 AI 对话，拖动可以移动"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => isTauri && void invoke("summon_dock")}
        />
      </div>
    </div>
  );
}
