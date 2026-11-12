//! Daily digest (P3c): what a day of activity adds up to, computed from the sessions and the
//! category rules without an LLM. The timeline page, bebe's evening bubble and the AI tools read
//! the same numbers.
//!
//! Like ActivityWatch's summary, time is summed by key and ranked, and totals are taken before the
//! top-N cut. Unlike it, categories come from beta-life's app / site / keyword rules, and the
//! unclassified time is listed with the rule one click would set.
//!
//! bebe's reminders are logged in `时间轴/.beta-life/pet-events/YYYY-MM-DD.jsonl` (append only), so
//! the digest can count them.

use super::{activity, categories, load_settings, vault, PeriodId, PeriodSetting};
use categories::{Candidate, Category, Rules};
use chrono::{Duration, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};

const TOP_SLACK: usize = 3;
const TOP_UNCLASSIFIED: usize = 3;
const AVERAGE_DAYS: i64 = 7;
const GROUP_LIMIT: usize = 20;
const GROUP_LIMIT_MAX: usize = 100;
const SESSION_LIMIT: usize = 300;

#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Totals {
    focus: i64,
    neutral: i64,
    slack: i64,
    /// Unclassified.
    none: i64,
}

impl Totals {
    fn add(&mut self, category: Option<Category>, ms: i64) {
        match category {
            Some(Category::Focus) => self.focus += ms,
            Some(Category::Neutral) => self.neutral += ms,
            Some(Category::Slack) => self.slack += ms,
            None => self.none += ms,
        }
    }

    fn active(&self) -> i64 {
        self.focus + self.neutral + self.slack + self.none
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct Span {
    start: i64,
    end: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Item {
    label: String,
    ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeriodTotals {
    id: PeriodId,
    label: String,
    #[serde(flatten)]
    totals: Totals,
}

/// Per-day means over the previous days that have any record.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Average {
    days: u32,
    active: i64,
    focus: i64,
    slack: i64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct Nudges {
    /// Slack reminders bebe showed.
    count: u32,
    /// Times the user pressed 回去做事.
    back: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DaySummary {
    /// `YYYY-MM-DD`.
    date: String,
    totals: Totals,
    longest_focus: Option<Span>,
    top_slack: Vec<Item>,
    /// The longest unclassified rule targets of the day (`todayMs` = time on that day).
    unclassified: Vec<Candidate>,
    /// In Settings order; the period running at midnight also gets the early hours.
    periods: Vec<PeriodTotals>,
    average: Option<Average>,
    nudges: Nudges,
}

type Classified<'a> = Vec<(&'a activity::Session, Option<Category>)>;

fn classify<'a>(rules: &Rules, sessions: &'a [activity::Session]) -> Classified<'a> {
    sessions.iter().map(|session| (session, rules.classify(session))).collect()
}

fn totals(classified: &Classified) -> Totals {
    let mut totals = Totals::default();
    for (session, category) in classified {
        totals.add(*category, session.end - session.start);
    }
    totals
}

/// The longest run of `category`, with the same tolerance as a slack streak: glances shorter than
/// `STREAK_BLIP_MS` at something else are allowed, a gap longer than `STREAK_GAP_MS` ends it.
fn longest_streak(classified: &Classified, category: Category) -> Option<Span> {
    let mut best: Option<Span> = None;
    let mut current: Option<Span> = None;
    let mut edge = 0;
    let mut close = |current: &mut Option<Span>| {
        if let Some(span) = current.take() {
            if best.is_none_or(|best| span.end - span.start > best.end - best.start) {
                best = Some(span);
            }
        }
    };
    for (session, own) in classified {
        if current.is_some() && session.start - edge > categories::STREAK_GAP_MS {
            close(&mut current);
        }
        if *own == Some(category) {
            current = Some(Span { start: current.map_or(session.start, |span| span.start), end: session.end });
            edge = session.end;
        } else if current.is_some() {
            if session.end - session.start >= categories::STREAK_BLIP_MS {
                close(&mut current);
            } else {
                edge = session.end;
            }
        }
    }
    close(&mut current);
    best
}

fn top_by(classified: &Classified, keep: impl Fn(Option<Category>) -> bool, label: impl Fn(&activity::Session, Option<Category>) -> String) -> Vec<Item> {
    let mut sums: HashMap<String, i64> = HashMap::new();
    for (session, category) in classified {
        if keep(*category) {
            *sums.entry(label(session, *category)).or_default() += session.end - session.start;
        }
    }
    let mut items: Vec<Item> = sums.into_iter().map(|(label, ms)| Item { label, ms }).collect();
    items.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.label.cmp(&b.label)));
    items
}

/// Where each period starts on `day`, in time order; the first entry (at midnight) is the period
/// that runs over midnight (sleep, usually).
fn period_starts<Tz: TimeZone>(day: NaiveDate, periods: &[PeriodSetting], tz: &Tz) -> Vec<(i64, usize)> {
    let at = |hour: u8| {
        day.and_hms_opt(u32::from(hour), 0, 0)
            .and_then(|naive| tz.from_local_datetime(&naive).earliest())
            .map(|time| time.timestamp_millis())
    };
    let mut order: Vec<usize> = (0..periods.len()).collect();
    order.sort_by_key(|&index| periods[index].start_hour);
    let Some(&overnight) = order.last() else { return Vec::new() };
    let mut starts = Vec::new();
    if periods[order[0]].start_hour != 0 {
        starts.extend(at(0).map(|ms| (ms, overnight)));
    }
    starts.extend(order.iter().filter_map(|&index| at(periods[index].start_hour).map(|ms| (ms, index))));
    starts
}

fn by_period(classified: &Classified, periods: &[PeriodSetting], starts: &[(i64, usize)]) -> Vec<PeriodTotals> {
    let mut totals = vec![Totals::default(); periods.len()];
    for (session, category) in classified {
        for (position, &(from, index)) in starts.iter().enumerate() {
            let to = starts.get(position + 1).map_or(i64::MAX, |next| next.0);
            let overlap = session.end.min(to) - session.start.max(from);
            if overlap > 0 {
                totals[index].add(*category, overlap);
            }
        }
    }
    periods
        .iter()
        .zip(totals)
        .map(|(period, totals)| PeriodTotals { id: period.id, label: period.label.clone(), totals })
        .collect()
}

fn average(days: &[Totals]) -> Option<Average> {
    let recorded: Vec<&Totals> = days.iter().filter(|totals| totals.active() > 0).collect();
    let count = recorded.len() as i64;
    (count > 0).then(|| Average {
        days: count as u32,
        active: recorded.iter().map(|totals| totals.active()).sum::<i64>() / count,
        focus: recorded.iter().map(|totals| totals.focus).sum::<i64>() / count,
        slack: recorded.iter().map(|totals| totals.slack).sum::<i64>() / count,
    })
}

/// `sessions` are one day's, sorted by start; `previous` are the totals of the days before it.
fn summarize(rules: &Rules, day: NaiveDate, sessions: &[activity::Session], starts: &[(i64, usize)], periods: &[PeriodSetting], previous: &[Totals], nudges: Nudges) -> DaySummary {
    let classified = classify(rules, sessions);
    let mut unclassified = categories::unclassified_usage(rules, &classified, i64::MIN);
    unclassified.truncate(TOP_UNCLASSIFIED);
    let mut top_slack = top_by(&classified, |category| category == Some(Category::Slack), |session, _| categories::session_label(session));
    top_slack.truncate(TOP_SLACK);
    DaySummary {
        date: day.format("%Y-%m-%d").to_string(),
        totals: totals(&classified),
        longest_focus: longest_streak(&classified, Category::Focus),
        top_slack,
        unclassified,
        periods: by_period(&classified, periods, starts),
        average: average(previous),
        nudges,
    }
}

fn parse_day(date: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())
}

fn day_summary(app: &AppHandle, state: &activity::ActivityState, day: NaiveDate) -> Result<DaySummary, String> {
    let settings = load_settings(app)?;
    let rules = categories::load(app)?;
    let sessions = activity::day_sessions(app, state, day)?;
    let mut previous = Vec::new();
    for back in 1..=AVERAGE_DAYS {
        let earlier = activity::day_sessions(app, state, day - Duration::days(back))?;
        previous.push(totals(&classify(&rules, &earlier)));
    }
    let starts = period_starts(day, &settings.periods, &Local);
    Ok(summarize(&rules, day, &sessions, &starts, &settings.periods, &previous, read_nudges(&events_dir(app)?, day)))
}

/// The digest of one local day (`YYYY-MM-DD`) for the timeline page and bebe.
#[tauri::command]
pub(crate) fn load_daily_summary(app: AppHandle, state: State<'_, activity::ActivityState>, date: String) -> Result<DaySummary, String> {
    day_summary(&app, &state, parse_day(&date)?)
}

// ---------- bebe's reminder log ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PetEventKind {
    /// A slack reminder was shown.
    Nudge,
    /// The user pressed 回去做事.
    Back,
}

#[derive(Debug, Serialize, Deserialize)]
struct PetEvent {
    at: i64,
    kind: PetEventKind,
}

fn events_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault::location::root(app)?.join(vault::TIMELINE).join(vault::META).join("pet-events"))
}

fn events_path(dir: &Path, day: NaiveDate) -> PathBuf {
    dir.join(format!("{}.jsonl", day.format("%Y-%m-%d")))
}

fn read_nudges(dir: &Path, day: NaiveDate) -> Nudges {
    let mut nudges = Nudges::default();
    let text = fs::read_to_string(events_path(dir, day)).unwrap_or_default();
    for event in text.lines().filter_map(|line| serde_json::from_str::<PetEvent>(line).ok()) {
        match event.kind {
            PetEventKind::Nudge => nudges.count += 1,
            PetEventKind::Back => nudges.back += 1,
        }
    }
    nudges
}

fn append_event(dir: &Path, day: NaiveDate, event: &PetEvent) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("无法创建 bebe 事件目录：{error}"))?;
    let line = serde_json::to_string(event).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new().create(true).append(true).open(events_path(dir, day)).map_err(|error| format!("无法记录 bebe 事件：{error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("无法记录 bebe 事件：{error}"))
}

#[tauri::command]
pub(crate) fn record_pet_event(app: AppHandle, kind: PetEventKind) -> Result<(), String> {
    let now = Local::now();
    append_event(&events_dir(&app)?, now.date_naive(), &PetEvent { at: now.timestamp_millis(), kind })
}

// ---------- AI tools (read only, limited by Settings) ----------

/// The first day the AI may read: the last `ai_days` days, today included.
fn earliest_for_ai(today: NaiveDate, ai_days: u16) -> NaiveDate {
    today - Duration::days(i64::from(ai_days.max(1)) - 1)
}

fn check_ai_day(day: NaiveDate, today: NaiveDate, ai_days: u16) -> Result<(), String> {
    let earliest = earliest_for_ai(today, ai_days);
    if day > today {
        return Err(format!("{day} 还没到"));
    }
    if day < earliest {
        return Err(format!("用户只允许读取最近 {ai_days} 天的活动记录（{earliest} 起）"));
    }
    Ok(())
}

/// For the model: `1h 05m`, `6m 01s`, `40s`. Raw milliseconds were misread (6m 01s became 6 hours).
fn duration_text(ms: i64) -> String {
    let seconds = (ms.max(0) + 500) / 1000;
    if seconds >= 3600 {
        let minutes = (seconds + 30) / 60;
        return format!("{}h {:02}m", minutes / 60, minutes % 60);
    }
    let (minutes, seconds) = (seconds / 60, seconds % 60);
    if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

fn totals_text(totals: &Totals) -> Value {
    json!({
        "active": duration_text(totals.active()),
        "focus": duration_text(totals.focus),
        "neutral": duration_text(totals.neutral),
        "slack": duration_text(totals.slack),
        "unclassified": duration_text(totals.none),
    })
}

fn clock_text<Tz: TimeZone>(ms: i64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    tz.timestamp_millis_opt(ms).single().map(|time| time.format("%H:%M").to_string()).unwrap_or_default()
}

/// The digest as the model reads it: durations as text, times as local `HH:MM`.
fn summary_text<Tz: TimeZone>(summary: &DaySummary, tz: &Tz) -> Value
where
    Tz::Offset: std::fmt::Display,
{
    let active = summary.totals.active();
    let item = |item: &Item| json!({ "label": item.label, "duration": duration_text(item.ms) });
    json!({
        "date": summary.date,
        "totals": totals_text(&summary.totals),
        "focusSharePercent": (active > 0).then(|| (summary.totals.focus * 100 + active / 2) / active),
        "longestFocus": summary.longest_focus.map(|span| json!({
            "from": clock_text(span.start, tz),
            "to": clock_text(span.end, tz),
            "duration": duration_text(span.end - span.start),
        })),
        "topSlack": summary.top_slack.iter().map(item).collect::<Vec<_>>(),
        "unclassified": summary.unclassified.iter().map(|candidate| json!({
            "label": candidate.target.label(),
            "duration": duration_text(candidate.today_ms),
        })).collect::<Vec<_>>(),
        "periods": summary.periods.iter().map(|period| json!({ "period": period.label, "time": totals_text(&period.totals) })).collect::<Vec<_>>(),
        "averageOfPrevious7Days": summary.average.map(|average| json!({
            "daysWithRecords": average.days,
            "active": duration_text(average.active),
            "focus": duration_text(average.focus),
            "slack": duration_text(average.slack),
        })),
        "slackReminders": { "shown": summary.nudges.count, "wentBackToWork": summary.nudges.back },
    })
}

/// `get_daily_summary`: a digest has no window titles, so the title switch does not apply.
#[tauri::command]
pub(crate) fn ai_daily_summary(app: AppHandle, state: State<'_, activity::ActivityState>, date: Option<String>) -> Result<Value, String> {
    let today = Local::now().date_naive();
    let day = date.as_deref().map(parse_day).transpose()?.unwrap_or(today);
    check_ai_day(day, today, load_settings(&app)?.activity.ai_days)?;
    Ok(summary_text(&day_summary(&app, &state, day)?, &Local))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum GroupBy {
    App,
    /// Web pages by domain, other time by app.
    Site,
    Title,
    Category,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CategoryFilter {
    Focus,
    Neutral,
    Slack,
    /// Unclassified.
    None,
}

impl CategoryFilter {
    fn matches(self, category: Option<Category>) -> bool {
        match self {
            CategoryFilter::Focus => category == Some(Category::Focus),
            CategoryFilter::Neutral => category == Some(Category::Neutral),
            CategoryFilter::Slack => category == Some(Category::Slack),
            CategoryFilter::None => category.is_none(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryRequest {
    from: String,
    to: String,
    group_by: GroupBy,
    #[serde(default)]
    category: Option<CategoryFilter>,
    /// Single day only: also return the sessions themselves.
    #[serde(default)]
    sessions: bool,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRow {
    /// Local `YYYY-MM-DD HH:MM`.
    start: String,
    end: String,
    duration: String,
    app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    category: Option<Category>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryResult {
    from: String,
    to: String,
    /// Time per category over the whole range (the category filter does not apply).
    totals: Value,
    /// Total of the filtered time, before the top-N cut.
    total: String,
    groups: Vec<GroupText>,
    /// Filtered time not in `groups`.
    other: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sessions: Option<Vec<SessionRow>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    sessions_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    titles_hidden: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct GroupText {
    label: String,
    duration: String,
}

fn local_clock<Tz: TimeZone>(ms: i64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    tz.timestamp_millis_opt(ms).single().map(|time| time.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

fn category_label(category: Option<Category>) -> &'static str {
    match category {
        Some(Category::Focus) => "focus",
        Some(Category::Neutral) => "neutral",
        Some(Category::Slack) => "slack",
        None => "unclassified",
    }
}

fn query<Tz: TimeZone>(rules: &Rules, sessions: &[activity::Session], request: &QueryRequest, titles: bool, tz: &Tz) -> Result<QueryResult, String>
where
    Tz::Offset: std::fmt::Display,
{
    if request.group_by == GroupBy::Title && !titles {
        return Err("用户在 Settings 里关掉了窗口标题，不能按标题统计；可以按 app、site 或 category".into());
    }
    let classified = classify(rules, sessions);
    let filtered: Classified = classified.iter().copied().filter(|(_, category)| request.category.is_none_or(|filter| filter.matches(*category))).collect();
    let mut groups = top_by(&filtered, |_| true, |session, category| match request.group_by {
        GroupBy::App => session.app.clone(),
        GroupBy::Site => categories::session_label(session),
        GroupBy::Title => format!("{} — {}", session.app, if session.title.trim().is_empty() { "（无标题）" } else { session.title.trim() }),
        GroupBy::Category => category_label(category).into(),
    });
    let total_ms: i64 = filtered.iter().map(|(session, _)| session.end - session.start).sum();
    groups.truncate(request.limit.unwrap_or(GROUP_LIMIT).clamp(1, GROUP_LIMIT_MAX));
    let other_ms = total_ms - groups.iter().map(|item| item.ms).sum::<i64>();
    let (rows, truncated) = if request.sessions {
        let rows: Vec<SessionRow> = filtered
            .iter()
            .take(SESSION_LIMIT)
            .map(|(session, category)| SessionRow {
                start: local_clock(session.start, tz),
                end: local_clock(session.end, tz),
                duration: duration_text(session.end - session.start),
                app: session.app.clone(),
                domain: session.domain.clone(),
                title: (titles && !session.title.trim().is_empty()).then(|| session.title.clone()),
                category: *category,
            })
            .collect();
        (Some(rows), filtered.len() > SESSION_LIMIT)
    } else {
        (None, false)
    };
    Ok(QueryResult {
        from: request.from.clone(),
        to: request.to.clone(),
        totals: totals_text(&totals(&classified)),
        total: duration_text(total_ms),
        groups: groups.into_iter().map(|item| GroupText { duration: duration_text(item.ms), label: item.label }).collect(),
        other: duration_text(other_ms),
        sessions: rows,
        sessions_truncated: truncated,
        titles_hidden: !titles,
    })
}

/// `query_activity`: time summed over a range of days, optionally one day's sessions.
#[tauri::command]
pub(crate) fn ai_query_activity(app: AppHandle, state: State<'_, activity::ActivityState>, request: QueryRequest) -> Result<QueryResult, String> {
    let settings = load_settings(&app)?;
    let today = Local::now().date_naive();
    let (from, to) = (parse_day(&request.from)?, parse_day(&request.to)?);
    if from > to {
        return Err("from 不能晚于 to".into());
    }
    if request.sessions && from != to {
        return Err("sessions 只能用于单天查询（from 和 to 相同）".into());
    }
    check_ai_day(from, today, settings.activity.ai_days)?;
    check_ai_day(to, today, settings.activity.ai_days)?;
    let mut sessions = Vec::new();
    let mut day = from;
    while day <= to {
        sessions.extend(activity::day_sessions(&app, &state, day)?);
        day += Duration::days(1);
    }
    query(&categories::load(&app)?, &sessions, &request, settings.activity.ai_titles, &Local)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const MIN: i64 = 60_000;

    fn at(minutes: i64) -> i64 {
        // 2026-11-12 00:00 UTC.
        1_794_441_600_000 + minutes * MIN
    }

    fn session(from: i64, to: i64, app: &str, bundle: &str, domain: Option<&str>) -> activity::Session {
        activity::Session { start: at(from), end: at(to), app: app.into(), bundle_id: Some(bundle.into()), title: format!("{app} window"), domain: domain.map(Into::into) }
    }

    fn code(from: i64, to: i64) -> activity::Session {
        session(from, to, "Visual Studio Code", "com.microsoft.VSCode", None)
    }

    fn edge(from: i64, to: i64, domain: &str) -> activity::Session {
        session(from, to, "Microsoft Edge", "com.microsoft.edgemac", Some(domain))
    }

    fn rules() -> Rules {
        serde_json::from_value(serde_json::json!({
            "apps": [{ "key": "com.microsoft.VSCode", "name": "Code", "category": "focus" }],
            "domains": [{ "domain": "bilibili.com", "category": "slack" }, { "domain": "zhihu.com", "category": "slack" }],
            "keywords": []
        }))
        .unwrap()
    }

    fn periods() -> Vec<PeriodSetting> {
        serde_json::from_value(serde_json::json!([
            { "id": "morning", "label": "早上", "startHour": 7, "color": "#000" },
            { "id": "noon", "label": "中午", "startHour": 12, "color": "#000" },
            { "id": "evening", "label": "晚上", "startHour": 18, "color": "#000" },
            { "id": "sleep", "label": "睡眠", "startHour": 23, "color": "#000" }
        ]))
        .unwrap()
    }

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 12).unwrap()
    }

    #[test]
    fn longest_focus_survives_glances_but_not_breaks() {
        let rules = rules();
        // 9:00–9:50 code, a 20s glance at bilibili, code until 10:30; then 2 minutes of bilibili, code again.
        let glance = activity::Session { start: at(590), end: at(590) + 20_000, ..edge(0, 0, "bilibili.com") };
        let after = activity::Session { start: at(590) + 20_000, ..code(0, 630) };
        let sessions = vec![code(540, 590), glance, after, edge(630, 632, "bilibili.com"), code(632, 640)];
        let span = longest_streak(&classify(&rules, &sessions), Category::Focus).unwrap();
        assert_eq!((span.start, span.end), (at(540), at(630)));

        // A 2-minute gap (away) also ends the run.
        let sessions = vec![code(540, 560), code(562, 600)];
        let span = longest_streak(&classify(&rules, &sessions), Category::Focus).unwrap();
        assert_eq!((span.start, span.end), (at(562), at(600)));
        assert!(longest_streak(&classify(&rules, &[edge(0, 10, "bilibili.com")]), Category::Focus).is_none());
    }

    #[test]
    fn summary_adds_up_by_category_period_and_slack_site() {
        let rules = rules();
        let periods = periods();
        let sessions = vec![
            code(60, 90),                         // 01:00, the sleep period after midnight
            code(600, 660),                       // morning
            edge(700, 730, "bilibili.com"),       // 11:40–12:10, across morning / noon
            edge(800, 805, "zhihu.com"),          // noon
            edge(810, 830, "news.example.org"),   // unclassified
            session(840, 850, "Notes", "com.apple.Notes", None),
        ];
        let starts = period_starts(day(), &periods, &Utc);
        assert_eq!(starts.first(), Some(&(at(0), 3)));
        let previous = [Totals { focus: 60 * MIN, neutral: 0, slack: 30 * MIN, none: 0 }, Totals::default()];
        let summary = summarize(&rules, day(), &sessions, &starts, &periods, &previous, Nudges { count: 2, back: 1 });

        assert_eq!(summary.totals, Totals { focus: 90 * MIN, neutral: 0, slack: 35 * MIN, none: 30 * MIN });
        assert_eq!(summary.top_slack, vec![Item { label: "bilibili.com".into(), ms: 30 * MIN }, Item { label: "zhihu.com".into(), ms: 5 * MIN }]);
        let unclassified: Vec<serde_json::Value> = summary.unclassified.iter().map(|item| serde_json::to_value(item).unwrap()).collect();
        assert_eq!(unclassified[0], serde_json::json!({ "kind": "domain", "key": "example.org", "label": "example.org", "todayMs": 20 * MIN }));
        assert_eq!(unclassified[1]["key"], "com.apple.Notes");
        assert_eq!(unclassified.len(), 2);
        let by_id: HashMap<PeriodId, Totals> = summary.periods.iter().map(|period| (period.id, period.totals)).collect();
        assert_eq!(by_id[&PeriodId::Sleep].focus, 30 * MIN);
        assert_eq!(by_id[&PeriodId::Morning], Totals { focus: 60 * MIN, neutral: 0, slack: 20 * MIN, none: 0 });
        assert_eq!(by_id[&PeriodId::Noon].slack, 15 * MIN);
        assert_eq!(summary.average, Some(Average { days: 1, active: 90 * MIN, focus: 60 * MIN, slack: 30 * MIN }));
        assert_eq!(summary.nudges, Nudges { count: 2, back: 1 });
        assert_eq!(summary.date, "2026-11-12");

        // The model gets text, never milliseconds or timestamps.
        let text = summary_text(&summary, &Utc);
        assert_eq!(text["totals"]["slack"], "35m 00s");
        assert_eq!(text["topSlack"][0], json!({ "label": "bilibili.com", "duration": "30m 00s" }));
        assert_eq!(text["unclassified"][0], json!({ "label": "example.org", "duration": "20m 00s" }));
        assert_eq!(text["longestFocus"], json!({ "from": "10:00", "to": "11:00", "duration": "1h 00m" }));
        assert_eq!(text["focusSharePercent"], 58);
        assert!(!text.to_string().contains(&(30 * MIN).to_string()));
    }

    #[test]
    fn durations_read_with_units() {
        assert_eq!(duration_text(361_358), "6m 01s");
        assert_eq!(duration_text(30_534), "31s");
        assert_eq!(duration_text(18_939_313), "5h 16m");
        assert_eq!(duration_text(0), "0s");
    }

    #[test]
    fn a_period_starting_at_midnight_needs_no_overnight_entry() {
        let mut periods = periods();
        periods[3].start_hour = 0;
        let starts = period_starts(day(), &periods, &Utc);
        assert_eq!(starts.len(), 4);
        assert_eq!(starts[0], (at(0), 3));
    }

    #[test]
    fn pet_events_are_counted_per_day() {
        let dir = std::env::temp_dir().join(format!("bl-pet-events-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for kind in [PetEventKind::Nudge, PetEventKind::Nudge, PetEventKind::Back] {
            append_event(&dir, day(), &PetEvent { at: 0, kind }).unwrap();
        }
        fs::write(events_path(&dir, day().pred_opt().unwrap()), "not json\n").unwrap();
        assert_eq!(read_nudges(&dir, day()), Nudges { count: 2, back: 1 });
        assert_eq!(read_nudges(&dir, day().pred_opt().unwrap()), Nudges::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_ai_reads_only_the_allowed_days() {
        let today = day();
        assert!(check_ai_day(today, today, 30).is_ok());
        assert!(check_ai_day(today - Duration::days(29), today, 30).is_ok());
        assert!(check_ai_day(today - Duration::days(30), today, 30).unwrap_err().contains("30"));
        assert!(check_ai_day(today + Duration::days(1), today, 30).is_err());
        assert!(check_ai_day(today - Duration::days(1), today, 1).is_err());
    }

    fn request(group_by: GroupBy) -> QueryRequest {
        QueryRequest { from: "2026-11-12".into(), to: "2026-11-12".into(), group_by, category: None, sessions: false, limit: None }
    }

    #[test]
    fn queries_group_filter_and_hide_titles() {
        let rules = rules();
        let sessions = vec![code(600, 660), edge(700, 730, "bilibili.com"), edge(730, 735, "news.example.org"), edge(740, 750, "m.bilibili.com")];

        let sites = query(&rules, &sessions, &request(GroupBy::Site), true, &Utc).unwrap();
        assert_eq!(sites.groups[0], GroupText { label: "Visual Studio Code".into(), duration: "1h 00m".into() });
        assert_eq!(sites.total, "1h 45m");

        let slack = query(&rules, &sessions, &QueryRequest { category: Some(CategoryFilter::Slack), limit: Some(1), ..request(GroupBy::App) }, true, &Utc).unwrap();
        assert_eq!(slack.groups, vec![GroupText { label: "Microsoft Edge".into(), duration: "40m 00s".into() }]);
        assert_eq!((slack.total.as_str(), slack.other.as_str()), ("40m 00s", "0s"));
        assert_eq!(slack.totals["focus"], "1h 00m");

        let by_category = query(&rules, &sessions, &request(GroupBy::Category), true, &Utc).unwrap();
        assert_eq!(by_category.groups.iter().map(|item| item.label.as_str()).collect::<Vec<_>>(), vec!["focus", "slack", "unclassified"]);

        let rows = query(&rules, &sessions, &QueryRequest { sessions: true, ..request(GroupBy::App) }, true, &Utc).unwrap().sessions.unwrap();
        assert_eq!((rows[0].start.as_str(), rows[0].duration.as_str()), ("2026-11-12 10:00", "1h 00m"));
        assert_eq!(rows[0].title.as_deref(), Some("Visual Studio Code window"));

        let hidden = query(&rules, &sessions, &QueryRequest { sessions: true, ..request(GroupBy::App) }, false, &Utc).unwrap();
        assert!(hidden.titles_hidden);
        assert!(hidden.sessions.unwrap().iter().all(|row| row.title.is_none()));
        assert!(query(&rules, &sessions, &request(GroupBy::Title), false, &Utc).is_err());
        let titled = query(&rules, &sessions, &request(GroupBy::Title), true, &Utc).unwrap();
        assert_eq!(titled.groups[0].label, "Visual Studio Code — Visual Studio Code window");
    }
}
