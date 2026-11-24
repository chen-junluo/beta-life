import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Lock, Pause, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { hourLabel, orderedPeriods } from "../boardLogic";
import {
  DEFAULT_PERSONAL_TAG,
  GREY_INK,
  addDays,
  addMonths,
  eventAt,
  eventColor,
  iso,
  md,
  monthStart,
  parseDate,
  type BoardEvent,
  type EventFile,
  type Project,
} from "../boardEvents";
import { clockText, isSnoozed, type PetPlan } from "../pet/plan";
import { WEEKDAYS } from "../pet/reminders";
import { dayWindow, fixedBetween, fixedTimes, quietBetween, weekWindows, type FixedTime } from "../pet/schedule";
import type { AppSettings, QuietHours } from "../types";
import { BoardEventEditor } from "./BoardEventEditor";
import { BoardGantt, type GanttScroll } from "./BoardGantt";
import { BoardMilestone } from "./BoardMilestone";
import { BoardProjectEditor } from "./BoardProjectEditor";
import { BoardLegend, ProjectTray } from "./BoardTray";
import { lookupAvailable } from "../ai/eventTools";
import { QuietHoursEditor } from "./BebeSettings";

const MINUTE = 60_000;
/** Both the day and the week columns share one vertical scale. */
const PX_PER_MINUTE = 0.56;
const REMINDER_HEIGHT = 40;
const FIXED_HEIGHT = 28;
const UPCOMING_DAYS = 30;

type Mode = "day" | "week" | "milestone" | "gantt";
/** What the right column is editing: an event draft, or a project. */
type Choice = { kind: "event" | "project"; id: string } | null;

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const dateLabel = (at: number) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAYS[(date.getDay() + 6) % 7].label}`;
};
const shortLabel = (time: FixedTime) => (time.kind === "ask" ? time.label.slice(1, 3) : time.kind === "summary" ? "总结" : "存档");

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

/** Tops for items sorted by time, pushed down so cards closer than their height do not overlap. */
function stacked<T extends { at: number }>(items: T[], from: number, height: number): Array<T & { top: number }> {
  let next = -Infinity;
  return items.map((item) => {
    const top = Math.max((item.at - from) / MINUTE * PX_PER_MINUTE - 10, next);
    next = top + height + 4;
    return { ...item, top };
  });
}

function blankEvent(date: string, time: string | null = null): BoardEvent {
  const ms = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    note: "",
    shape: "point",
    date,
    dateEst: false,
    end: null,
    endEst: false,
    time,
    tags: [DEFAULT_PERSONAL_TAG],
    next: null,
    remind: { onDay: true, daysBefore: [] },
    done: false,
    createdAt: ms,
    updatedAt: ms,
  };
}

/**
 * The time board's bebe tab: 今天 / 本周 read the events that carry a clock time, milestone is a month
 * calendar and gantt draws the 30-month plan. Both new views share the month, the selection and which
 * projects are folded; everything is edited in the right column.
 */
export function BebeScheduleView({ settings, plan, onPlanChange, onQuietHoursChange, quietError, file, onFileChange, knownTags, onLookup }: {
  settings: AppSettings;
  plan: PetPlan;
  onPlanChange: (plan: PetPlan) => void;
  onQuietHoursChange: (quietHours: QuietHours[]) => void;
  quietError: string | null;
  file: EventFile;
  onFileChange: (file: EventFile) => void;
  knownTags: string[];
  /** 「bebe 查官网」: the AI searches the venue's official dates and stages an update_event. */
  onLookup: (event: BoardEvent) => void;
}) {
  const [mode, setMode] = useState<Mode>("day");
  const [now, setNow] = useState(() => Date.now());
  const [viewMonth, setViewMonth] = useState(() => monthStart(new Date()));
  const [choice, setChoice] = useState<Choice>(null);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<BoardEvent | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [selectedQuiet, setSelectedQuiet] = useState<number | null>(null);
  const [scroll, setScroll] = useState<GanttScroll>(() => ({ nonce: 1, month: monthStart(new Date()) }));
  // 4px 才算拖，否则点一下 chip 就变成拖拽、选不中 project
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const events = file.events;
  const projects = file.projects;
  const projectFamilies = settings.projectFamilies;
  const periods = useMemo(() => orderedPeriods(settings), [settings]);
  const times = useMemo(() => fixedTimes(settings.periods, settings.pet), [settings.periods, settings.pet]);
  const snoozed = isSnoozed(plan, now);
  const day = dayWindow(now, settings.periods);
  const height = 24 * 60 * PX_PER_MINUTE;
  const y = (at: number, from: number) => (at - from) / MINUTE * PX_PER_MINUTE;
  const dark = usePrefersDark();
  const timed = events.filter((event) => event.shape === "point" && event.time);
  const tagColors = new Map(events.map((event) => [event.id, eventColor(event, events, projects, projectFamilies, dark)]));

  function go(next: Mode) {
    setMode(next);
    if (next === "gantt") setScroll((current) => ({ nonce: current.nonce + 1, month: viewMonth }));
  }

  function selectEvent(event: BoardEvent, options: { fromCalendar?: boolean } = {}) {
    setChoice({ kind: "event", id: event.id });
    setDraft({ ...event });
    setDraftIsNew(false);
    const month = monthStart(parseDate(event.date));
    setViewMonth(month);
    if (options.fromCalendar) {
      setMode("gantt");
      setScroll((current) => ({ nonce: current.nonce + 1, month, eventId: event.id }));
    }
  }

  function selectProject(id: string) {
    setChoice({ kind: "project", id });
    setOpenProject(id);
    setDraft(null);
    setDraftIsNew(false);
  }

  function selectById(id: string) {
    if (projects.some((project) => project.id === id)) selectProject(id);
    else {
      const event = events.find((item) => item.id === id);
      if (event) selectEvent(event);
    }
  }

  function createOn(date: string) {
    const at = new Date();
    const soon = new Date(at.getTime() + 30 * MINUTE);
    setChoice(null);
    setDraft(blankEvent(date, date === iso(at) ? clock(soon.getTime()) : null));
    setDraftIsNew(true);
  }

  function patch(patchValue: Partial<BoardEvent>) {
    setDraft((current) => (current ? { ...current, ...patchValue } : current));
  }

  function saveDraft() {
    if (!draft || !draft.title.trim()) return;
    const event = { ...draft, updatedAt: Date.now() };
    onFileChange({ ...file, events: [...file.events.filter((item) => item.id !== event.id), event] });
    setDraft(event);
    setDraftIsNew(false);
    setChoice({ kind: "event", id: event.id });
  }

  /** 查官网 needs the event saved first: the AI answers with `update_event` on its id. */
  function lookupDraft() {
    if (!draft || !draft.title.trim()) return;
    const event = { ...draft, title: draft.title.trim(), updatedAt: Date.now() };
    onFileChange({ ...file, events: [...file.events.filter((item) => item.id !== event.id), event] });
    setDraft(event);
    setDraftIsNew(false);
    setChoice({ kind: "event", id: event.id });
    onLookup(event);
  }

  function deleteDraft() {
    if (!draft) return;
    onFileChange({ ...file, events: file.events.filter((item) => item.id !== draft.id) });
    setDraft(null);
    setChoice(null);
  }

  function saveProject(next: Project) {
    const previous = file.projects.find((project) => project.id === next.id);
    // 改名 / 换分类会改 tag，事件跟着换，不然整条 chain 会掉回灰色
    const renamed = previous && previous.tag !== next.tag;
    const events = renamed
      ? file.events.map((event) => (event.tags[0] === previous.tag ? { ...event, tags: [next.tag, ...event.tags.slice(1)], updatedAt: Date.now() } : event))
      : file.events;
    onFileChange({ ...file, events, projects: [...file.projects.filter((project) => project.id !== next.id), next] });
  }

  function colorProject(id: string, color: string | null) {
    onFileChange({
      ...file,
      projects: file.projects.map((project) => (project.id === id ? { ...project, color, updatedAt: Date.now() } : project)),
    });
  }

  function deleteProject(id: string) {
    onFileChange({ ...file, projects: file.projects.filter((project) => project.id !== id) });
    setChoice(null);
    setOpenProject(null);
  }

  /** Dropping a project on an event makes it that chain's head; dropping it back on the tray clears it. */
  function dropProject({ active, over }: DragEndEvent) {
    if (!over) return;
    const projectId = String(active.id).replace(/^project:/, "");
    const eventId = over.data.current?.eventId as string | undefined;
    onFileChange({
      ...file,
      projects: file.projects.map((project) => (project.id === projectId ? { ...project, head: eventId ?? null, updatedAt: Date.now() } : project)),
    });
  }

  function createProject(tag: string) {
    const project: Project = { id: crypto.randomUUID(), tag, head: null, priority: 5, color: null, note: "", updatedAt: Date.now() };
    onFileChange({ ...file, projects: [...file.projects, project] });
    selectProject(project.id);
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
        title={`安静 ${clock(range.start)}–${clock(range.end)}：只挡摸鱼提醒、分类询问和习惯提醒。点一下在右边改`}
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
        {stacked(timed.map((event) => ({ at: eventAt(event), event })).filter((item) => item.at >= day.from && item.at < day.to), day.from, REMINDER_HEIGHT).map(({ top, event }) => (
          <button
            key={event.id}
            type="button"
            className={`bebe-reminder ${choice?.kind === "event" && choice.id === event.id ? "is-selected" : ""}`}
            style={{ top, borderLeftColor: tagColors.get(event.id) }}
            onClick={() => selectEvent(event)}
            title="点一下在右边改"
          >
            <time>{event.time}</time>
            <span>{event.title}</span>
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
            {timed.filter((event) => eventAt(event) >= window.from && eventAt(event) < window.to).map((event) => (
              <button
                key={event.id}
                type="button"
                className={`bebe-dot is-reminder ${choice?.kind === "event" && choice.id === event.id ? "is-selected" : ""}`}
                style={{ top: y(eventAt(event), window.from) }}
                onClick={() => selectEvent(event)}
                title={`${event.time} ${event.title}`}
              >
                {event.time} {event.title}
              </button>
            ))}
            {today && nowLine(window.from, window.to)}
          </div>
        );
      })}
    </div>
  );

  const editor = choice?.kind === "project" ? (
    <BoardProjectEditor
      projects={projects}
      events={events}
      projectFamilies={projectFamilies}
      dark={dark}
      selected={choice?.kind === "project" ? choice.id : null}
      openId={openProject}
      onOpen={setOpenProject}
      onSelect={(id) => { setChoice({ kind: "project", id }); setDraft(null); }}
      onSave={saveProject}
      onDelete={deleteProject}
      onCreate={createProject}
      onColor={colorProject}
    />
  ) : draft ? (
    <BoardEventEditor
      draft={draft}
      isNew={draftIsNew}
      events={events}
      projects={projects}
      settings={settings}
      knownTags={knownTags}
      lookup={lookupAvailable(settings.ai)}
      onPatch={patch}
      onSave={saveDraft}
      onDelete={deleteDraft}
      onLookup={lookupDraft}
      onCancel={() => { setDraft(null); setChoice(null); }}
    />
  ) : (
    <>
      <div className="ms-eyebrow">事项 · 新建</div>
      <p className="ms-empty">点月历格子新建，或在甘特上点事项编辑。</p>
      <button type="button" className="primary-button" onClick={() => createOn(iso(new Date()))}><Plus size={14} /> 新事项</button>
    </>
  );

  const monthTitle = `${viewMonth.getFullYear()} 年 ${viewMonth.getMonth() + 1} 月`;
  const isEventsView = mode === "milestone" || mode === "gantt";

  return (
    <DndContext sensors={sensors} onDragEnd={dropProject}>
      <main className={`workspace-scroll bebe-schedule ${isEventsView ? "is-events" : ""}`}>
        <div className="bebe-schedule-grid">
          <section className="bebe-timeline" aria-label="bebe 的安排与事项">
            <header className="bebe-timeline-head">
              <strong>
                {mode === "day" ? `今天 · ${dateLabel(day.from)}`
                  : mode === "week" ? `本周 · ${dateLabel(week[0].from)} – ${dateLabel(week[6].from)}`
                    : mode === "milestone" ? monthTitle
                      : "甘特"}
              </strong>
              <div className="bebe-mode" role="group" aria-label="视图">
                <button type="button" className={mode === "day" ? "active" : ""} aria-pressed={mode === "day"} onClick={() => go("day")}>今天</button>
                <button type="button" className={mode === "week" ? "active" : ""} aria-pressed={mode === "week"} onClick={() => go("week")}>本周</button>
                <button type="button" className={mode === "milestone" ? "active" : ""} aria-pressed={mode === "milestone"} onClick={() => go("milestone")}>milestone</button>
                <button type="button" className={mode === "gantt" ? "active" : ""} aria-pressed={mode === "gantt"} onClick={() => go("gantt")}>gantt</button>
              </div>
            </header>

            {mode === "day" || mode === "week" ? (
              <>
                {mode === "day" ? (
                  <div className="bebe-lanes-head"><span /><span>事项</span><span>bebe 固定日程</span><span>安静 · 暂停</span></div>
                ) : (
                  <div className="bebe-lanes-head is-week">
                    <span />
                    {week.map((window) => <span key={window.from} className={now >= window.from && now < window.to ? "is-today" : ""}>{dateLabel(window.from)}</span>)}
                  </div>
                )}
                <div className="bebe-timeline-body">{mode === "day" ? dayView : weekView}</div>
              </>
            ) : (
              <>
                {mode === "milestone" ? (
                  <BoardMilestone
                    events={events}
                    projects={projects}
                    projectFamilies={projectFamilies}
                    dark={dark}
                    viewMonth={viewMonth}
                    selected={choice?.id ?? null}
                    onSelectEvent={(id) => {
                      const event = events.find((item) => item.id === id);
                      if (event) selectEvent(event, { fromCalendar: true });
                    }}
                    onSelectDate={createOn}
                    onShiftMonth={(months) => {
                      if (months === 0) setViewMonth(monthStart(new Date()));
                      else setViewMonth((current) => addMonths(current, months));
                    }}
                  />
                ) : null}
                {mode === "gantt" && (
                  <BoardGantt
                    events={events}
                    projects={projects}
                    projectFamilies={projectFamilies}
                    dark={dark}
                    selected={choice?.id ?? null}
                    collapsed={collapsed}
                    onSelect={selectById}
                    onToggle={(id) => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })}
                    scroll={scroll}
                  />
                )}
                <ProjectTray
                  projects={projects}
                  projectFamilies={projectFamilies}
                  dark={dark}
                  selected={choice?.kind === "project" ? choice.id : null}
                  hint={mode === "gantt" ? "拖到某个事项上 = 它做 chain 起点，沿实线往后整条染色" : "点 project 打开编辑 · 切到 gantt 可以拖到事项上"}
                  onSelect={selectProject}
                />
                <BoardLegend />
              </>
            )}
          </section>

          <aside className="bebe-side">
            <section className="bebe-card">{editor}</section>

            <section className="bebe-card">
              <h3>接下来 · {UPCOMING_DAYS} 天</h3>
              {snoozed && plan.snoozeUntil !== null && (
                <div className="bebe-snooze">
                  <Pause size={14} aria-hidden="true" />
                  <span>暂停到 {clockText(plan.snoozeUntil, now)}</span>
                  <button type="button" className="secondary-button" onClick={() => onPlanChange({ ...plan, snoozeUntil: null })}>取消暂停</button>
                </div>
              )}
              <Upcoming
                events={events}
                projects={projects}
                projectFamilies={projectFamilies}
                dark={dark}
                now={now}
                times={times}
                selected={choice?.kind === "event" ? choice.id : null}
                onSelect={(event) => selectEvent(event)}
              />
            </section>

            {!isEventsView && (
              <>
                <section className="bebe-card">
                  <h3>安静时段 · {settings.pet.quietHours.length}</h3>
                  <QuietHoursEditor quietHours={settings.pet.quietHours} onChange={onQuietHoursChange} selected={selectedQuiet} />
                  {quietError && <p className="inline-error" role="alert">{quietError}</p>}
                  <p className="rule-help">暂停和安静时段只挡摸鱼提醒、分类询问和习惯提醒；事项提醒和晚间总结照常。</p>
                </section>
                <section className="bebe-card">
                  <details className="ms-fixed">
                    <summary><h3>bebe 固定日程 <Lock size={12} aria-label="只读" /></h3></summary>
                    <ul className="bebe-fixed-list">
                      {times.map((time) => <li key={`${time.kind}-${time.minute}`}><time>{pad(Math.floor(time.minute / 60))}:{pad(time.minute % 60)}</time><span>{time.label}</span></li>)}
                    </ul>
                    <p className="rule-help">跟着时段和 Settings「bebe」走：询问在时段结束前 15 分钟，晚间总结在睡眠前 {settings.pet.summaryLeadMinutes} 分钟。</p>
                  </details>
                </section>
              </>
            )}
          </aside>
        </div>
      </main>
    </DndContext>
  );
}

/** The next 30 days' events, with today's fixed times folded in (they are read only). */
function Upcoming({ events, projects, projectFamilies, dark, now, times, selected, onSelect }: {
  events: BoardEvent[];
  projects: Project[];
  projectFamilies: string[];
  dark: boolean;
  now: number;
  times: FixedTime[];
  selected: string | null;
  onSelect: (event: BoardEvent) => void;
}) {
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const until = addDays(new Date(from), UPCOMING_DAYS).getTime();
  const tomorrow = addDays(new Date(from), 1).getTime();
  const rows: Array<{ key: string; when: string; label: string; color: string | null; at: number; event?: BoardEvent }> = [];

  for (const event of events) {
    if (event.done) continue;
    const at = eventAt(event);
    if (at < from || at > until) continue;
    rows.push({ key: event.id, when: `${event.date === iso(today) ? "今天" : md(event.date, event.dateEst)}${event.time ? ` ${event.time}` : ""}`, label: event.title, color: eventColor(event, events, projects, projectFamilies, dark), at, event });
  }
  for (const time of fixedBetween(times, from, tomorrow)) {
    rows.push({ key: `${time.kind}-${time.at}`, when: clock(time.at), label: time.label, color: null, at: time.at });
  }
  rows.sort((a, b) => a.at - b.at);

  if (rows.length === 0) return <p className="ms-empty">接下来 {UPCOMING_DAYS} 天没有事项。</p>;
  return (
    <div className="ms-up-list">
      {rows.map(({ event, ...row }) => event ? (
        <button key={row.key} type="button" className="ms-up" aria-pressed={selected === event.id} onClick={() => onSelect(event)}>
          <span className="ms-when">{row.when}</span>
          <span className="ms-t"><i className="ms-tagdot" style={{ background: row.color ?? GREY_INK }} />{row.label}</span>
        </button>
      ) : (
        <div key={row.key} className="ms-up is-fixed" title="固定日程，只读">
          <span className="ms-when">{row.when}</span>
          <span className="ms-t"><Lock size={10} className="ms-lock" />{row.label}</span>
        </div>
      ))}
    </div>
  );
}

/** `prefers-color-scheme` decides which set of family colours the board uses. */
function usePrefersDark() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const listener = () => setDark(list.matches);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  }, []);
  return dark;
}
