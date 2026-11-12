import { activeTotal, CATEGORIES, clock, focusShare, formatDelta, formatDuration, UNCLASSIFIED, type ActivityCategory, type DaySummary, type RuleTarget } from "../activity";
import { CategoryChip } from "./CategoryChip";

const SEGMENTS = [...CATEGORIES, { id: "none" as const, ...UNCLASSIFIED }];

/** The day's digest above the band: focus, against the last 7 days, slack, and the periods. */
export function DaySummaryCard({ summary, onClassify }: { summary: DaySummary; onClassify: (target: RuleTarget, category: ActivityCategory | null) => void }) {
  const { totals, longestFocus, average, nudges } = summary;
  const share = focusShare(totals);
  const longestPeriod = Math.max(1, ...summary.periods.map(activeTotal));
  return (
    <section className="timeline-summary" aria-label="每日总结">
      <div className="timeline-stat">
        <span className="timeline-stat-label">专注占比</span>
        <strong className="timeline-stat-value">{share === null ? "—" : `${share}%`}</strong>
        <span className="timeline-stat-note">
          {longestFocus ? `最长连续 ${formatDuration(longestFocus.end - longestFocus.start)} · ${clock(longestFocus.start)}–${clock(longestFocus.end)}` : "还没有连续专注"}
        </span>
      </div>

      <div className="timeline-stat">
        <span className="timeline-stat-label">和前 7 天平均比</span>
        {average ? (
          <>
            <ul className="timeline-stat-list">
              <li><span>专注</span><strong className={totals.focus >= average.focus ? "is-good" : "is-bad"}>{formatDelta(totals.focus - average.focus)}</strong></li>
              <li><span>摸鱼</span><strong className={totals.slack <= average.slack ? "is-good" : "is-bad"}>{formatDelta(totals.slack - average.slack)}</strong></li>
            </ul>
            <span className="timeline-stat-note">平均专注 {formatDuration(average.focus)}、摸鱼 {formatDuration(average.slack)}（{average.days} 天有记录）</span>
          </>
        ) : (
          <span className="timeline-stat-note">前 7 天没有记录</span>
        )}
      </div>

      <div className="timeline-stat">
        <span className="timeline-stat-label">摸鱼最多</span>
        {summary.topSlack.length > 0 ? (
          <ul className="timeline-stat-list">
            {summary.topSlack.map((item) => <li key={item.label}><span title={item.label}>{item.label}</span><strong>{formatDuration(item.ms)}</strong></li>)}
          </ul>
        ) : (
          <span className="timeline-stat-note">今天没有摸鱼</span>
        )}
        <span className="timeline-stat-note">{nudges.count > 0 ? `bebe 提醒 ${nudges.count} 次 · 回去做事 ${nudges.back} 次` : "bebe 没有提醒"}</span>
      </div>

      <div className="timeline-stat">
        <span className="timeline-stat-label">按时段</span>
        <ul className="timeline-periods">
          {summary.periods.map((period) => {
            const total = activeTotal(period);
            return (
              <li key={period.id}>
                <span title={period.label}>{period.label}</span>
                <span className="timeline-period-bar" title={SEGMENTS.map((item) => `${item.label} ${formatDuration(period[item.id])}`).join(" · ")}>
                  {SEGMENTS.map((item) => period[item.id] > 0 && <i key={item.id} style={{ width: `${(period[item.id] / longestPeriod) * 100}%`, background: item.color }} />)}
                </span>
                <strong>{total > 0 ? formatDuration(total) : "—"}</strong>
              </li>
            );
          })}
        </ul>
      </div>

      {summary.unclassified.length > 0 && (
        <div className="timeline-unclassified">
          <span className="timeline-stat-label">待分类 {formatDuration(totals.none)}</span>
          <ul>
            {summary.unclassified.map((target) => (
              <li key={`${target.kind}:${target.key}`}>
                <span title={target.label}>{target.label}</span>
                <span className="timeline-time">{formatDuration(target.todayMs)}</span>
                <CategoryChip category={null} name={target.label} onChange={(category) => onClassify(target, category)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
