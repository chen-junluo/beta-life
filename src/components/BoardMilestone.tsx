import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, daysInMonth, eventColor, iso, type BoardEvent, type Project } from "../boardEvents";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** Everything a day cell shows: a span's 截止 and 通知, a point's due (with its clock when it has one). */
function itemsOn(date: string, events: BoardEvent[], projects: Project[], projectFamilies: string[], dark: boolean) {
  const items: Array<{ id: string; label: string; color: string; done: boolean }> = [];
  for (const event of events) {
    const color = eventColor(event, events, projects, projectFamilies, dark);
    if (event.date === date) {
      const mark = event.shape === "span" ? "◆ " : event.time ? `${event.time} ` : "● ";
      items.push({ id: event.id, label: `${event.dateEst ? "~" : ""}${mark}${event.title}${event.shape === "span" ? " 截止" : ""}`, color, done: event.done });
    }
    if (event.shape === "span" && event.end === date) {
      items.push({ id: event.id, label: `${event.endEst ? "~" : ""}○ ${event.title} 通知`, color, done: false });
    }
  }
  return items;
}

/**
 * The month grid: a point shows on its due date, a span on its 截止 (◆) and 通知 (○) days only.
 * A pill selects the event and hands it to the gantt; an empty cell starts a new event on that day.
 */
export function BoardMilestone({ events, projects, projectFamilies, dark, viewMonth, selected, onSelectEvent, onSelectDate, onShiftMonth }: {
  events: BoardEvent[];
  projects: Project[];
  projectFamilies: string[];
  dark: boolean;
  viewMonth: Date;
  selected: string | null;
  onSelectEvent: (id: string) => void;
  onSelectDate: (date: string) => void;
  onShiftMonth: (months: number) => void;
}) {
  const today = iso(new Date());
  const offset = (viewMonth.getDay() + 6) % 7;
  const cells: Date[] = [];
  for (let index = 0; index < offset; index += 1) cells.push(addDays(viewMonth, index - offset));
  for (let day = 1; day <= daysInMonth(viewMonth); day += 1) cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day));
  while (cells.length % 7) cells.push(addDays(cells[cells.length - 1], 1));

  return (
    <div className="ms-view" data-view="milestone">
      <div className="ms-sec-head">
        <button type="button" className="ms-icon-btn" aria-label="上个月" onClick={() => onShiftMonth(-1)}><ChevronLeft size={13} /></button>
        <strong>{viewMonth.getFullYear()} 年 {viewMonth.getMonth() + 1} 月</strong>
        <button type="button" className="ms-icon-btn" aria-label="下个月" onClick={() => onShiftMonth(1)}><ChevronRight size={13} /></button>
        <button type="button" className="ms-icon-btn" onClick={() => onShiftMonth(0)}>回到本月</button>
        <span className="ms-sp" />
        <span className="ms-hint">点格子新建 · 点事项编辑 · ◆ 截止 · ○ 通知 · ● 单点</span>
      </div>
      <div className="ms-cal" role="grid" aria-label={`${viewMonth.getFullYear()} 年 ${viewMonth.getMonth() + 1} 月`}>
        {WEEK.map((day) => <div key={day} className="ms-dh" role="columnheader">{day}</div>)}
        {cells.map((date) => {
          const key = iso(date);
          const items = itemsOn(key, events, projects, projectFamilies, dark);
          const out = date.getMonth() !== viewMonth.getMonth();
          return (
            <div
              key={key}
              role="gridcell"
              className={`ms-cell ${out ? "out" : ""} ${key === today ? "today" : ""} ${items.some((item) => item.id === selected) ? "sel" : ""}`}
              aria-label={`${date.getMonth() + 1}/${date.getDate()}，${items.length} 个事项`}
              onClick={() => onSelectDate(key)}
            >
              <div className="ms-day">{date.getDate()}</div>
              {items.slice(0, 3).map((item, index) => (
                <button
                  key={`${item.id}-${index}`}
                  type="button"
                  className={`ms-pill ${item.done ? "done" : ""} ${item.id === selected ? "sel" : ""}`}
                  style={{ background: `color-mix(in srgb, ${item.color} 14%, var(--panel))`, color: item.color }}
                  onClick={(click) => { click.stopPropagation(); onSelectEvent(item.id); }}
                >
                  {item.label}
                </button>
              ))}
              {items.length > 3 && <span className="ms-more">+{items.length - 3}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
