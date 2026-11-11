import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CATEGORIES,
  dayBounds,
  dayKey,
  formatDuration,
  RULES_CHANGED,
  setActivityRule,
  summarizeDay,
  UNCLASSIFIED,
  type ActivityCategory,
  type ActivityDay,
  type ActivityStatus,
  type TargetState,
} from "../activity";
import { CategoryChip } from "./CategoryChip";

const REFRESH_MS = 15_000;
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Day view of the activity record: a 24h band, apps ranked by time, and a category per app / site. */
export function TimelineView() {
  const [day, setDay] = useState(() => new Date());
  const [record, setRecord] = useState<ActivityDay | null>(null);
  const [status, setStatus] = useState<ActivityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const key = dayKey(day);
  const isToday = key === dayKey(new Date(now));

  const refresh = useCallback(async () => {
    setNow(Date.now());
    try {
      const [loaded, current] = await Promise.all([
        invoke<ActivityDay>("load_activity_day", { date: key }),
        invoke<ActivityStatus>("activity_status"),
      ]);
      setRecord(loaded ?? null);
      setStatus(current ?? null);
      setError(null);
    } catch (reason) {
      setError(`活动记录读取失败：${errorText(reason)}`);
    }
  }, [key]);

  useEffect(() => {
    void refresh();
    // Today keeps growing; permission changes made in System Settings show up on return.
    const interval = isToday ? setInterval(() => void refresh(), REFRESH_MS) : undefined;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, isToday]);

  // bebe and Settings change the rules too.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const unlisten = listen(RULES_CHANGED, () => void refresh());
    return () => void unlisten.then((stop) => stop());
  }, [refresh]);

  function shiftDay(days: number) {
    setExpanded(null);
    setDay((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + days));
  }

  async function run(command: string) {
    try {
      await invoke(command);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function classify(target: TargetState, category: ActivityCategory | null) {
    try {
      await setActivityRule(target, category);
      await refresh();
    } catch (reason) {
      setError(`分类保存失败：${errorText(reason)}`);
    }
  }

  function chip(target: TargetState | undefined) {
    return target ? <CategoryChip category={target.category} name={target.label} onChange={(category) => void classify(target, category)} /> : <span />;
  }

  const bounds = dayBounds(day);
  const { total, groups, band, categories } = summarizeDay(record?.sessions ?? [], bounds);
  const longest = groups[0]?.total ?? 1;
  const nowLeft = isToday ? ((now - bounds[0]) / (bounds[1] - bounds[0])) * 100 : null;
  const deniedBrowsers = status?.browsers.filter((browser) => browser.access === "denied").map((browser) => browser.name) ?? [];
  const askedBrowsers = status?.browsers.some((browser) => browser.access === "unknown") ?? false;
  const dateLabel = day.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });

  return (
    <main className="timeline-page">
      <div className="timeline-inner">
        <header className="timeline-head">
          <div className="timeline-date">
            <button type="button" className="icon-button" onClick={() => shiftDay(-1)} aria-label="前一天"><ChevronLeft size={17} /></button>
            <h2>{dateLabel}</h2>
            <button type="button" className="icon-button" onClick={() => shiftDay(1)} disabled={isToday} aria-label="后一天"><ChevronRight size={17} /></button>
            {!isToday && <button type="button" className="text-button" onClick={() => { setExpanded(null); setDay(new Date()); }}>回到今天</button>}
          </div>
          <div className="timeline-total"><span>活跃</span><strong>{formatDuration(total)}</strong></div>
        </header>
        {total > 0 && (
          <ul className="timeline-cats" aria-label="各类时长">
            {[...CATEGORIES, { id: "none" as const, ...UNCLASSIFIED }].map((item) => (
              <li key={item.id}><i style={{ background: item.color }} aria-hidden="true" />{item.label}<strong>{formatDuration(categories[item.id])}</strong></li>
            ))}
          </ul>
        )}

        {status && !status.supported && <div className="timeline-notice"><ShieldAlert size={15} aria-hidden="true" /><span>活动记录目前只支持 macOS。</span></div>}
        {status?.supported && !status.accessibility && (
          <div className="timeline-notice">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>还没有「辅助功能」权限：现在只记录 app 名，看不到窗口标题。</span>
            <button type="button" className="secondary-button" onClick={() => void run("request_accessibility")}>去授权</button>
          </div>
        )}
        {status?.supported && deniedBrowsers.length > 0 && (
          <div className="timeline-notice">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>没有允许 beta-life 控制 {deniedBrowsers.join("、")}：只记录时长，不记录网页标题和域名。</span>
            <button type="button" className="secondary-button" onClick={() => void run("open_automation_settings")}>打开自动化设置</button>
          </div>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}

        <section className="timeline-band-wrap" aria-label="24 小时活动条带">
          <div className="timeline-band">
            {band.map((segment, index) => (
              <span key={index} className="timeline-seg" style={{ left: `${segment.left}%`, width: `max(${segment.width}%, 1px)`, background: segment.color }} title={segment.label} />
            ))}
            {nowLeft !== null && <span className="timeline-now" style={{ left: `${nowLeft}%` }} aria-hidden="true" />}
          </div>
          <div className="timeline-cat-band" aria-hidden="true">
            {band.map((segment, index) => (
              <span key={index} style={{ left: `${segment.left}%`, width: `max(${segment.width}%, 1px)`, background: segment.categoryColor }} />
            ))}
          </div>
          <div className="timeline-ticks" aria-hidden="true">
            {TICKS.map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{hour}</span>)}
          </div>
        </section>

        {groups.length === 0 ? (
          <p className="timeline-empty">
            {isToday ? "今天还没有记录。" : "这一天没有记录。"}beta-life 运行时每 5 秒记录一次前台 app；超过 5 分钟没有操作、锁屏和睡眠的时间不计入，无痕 / InPrivate 窗口不记录。
          </p>
        ) : (
          <ol className="timeline-rank">
            {groups.map((group) => {
              const open = expanded === group.app;
              return (
                <li key={group.app}>
                  <div className="timeline-line">
                    <button type="button" className="timeline-row" aria-expanded={open} onClick={() => setExpanded(open ? null : group.app)}>
                      <i style={{ background: group.color }} aria-hidden="true" />
                      <span className="timeline-name" title={group.app}>{group.app}</span>
                      <span className="timeline-bar"><span style={{ width: `${(group.total / longest) * 100}%`, background: group.color }} /></span>
                      <span className="timeline-time">{formatDuration(group.total)}</span>
                      <ChevronDown size={14} className="timeline-chevron" aria-hidden="true" />
                    </button>
                    {chip(record?.apps[group.app])}
                  </div>
                  {open && (
                    <ul className="timeline-children">
                      {group.children.map((child) => (
                        <li key={child.label}>
                          <span title={child.label}>{child.label}</span>
                          <span className="timeline-time">{formatDuration(child.total)}</span>
                          {group.byDomain ? chip(record?.domains[child.label]) : <span />}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {groups.some((group) => group.byDomain) && <p className="timeline-foot">浏览器那一行的分类只管没有域名的页面（新标签页等）；网站展开后单独分类，子域名跟着主站。标题关键词例外在 Settings「分类」里加。</p>}
        {status?.supported && askedBrowsers && <p className="timeline-foot">第一次切到 Edge 或 Chrome 时，macOS 会询问是否允许 beta-life 控制它；允许后才记录网页域名（只存域名，不存完整网址）。</p>}
      </div>
    </main>
  );
}
