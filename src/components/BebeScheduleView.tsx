import { Lock, Pause, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { hourLabel, orderedPeriods } from "../boardLogic";
import { clockText, isSnoozed, nextClock, type OneOffReminder, type PetPlan } from "../pet/plan";
import { WEEKDAYS } from "../pet/reminders";
import { dayWindow, fixedBetween, fixedTimes, quietBetween, weekWindows, type FixedTime } from "../pet/schedule";
import type { AppSettings, QuietHours } from "../types";
import { QuietHoursEditor } from "./BebeSettings";

const MINUTE = 60_000;
/** Both views share one vertical scale, so a time sits at the same height in either. */
const PX_PER_MINUTE = 0.56;
const REMINDER_HEIGHT = 40;
const FIXED_HEIGHT = 28;

type Editing = { id: string | null; time: string; text: string };

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const dateLabel = (at: number) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAYS[(date.getDay() + 6) % 7].label}`;
};

/** Fixed times closer than 20 minutes share one marker in the narrow week columns. */
function merged<T extends { at: number }>(items: T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && item.at - last[0].at < 20 * MINUTE) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

const shortLabel = (time: FixedTime) => (time.kind === "ask" ? time.label.slice(1, 3) : time.kind === "summary" ? "总结" : "存档");

/** Tops for items sorted by time, pushed down so cards closer than their height do not overlap. */
function stacked<T extends { at: number }>(items: T[], from: number, height: number): Array<T & { top: number }> {
  let next = -Infinity;
  return items.map((item) => {
    const top = Math.max((item.at - from) / MINUTE * PX_PER_MINUTE - 10, next);
    next = top + height + 4;
    return { ...item, top };
  });
}

/**
 * The time board's bebe tab: one-off reminders (editable), bebe's fixed times (read only), quiet
 * hours and the pause as bands. 今天 = a 24-hour line from the morning start, 本周 = Monday to Sunday;
 * everything is edited in the panel on the right.
 */
export function BebeScheduleView({ settings, plan, onPlanChange, onQuietHoursChange, quietError }: {
  settings: AppSettings;
  plan: PetPlan;
  onPlanChange: (plan: PetPlan) => void;
  onQuietHoursChange: (quietHours: QuietHours[]) => void;
  quietError: string | null;
}) {
  const [mode, setMode] = useState<"day" | "week">("day");
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selectedQuiet, setSelectedQuiet] = useState<number | null>(null);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const periods = useMemo(() => orderedPeriods(settings), [settings]);
  const times = useMemo(() => fixedTimes(settings.periods, settings.pet), [settings.periods, settings.pet]);
  const reminders = useMemo(() => [...plan.reminders].sort((a, b) => a.at - b.at), [plan.reminders]);
  const snoozed = isSnoozed(plan, now);
  const day = dayWindow(now, settings.periods);
  const height = 24 * 60 * PX_PER_MINUTE;
  const y = (at: number, from: number) => (at - from) / MINUTE * PX_PER_MINUTE;

  function edit(reminder: OneOffReminder) {
    setEditing({ id: reminder.id, time: clock(reminder.at), text: reminder.text });
  }

  function saveEditing() {
    if (!editing || !editing.text.trim() || !/^\d{2}:\d{2}$/.test(editing.time)) return;
    const reminder = { id: editing.id ?? crypto.randomUUID(), at: nextClock(editing.time, Date.now()), text: editing.text.trim() };
    onPlanChange({ ...plan, reminders: [...plan.reminders.filter((item) => item.id !== reminder.id), reminder] });
    setEditing(null);
  }

  function remove(id: string) {
    onPlanChange({ ...plan, reminders: plan.reminders.filter((item) => item.id !== id) });
    if (editing?.id === id) setEditing(null);
  }

  /** Hour ticks and period strips for a window starting at `from`. */
  function axis(from: number, withLabels: boolean) {
    const start = new Date(from).getHours();
    return (
      <>
        {Array.from({ length: 25 }, (_, index) => (
          <div key={index} className="bebe-tick" style={{ top: index * 60 * PX_PER_MINUTE }}>
            {withLabels && index % 2 === 0 && index < 24 && <span>{hourLabel((start + index) % 24)}</span>}
          </div>
        ))}
      </>
    );
  }

  function periodStrips(from: number) {
    const start = new Date(from).getHours();
    return periods.map((period, index) => {
      const next = periods[(index + 1) % periods.length].startHour;
      const offset = (period.startHour - start + 24) % 24;
      const length = ((next - period.startHour + 24) % 24) || 24;
      return (
        <div key={period.id} className="bebe-period" style={{ top: offset * 60 * PX_PER_MINUTE, height: length * 60 * PX_PER_MINUTE, "--c": period.color } as CSSProperties}>
          <span>{period.label}</span>
        </div>
      );
    });
  }

  function quietBands(from: number, to: number, compact: boolean) {
    return quietBetween(settings.pet.quietHours, from, to).map((range) => (
      <button
        key={`${range.index}-${range.start}`}
        type="button"
        className={`bebe-band is-quiet ${selectedQuiet === range.index ? "is-selected" : ""}`}
        style={{ top: y(range.start, from), height: Math.max(14, y(range.end, from) - y(range.start, from)) }}
        onClick={() => setSelectedQuiet(range.index)}
        title={`安静 ${clock(range.start)}–${clock(range.end)}：不弹摸鱼提醒、分类询问和习惯提醒。点一下在右边改`}
      >
        {compact ? "安静" : `安静 ${clock(range.start)}–${clock(range.end)}`}
      </button>
    ));
  }

  function snoozeBand(from: number, to: number, compact: boolean) {
    if (!snoozed || plan.snoozeUntil === null) return null;
    const start = Math.max(now, from);
    const end = Math.min(plan.snoozeUntil, to);
    if (end <= start) return null;
    return (
      <div className="bebe-band is-snooze" style={{ top: y(start, from), height: Math.max(14, y(end, from) - y(start, from)) }} title={`暂停到 ${clockText(plan.snoozeUntil, now)}`}>
        {compact ? "暂停" : `暂停到 ${clockText(plan.snoozeUntil, now)}`}
      </div>
    );
  }

  function nowLine(from: number, to: number) {
    if (now < from || now >= to) return null;
    return <div className="bebe-now" style={{ top: y(now, from) }} data-time={clock(now)} aria-label={`现在 ${clock(now)}`} />;
  }

  const fixedCard = (time: FixedTime & { at: number }, past: boolean) => (
    <div className={`bebe-fixed ${past ? "is-past" : ""}`} title="固定日程：跟着时段和 Settings「bebe」走">
      <time>{clock(time.at)}</time>
      <span>{time.label}</span>
      <Lock size={11} aria-label="只读" />
    </div>
  );

  const dayView = (
    <div className="bebe-day" style={{ height }}>
      <div className="bebe-gutter">{axis(day.from, true)}{periodStrips(day.from)}</div>
      <div className="bebe-lane">
        {axis(day.from, false)}
        {stacked(reminders.filter((item) => item.at >= day.from && item.at < day.to), day.from, REMINDER_HEIGHT).map((item) => (
          <button key={item.id} type="button" className={`bebe-reminder ${editing?.id === item.id ? "is-selected" : ""}`} style={{ top: item.top }} onClick={() => edit(item)} title="点一下在右边改时间或内容">
            <time>{clock(item.at)}</time>
            <span>{item.text}</span>
          </button>
        ))}
      </div>
      <div className="bebe-lane">
        {axis(day.from, false)}
        {stacked(fixedBetween(times, day.from, day.to), day.from, FIXED_HEIGHT).map((time) => (
          <div key={`${time.kind}-${time.at}`} className="bebe-pin" style={{ top: time.top }}>{fixedCard(time, time.at < now)}</div>
        ))}
      </div>
      <div className="bebe-lane is-bands">
        {axis(day.from, false)}
        {quietBands(day.from, day.to, false)}
        {snoozeBand(day.from, day.to, false)}
      </div>
      {nowLine(day.from, day.to)}
    </div>
  );

  const week = weekWindows(now, settings.periods);
  const weekView = (
    <div className="bebe-week" style={{ height }}>
      <div className="bebe-gutter">{axis(week[0].from, true)}</div>
      {week.map((window) => {
        const today = now >= window.from && now < window.to;
        const sleep = settings.periods.find((period) => period.id === "sleep");
        const sleepStart = sleep ? window.from + ((sleep.startHour - new Date(window.from).getHours() + 24) % 24) * 60 * MINUTE : null;
        return (
          <div key={window.from} className={`bebe-week-day ${today ? "is-today" : ""}`}>
            {axis(window.from, false)}
            {sleepStart !== null && <div className="bebe-sleep" style={{ top: y(sleepStart, window.from), height: Math.max(0, height - y(sleepStart, window.from)) }} />}
            {quietBands(window.from, window.to, true)}
            {snoozeBand(window.from, window.to, true)}
            {merged(fixedBetween(times, window.from, window.to)).map((group) => (
              <div key={group[0].at} className={`bebe-dot is-fixed ${group[0].at < now ? "is-past" : ""}`} style={{ top: y(group[0].at, window.from) }} title={group.map((time) => `${clock(time.at)} ${time.label}`).join("\n") + "\n（固定日程）"}>
                {group.map(shortLabel).join("·")}
              </div>
            ))}
            {reminders.filter((item) => item.at >= window.from && item.at < window.to).map((item) => (
              <button key={item.id} type="button" className={`bebe-dot is-reminder ${editing?.id === item.id ? "is-selected" : ""}`} style={{ top: y(item.at, window.from) }} onClick={() => edit(item)} title={`${clock(item.at)} ${item.text}`}>
                {clock(item.at)} {item.text}
              </button>
            ))}
            {today && nowLine(window.from, window.to)}
          </div>
        );
      })}
    </div>
  );

  const editor = editing && (
    <form className="bebe-edit" onSubmit={(event) => { event.preventDefault(); saveEditing(); }}>
      <div className="bebe-edit-row">
        <input type="time" value={editing.time} onChange={(event) => setEditing({ ...editing, time: event.target.value })} aria-label="提醒时间" required />
        <input value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} placeholder="提醒什么，例如：给导师回邮件" aria-label="提醒内容" autoFocus />
      </div>
      <p className="rule-help">只能设在未来 24 小时内；早于现在的时间算明天。</p>
      <div className="bebe-edit-actions">
        {editing.id && <button type="button" className="danger-button" onClick={() => remove(editing.id!)}><Trash2 size={14} /> 删除</button>}
        <span />
        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button>
        <button type="submit" className="primary-button" disabled={!editing.text.trim()}>保存</button>
      </div>
    </form>
  );

  return (
    <main className="workspace-scroll bebe-schedule">
      <div className="bebe-schedule-grid">
        <section className="bebe-timeline" aria-label={mode === "day" ? "今天的 bebe 安排" : "本周的 bebe 安排"}>
          <header className="bebe-timeline-head">
            <strong>{mode === "day" ? `今天 · ${dateLabel(day.from)}` : `本周 · ${dateLabel(week[0].from)} – ${dateLabel(week[6].from)}`}</strong>
            <div className="bebe-mode" role="group" aria-label="视图">
              <button type="button" className={mode === "day" ? "active" : ""} aria-pressed={mode === "day"} onClick={() => setMode("day")}>今天</button>
              <button type="button" className={mode === "week" ? "active" : ""} aria-pressed={mode === "week"} onClick={() => setMode("week")}>本周</button>
            </div>
          </header>
          {mode === "day" ? (
            <div className="bebe-lanes-head"><span /><span>一次性提醒</span><span>bebe 固定日程</span><span>安静 · 暂停</span></div>
          ) : (
            <div className="bebe-lanes-head is-week">
              <span />
              {week.map((window) => <span key={window.from} className={now >= window.from && now < window.to ? "is-today" : ""}>{dateLabel(window.from)}</span>)}
            </div>
          )}
          <div className="bebe-timeline-body">{mode === "day" ? dayView : weekView}</div>
        </section>

        <aside className="bebe-side">
          <section className="bebe-card">
            <h3>
              接下来 · {reminders.length}
              <button type="button" className="text-button" onClick={() => setEditing({ id: null, time: clock(now + 30 * MINUTE), text: "" })}><Plus size={14} /> 新提醒</button>
            </h3>
            {editing?.id === null && editor}
            {reminders.length === 0 && editing?.id !== null && <p className="settings-note">没有一次性提醒。在对话里说「三点提醒我…」，或点「新提醒」。</p>}
            <ul className="bebe-reminder-list">
              {reminders.map((item) => (
                <li key={item.id} className={editing?.id === item.id ? "is-editing" : ""}>
                  {editing?.id === item.id ? editor : (
                    <>
                      <time>{clockText(item.at, now)}</time>
                      <span title={item.text}>{item.text}</span>
                      <button type="button" className="icon-button" onClick={() => edit(item)} aria-label={`改 ${item.text}`} title="改"><Pencil size={14} /></button>
                      <button type="button" className="icon-button" onClick={() => remove(item.id)} aria-label={`删除 ${item.text}`} title="删除"><X size={14} /></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="bebe-card">
            <h3>暂停</h3>
            {snoozed && plan.snoozeUntil !== null ? (
              <div className="bebe-snooze">
                <Pause size={14} aria-hidden="true" />
                <span>暂停到 {clockText(plan.snoozeUntil, now)}</span>
                <button type="button" className="secondary-button" onClick={() => onPlanChange({ ...plan, snoozeUntil: null })}>取消暂停</button>
              </div>
            ) : (
              <p className="settings-note">没有暂停。在对话里说「安静一小时」就会暂停。</p>
            )}
            <p className="rule-help">暂停和安静时段只挡摸鱼提醒、分类询问、习惯提醒和「为什么没完成」；一次性提醒和晚间总结照常。</p>
          </section>

          <section className="bebe-card">
            <h3>安静时段 · {settings.pet.quietHours.length}</h3>
            <QuietHoursEditor quietHours={settings.pet.quietHours} onChange={onQuietHoursChange} selected={selectedQuiet} />
            {quietError && <p className="inline-error" role="alert">{quietError}</p>}
          </section>

          <section className="bebe-card">
            <h3>bebe 固定日程 <Lock size={12} aria-label="只读" /></h3>
            <ul className="bebe-fixed-list">
              {times.map((time) => <li key={`${time.kind}-${time.minute}`}><time>{pad(Math.floor(time.minute / 60))}:{pad(time.minute % 60)}</time><span>{time.label}</span></li>)}
            </ul>
            <p className="rule-help">跟着时段和 Settings「bebe」走：询问在时段结束前 15 分钟，晚间总结在睡眠前 {settings.pet.summaryLeadMinutes} 分钟。</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
