import { useDroppable } from "@dnd-kit/core";
import { useEffect, useId, useRef, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import {
  GREY,
  addMonths,
  barHeight,
  chainOf,
  daysInMonth,
  eventColor,
  ganttRows,
  groupOf,
  md,
  monthSpan,
  monthStart,
  nameOf,
  parseDate,
  projectColor,
  projectsOnEvent,
  rowKeyOf,
  rowOfEvent,
  type BoardEvent,
  type Project,
} from "../boardEvents";

/** 64px per month, 172px sticky left column, 12 months back and 18 forward (this one included). */
const COL = 64;
const LABEL = 172;
const MONTHS = 31;
const BACK = 12;

const xAt = (from: Date, date: string | Date) => {
  const day = typeof date === "string" ? parseDate(date) : date;
  return (monthSpan(from, day) + (day.getDate() - 1) / daysInMonth(day)) * COL;
};

/** Rounded corners on an orthogonal polyline, used by the chain arrows. */
function roundedPath(points: Array<[number, number]>, radius: number) {
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [previousX, previousY] = points[index - 1];
    const [x, y] = points[index];
    const [nextX, nextY] = points[index + 1];
    const first = Math.hypot(x - previousX, y - previousY);
    const second = Math.hypot(nextX - x, nextY - y);
    const corner = Math.min(radius, first / 2, second / 2);
    path += ` L${x - ((x - previousX) / first) * corner},${y - ((y - previousY) / first) * corner}`;
    path += ` Q${x},${y} ${x + ((nextX - x) / second) * corner},${y + ((nextY - y) / second) * corner}`;
  }
  const [lastX, lastY] = points[points.length - 1];
  return `${path} L${lastX},${lastY}`;
}

/** What a scroll request asks for: one event's bar centred, or a month aligned to the left edge. */
export interface GanttScroll { nonce: number; month: Date; eventId?: string }

/** An event shape the project tray can drop onto; `data.eventId` tells the drop handler which one. */
function DroppableButton({ eventId, droppableId, className, ...rest }: { eventId: string; droppableId: string } & ComponentPropsWithoutRef<"button">) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId, data: { eventId } });
  return <button ref={setNodeRef} type="button" className={`${className ?? ""} ${isOver ? "is-drop" : ""}`} {...rest} />;
}

export function BoardGantt({ events, projects, projectFamilies, dark, selected, collapsed, onSelect, onToggle, scroll }: {
  events: BoardEvent[];
  projects: Project[];
  projectFamilies: string[];
  dark: boolean;
  selected: string | null;
  collapsed: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  scroll: GanttScroll;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const today = new Date();
  const from = addMonths(monthStart(today), -BACK);
  const width = MONTHS * COL;
  const rows = ganttRows(events, projects, projectFamilies, collapsed, dark);
  const height = rows.reduce((sum, row) => sum + row.height, 0);

  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const event = scroll.eventId ? events.find((item) => item.id === scroll.eventId) : undefined;
    if (event) {
      box.scrollLeft = Math.max(0, LABEL + xAt(from, event.date) - box.clientWidth / 2);
      const bar = Array.from(box.querySelectorAll<HTMLElement>("[data-ev]")).find((element) => element.dataset.ev === event.id);
      const row = bar?.closest<HTMLElement>(".ms-grow");
      if (row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
      return;
    }
    box.scrollLeft = Math.max(0, Math.min(monthSpan(from, scroll.month) * COL - 8, box.scrollWidth - box.clientWidth));
    // 只在收到新的滚动请求时重算；行高变化不抢用户的横向位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll]);

  /** One event's shape inside a row, positioned by the shared month scale. */
  function shape(event: BoardEvent, mid: number) {
    const chain = projectsOnEvent(event.id, events, projects);
    const color = eventColor(event, events, projects, projectFamilies, dark);
    const x = xAt(from, event.date);
    const isSelected = selected === event.id;
    const common = { "data-ev": event.id, className: `ms-ev ${isSelected ? "sel" : ""}` } as const;
    if (event.shape === "span") {
      const bar = barHeight(chain.length);
      const top = mid - bar / 2;
      const end = event.end ? xAt(from, event.end) : x + COL * 1.5;
      const stripe = event.dateEst || event.endEst ? "ms-est-stripe" : "";
      const split = chain.length > 1;
      return (
        <>
          <DroppableButton
            {...common}
            eventId={event.id}
            droppableId={`event:${event.id}:bar`}
            aria-label={`${event.title}${event.end ? "" : "，通知未定"}`}
            className={`${common.className} ms-bar ${stripe}`}
            style={{ left: x, width: Math.max(6, end - x), top, height: bar, background: split ? "transparent" : chain.length ? color : GREY }}
            onClick={() => onSelect(event.id)}
          >
            {split && (
              <span className="ms-split">
                {chain.map((project) => (
                  <i key={project.id} className={stripe.trim()} style={{ backgroundColor: projectColor(project, projects, projectFamilies, dark) }} />
                ))}
              </span>
            )}
          </DroppableButton>
          {event.end ? (
            <span className="ms-dlabel end" style={{ left: end, top: top - 12 }}>{md(event.end, event.endEst)}</span>
          ) : (
            <>
              <span className="ms-fade" style={{ left: end, width: COL * 1.5, top, height: bar, background: `linear-gradient(90deg, ${chain.length ? color : GREY}, transparent)` }} />
              <span className="ms-dlabel" style={{ left: end + 6, top: top - 12 }}>通知未定</span>
            </>
          )}
          <DroppableButton
            {...common}
            eventId={event.id}
            droppableId={`event:${event.id}:dia`}
            aria-label={`${event.title} 截止 ${event.date}`}
            className={`${common.className} ms-dia ${event.dateEst ? "est" : ""}`}
            style={{ left: x, top: mid, background: chain.length ? color : GREY, borderColor: event.dateEst ? (chain.length ? color : GREY) : "var(--panel)" }}
            onClick={() => onSelect(event.id)}
          />
          <span className="ms-dlabel" style={{ left: x + 7, top: top - 12 }}>{md(event.date, event.dateEst)}</span>
        </>
      );
    }
    return (
      <>
        <DroppableButton
          {...common}
          eventId={event.id}
          droppableId={`event:${event.id}:pt`}
          aria-label={`${event.title} ${event.date}`}
          className={`${common.className} ms-pt ${event.dateEst ? "est" : ""}`}
          style={{ left: x, top: mid, background: color, borderColor: event.dateEst ? color : "var(--panel)" }}
          onClick={() => onSelect(event.id)}
        />
        <span className="ms-dlabel" style={{ left: x + 8, top: mid - 14 }}>{event.title.replace(/ \d{4}$/, "")} {md(event.date, event.dateEst)}</span>
      </>
    );
  }

  /** S-shaped arrows from each event to its 下一站; a cross-group grey link becomes a short one with a label. */
  function arrows() {
    const paths: Array<{ d: string; color: string; key: string }> = [];
    const short: Array<{ x: number; y: number; title: string; key: string }> = [];
    for (const event of events) {
      if (!event.next) continue;
      const target = events.find((item) => item.id === event.next);
      if (!target) continue;
      const sourceRow = rowOfEvent(rows, event, projects);
      const targetRow = rowOfEvent(rows, target, projects);
      if (!sourceRow || !targetRow) continue;
      const y1 = sourceRow.y + sourceRow.height / 2;
      const y2 = targetRow.y + targetRow.height / 2;
      const x1 = event.shape === "span" ? (event.end ? xAt(from, event.end) : xAt(from, event.date) + COL * 1.5) : xAt(from, event.date) + 6;
      const tip = xAt(from, target.date) - 9;
      const shared = projectsOnEvent(event.id, events, projects).find((project) => projectsOnEvent(target.id, events, projects).includes(project));
      const color = shared ? projectColor(shared, projects, projectFamilies, dark) : "#9aa0a6";
      if (!shared && groupOf(rows, sourceRow) !== groupOf(rows, targetRow)) {
        short.push({ x: x1, y: y1, title: target.title, key: event.id });
        continue;
      }
      const lane = y2 > y1 ? sourceRow.y + sourceRow.height : sourceRow.y;
      const points: Array<[number, number]> = tip - x1 >= 42
        ? [[x1, y1], [Math.round((x1 + tip) / 2), y1], [Math.round((x1 + tip) / 2), y2], [tip, y2]]
        : [[x1, y1], [x1 + 12, y1], [x1 + 12, lane], [tip - 12, lane], [tip - 12, y2], [tip, y2]];
      paths.push({ d: roundedPath(points, 6), color, key: event.id });
    }
    return { paths, short };
  }

  const months = Array.from({ length: MONTHS }, (_, index) => addMonths(from, index));
  const current = monthSpan(from, today);
  const { paths, short } = arrows();
  const colors = [...new Set(paths.map((path) => path.color).concat(short.length ? ["#9aa0a6"] : []))];
  const markerId = (color: string) => `${marker}-ah-${color.replace("#", "")}`;

  return (
    <div className="ms-view" data-view="gantt">
      <div className="ms-sec-head">
        <strong>甘特</strong>
        <span className="ms-hint">{isoMonth(from)} → {isoMonth(addMonths(from, MONTHS - 1))} · 横向拖滑条；超过约 20 行内部纵向滚动</span>
        <span className="ms-sp" />
      </div>
      <div className="ms-gwrap" ref={wrap}>
        <div className="ms-gantt" style={{ width: LABEL + width }}>
          <div className="ms-ghead" style={{ width: LABEL + width }}>
            <div className="ms-glabel">project / venue</div>
            <div className="ms-gtrack" style={{ width }}>
              {months.map((month, index) => (
                <div key={index}>
                  <div className={`ms-mcell ${index === current ? "cur" : ""}`} style={{ left: index * COL, width: COL }} />
                  {(month.getMonth() === 0 || index === 0) && <span className="ms-yname" style={{ left: index * COL }}>{month.getFullYear()}</span>}
                  <span className={`ms-mname ${index === current ? "cur" : ""}`} style={{ left: index * COL }}>{month.getMonth() + 1}月</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ position: "relative", width: LABEL + width, height }}>
            {rows.map((row, index) => {
              if (row.kind === "band") {
                return (
                  <div
                    key={`band-${row.label}-${index}`}
                    className="ms-band"
                    style={{ top: row.y, height: row.height, width: LABEL + width, background: `color-mix(in srgb, ${row.color} ${row.grey ? 7 : 12}%, var(--panel))`, color: row.color }}
                  >
                    <span className="ms-inner"><span className="ms-edge" style={{ background: row.color }} />{row.label}<span className="ms-count">{row.count}</span></span>
                  </div>
                );
              }
              if (row.kind === "project") {
                const color = projectColor(row.project, projects, projectFamilies, dark);
                const lane = `color-mix(in srgb, ${color} 10%, var(--panel))`;
                const own = events.filter((event) => event.tags[0] === row.project.tag);
                return (
                  <div key={`project-${row.project.id}`} className={`ms-grow ms-prow ${row.collapsed ? "collapsed" : ""} ${selected === row.project.id ? "sel" : ""}`} style={{ top: row.y, height: row.height, width: LABEL + width, background: lane }}>
                    <div className="ms-glabel" style={{ background: lane }}>
                      <button type="button" className="ms-toggle" aria-label={row.collapsed ? "展开" : "折叠"} aria-expanded={!row.collapsed} onClick={() => onToggle(row.project.id)}>▸</button>
                      <i className="ms-sw" style={{ background: color }} />
                      <button type="button" className="ms-name" style={nameButton} onClick={() => onSelect(row.project.id)}>{nameOf(row.project.tag)}</button>
                      <span className="ms-sub">{chainOf(row.project, events).length} 站</span>
                    </div>
                    <div className="ms-gtrack" style={{ width }}>{own.map((event) => <span key={event.id}>{shape(event, row.height / 2)}</span>)}</div>
                  </div>
                );
              }
              const parent = row.parentProject ? projects.find((project) => project.id === row.parentProject) : null;
              const lane = parent ? `color-mix(in srgb, ${projectColor(parent, projects, projectFamilies, dark)} 5%, var(--panel))` : "var(--panel)";
              const edge = parent ? projectColor(parent, projects, projectFamilies, dark) : "var(--line)";
              return (
                <div key={`venue-${row.key}`} className="ms-grow ms-vrow" style={{ top: row.y, height: row.height, width: LABEL + width, background: lane }}>
                  <div className="ms-glabel" style={{ background: lane }} title={row.key}>
                    <span className="ms-edge" style={{ background: edge }} />
                    <span className="ms-name">{nameOf(row.key)}</span>
                    {parent && <span className="ms-sub">{row.key.split("/")[0]}</span>}
                  </div>
                  <div className="ms-gtrack" style={{ width }}>{events.filter((event) => rowKeyOf(event, projects) === row.key).map((event) => <span key={event.id}>{shape(event, row.height / 2)}</span>)}</div>
                </div>
              );
            })}
            <svg style={{ position: "absolute", left: LABEL, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 3 }} width={width} height={height}>
              <defs>
                {colors.map((color) => (
                  <marker key={color} id={markerId(color)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M0,0 L10,5 L0,10 L3,5 z" fill={color} />
                  </marker>
                ))}
              </defs>
              {paths.map((path) => (
                <g key={path.key}>
                  <path d={path.d} fill="none" stroke="var(--panel)" strokeWidth={4} strokeLinejoin="round" opacity={0.9} />
                  <path d={path.d} fill="none" stroke={path.color} strokeWidth={1.6} strokeLinejoin="round" markerEnd={`url(#${markerId(path.color)})`} />
                </g>
              ))}
              {short.map((item) => (
                <g key={`short-${item.key}`}>
                  <path d={`M${item.x},${item.y} L${item.x + 22},${item.y}`} fill="none" stroke="#9aa0a6" strokeWidth={1.6} markerEnd={`url(#${markerId("#9aa0a6")})`} />
                  <text x={item.x + 26} y={item.y + 3} fontSize={9} fill="var(--muted)" paintOrder="stroke" stroke="var(--panel)" strokeWidth={3}>→ {item.title}</text>
                </g>
              ))}
            </svg>
            <div className="ms-tline" style={{ left: LABEL + xAt(from, today), height }}>
              <span>今天</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const nameButton: CSSProperties = { padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" };
const isoMonth = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
