//! 时间板的事项与 project (P9): `时间板/.beta-life/events.json`, synced with the data folder.
//! The file holds everything the milestone / gantt views draw: events (point or span, chained by
//! `next`) and the projects that colour a chain. Reminder bookkeeping stays on this Mac.
//!
//! One window edits at a time, so saves are whole-file read-modify-write. Two Macs sharing the folder
//! through 坚果云 are merged by id, the newer `updatedAt` winning; deletions leave a tombstone so the
//! other Mac's older copy cannot bring an event back.

use super::{BOARD, META};
use crate::{app_data_dir, atomic_write, read_json, vault};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};
use tauri::{AppHandle, Emitter};

/// Emitted to every window after `events.json` changed.
pub(crate) const EVENTS_EVENT: &str = "board://events";
/// Tombstones older than this are dropped on save.
const TOMBSTONE_DAYS: i64 = 90;
const MAX_TITLE_CHARS: usize = 200;
const MAX_PROJECTS: usize = 200;
const MAX_EVENTS: usize = 2000;

// ---------- data ----------

fn default_priority() -> u8 {
    5
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Shape {
    Point,
    Span,
}

/// How an event reminds: on its day, some days before, and in the morning list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Remind {
    /// The bubble on the day itself; implied by `time` and by a span's 截止.
    on_day: bool,
    /// Days before `date` to remind, each 1–30.
    days_before: Vec<u8>,
}

impl Default for Remind {
    fn default() -> Self {
        Self { on_day: true, days_before: Vec::new() }
    }
}

/// One thing on the time board: a point due or a span 截止→通知, optionally chained to the next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Event {
    id: String,
    title: String,
    note: String,
    shape: Shape,
    /// Point: due date. Span: 截止. `YYYY-MM-DD`.
    date: String,
    /// The date is an estimate (shown as `~` and dashed).
    date_est: bool,
    /// Span only: 通知 date; `None` = not announced yet.
    end: Option<String>,
    end_est: bool,
    /// Point only: local `HH:MM`; makes it show on 今天 / 本周 at that minute.
    time: Option<String>,
    /// `/`-separated; `tags[0]` is the row (track/venue, project tag, 个人事项/子类, or empty).
    tags: Vec<String>,
    /// The one next event in the chain.
    next: Option<String>,
    remind: Remind,
    done: bool,
    created_at: i64,
    updated_at: i64,
}

impl Default for Event {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            note: String::new(),
            shape: Shape::Point,
            date: String::new(),
            date_est: false,
            end: None,
            end_est: false,
            time: None,
            tags: Vec::new(),
            next: None,
            remind: Remind::default(),
            done: false,
            created_at: 0,
            updated_at: 0,
        }
    }
}

/// A project colours one chain; `tag` = `分类/名称` and is unique.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Project {
    id: String,
    /// `分类/名称`, used as `tags[0]` for the project's own events.
    tag: String,
    /// The event the chain starts at; `None` = back in the tray.
    head: Option<String>,
    /// 1–10; orders projects inside a category. Does not affect colour.
    priority: u8,
    /// A hex override; `None` = follow the category colour.
    color: Option<String>,
    note: String,
    updated_at: i64,
}

impl Default for Project {
    fn default() -> Self {
        Self { id: String::new(), tag: String::new(), head: None, priority: default_priority(), color: None, note: String::new(), updated_at: 0 }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Tombstone {
    id: String,
    at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct EventFile {
    schema_version: u8,
    events: Vec<Event>,
    projects: Vec<Project>,
    /// Ids deleted within the last 90 days, so another Mac's older copy cannot revive them.
    deleted: Vec<Tombstone>,
}

/// What a window loads and hands back: the file plus the mtime it read, to detect outside edits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventsState {
    file: EventFile,
    /// Unix milliseconds; 0 when the file does not exist yet.
    mtime: i64,
}

// ---------- paths ----------

fn tab(root: &Path) -> PathBuf {
    root.join(BOARD)
}

fn events_path(root: &Path) -> PathBuf {
    tab(root).join(META).join("events.json")
}

/// bebe's local plan; only read here to migrate the old `reminders` list.
fn plan_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("pet").join("plan.json"))
}

/// This Mac only: reminders already shown (`eventId:YYYY-MM-DD:onDay|before<N>|morning`).
fn fired_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("pet").join("events-fired.json"))
}

// ---------- validation ----------

fn valid_date(text: &str) -> bool {
    text.len() == 10 && chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}

fn valid_clock(text: &str) -> bool {
    if text.len() != 5 || text.as_bytes()[2] != b':' {
        return false;
    }
    let (hours, minutes) = (&text[0..2], &text[3..5]);
    hours.parse::<u8>().is_ok_and(|hours| hours < 24) && minutes.parse::<u8>().is_ok_and(|minutes| minutes < 60)
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.split('/').all(|part| !part.trim().is_empty())
}

fn is_hex(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Everything the views assume: shapes, dates, tags, the chain and project tags.
pub(crate) fn validate(file: &EventFile) -> Result<(), String> {
    if file.events.len() > MAX_EVENTS {
        return Err(format!("事项最多 {MAX_EVENTS} 个"));
    }
    if file.projects.len() > MAX_PROJECTS {
        return Err(format!("project 最多 {MAX_PROJECTS} 个"));
    }
    let mut ids = HashSet::new();
    for event in &file.events {
        if event.id.is_empty() {
            return Err("事项 id 不能为空".into());
        }
        if !ids.insert(event.id.as_str()) {
            return Err(format!("事项 id 重复：{}", event.id));
        }
    }
    for event in &file.events {
        let name = event.title.trim();
        if name.is_empty() || name.chars().count() > MAX_TITLE_CHARS {
            return Err(format!("事项标题不能为空，最多 {MAX_TITLE_CHARS} 个字"));
        }
        if !valid_date(&event.date) {
            return Err(format!("「{name}」的日期格式应为 YYYY-MM-DD"));
        }
        if let Some(end) = &event.end {
            if !valid_date(end) {
                return Err(format!("「{name}」的通知日格式应为 YYYY-MM-DD"));
            }
            if end.as_str() < event.date.as_str() {
                return Err(format!("「{name}」的通知日不能早于截止日"));
            }
        }
        match event.shape {
            Shape::Point if event.end.is_some() => return Err(format!("「{name}」是单点事项，不能有通知日")),
            Shape::Span if event.time.is_some() => return Err(format!("「{name}」是占用期，不能有时间")),
            _ => {}
        }
        if let Some(time) = &event.time {
            if !valid_clock(time) {
                return Err(format!("「{name}」的时间格式应为 HH:MM"));
            }
        }
        if event.tags.iter().any(|tag| !valid_tag(tag)) {
            return Err(format!("「{name}」的 tag 不能有空段"));
        }
        if event.remind.days_before.iter().any(|days| !(1..=30).contains(days)) {
            return Err(format!("「{name}」的提前提醒应在 1–30 天之间"));
        }
        if let Some(next) = &event.next {
            if next == &event.id {
                return Err(format!("「{name}」不能指向自己"));
            }
            if !ids.contains(next.as_str()) {
                return Err(format!("「{name}」的下一站不存在"));
            }
        }
    }
    for event in &file.events {
        let mut seen = HashSet::from([event.id.as_str()]);
        let mut cursor = event.next.as_deref();
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err(format!("「{}」的下一站连成了环", event.title));
            }
            cursor = file.events.iter().find(|other| other.id == id).and_then(|other| other.next.as_deref());
        }
    }
    let mut project_ids = HashSet::new();
    let mut project_tags = HashSet::new();
    for project in &file.projects {
        if project.id.is_empty() || !project_ids.insert(project.id.as_str()) {
            return Err("project id 不能为空，也不能重复".into());
        }
        if !project.tag.contains('/') || !valid_tag(&project.tag) {
            return Err(format!("project tag「{}」应为 分类/名称", project.tag));
        }
        if !project_tags.insert(project.tag.as_str()) {
            return Err(format!("project tag「{}」重复", project.tag));
        }
        if !(1..=10).contains(&project.priority) {
            return Err(format!("project「{}」的 priority 必须是 1–10 的整数", project.tag));
        }
        if let Some(head) = &project.head {
            if !ids.contains(head.as_str()) {
                return Err(format!("project「{}」的 chain 起点不存在", project.tag));
            }
        }
        if let Some(color) = &project.color {
            if !is_hex(color) {
                return Err(format!("project「{}」的颜色格式应为 #RRGGBB", project.tag));
            }
        }
    }
    Ok(())
}

// ---------- delete cascades ----------

/// Clears the `next` pointers and project heads a deleted id would leave dangling.
fn forget(file: &mut EventFile, id: &str) {
    for event in &mut file.events {
        if event.next.as_deref() == Some(id) {
            event.next = None;
        }
    }
    for project in &mut file.projects {
        if project.head.as_deref() == Some(id) {
            project.head = None;
        }
    }
}

/// Drops events the file says are gone, cascading the chain and heads they held.
fn apply_tombstones(file: &mut EventFile) {
    let gone: HashSet<String> = file.deleted.iter().map(|stone| stone.id.clone()).collect();
    let before = file.events.len();
    file.events.retain(|event| !gone.contains(&event.id));
    if file.events.len() != before {
        for id in &gone {
            forget(file, id);
        }
    }
}

fn trim_tombstones(file: &mut EventFile, now: i64) {
    let cutoff = now - TOMBSTONE_DAYS * 86_400_000;
    let present: HashSet<&str> = file.events.iter().map(|event| event.id.as_str()).collect();
    file.deleted.retain(|stone| stone.at >= cutoff && !present.contains(stone.id.as_str()));
}

// ---------- merge (two Macs through 坚果云) ----------

/// Merges `other` (what is on disk now) into `ours` (what this window had): by id, the newer
/// `updatedAt` wins, a tombstone beats both, and projects merge by tag.
pub(crate) fn merge(ours: &mut EventFile, other: &EventFile) {
    let mut deleted: HashMap<String, i64> = HashMap::new();
    for stone in ours.deleted.iter().chain(other.deleted.iter()) {
        let entry = deleted.entry(stone.id.clone()).or_insert(stone.at);
        *entry = (*entry).max(stone.at);
    }
    let mut by_id: HashMap<String, Event> = other.events.iter().cloned().map(|event| (event.id.clone(), event)).collect();
    for event in ours.events.drain(..) {
        by_id
            .entry(event.id.clone())
            .and_modify(|existing| {
                if event.updated_at > existing.updated_at {
                    *existing = event.clone();
                }
            })
            .or_insert(event);
    }
    let mut events: Vec<Event> = by_id.into_values().filter(|event| !deleted.contains_key(&event.id)).collect();
    events.sort_by(|a, b| (&a.date, &a.id).cmp(&(&b.date, &b.id)));

    let mut by_tag: HashMap<String, Project> = other.projects.iter().cloned().map(|p| (p.tag.clone(), p)).collect();
    for project in ours.projects.drain(..) {
        by_tag
            .entry(project.tag.clone())
            .and_modify(|existing| {
                if project.updated_at > existing.updated_at {
                    *existing = project.clone();
                }
            })
            .or_insert(project);
    }
    let mut projects: Vec<Project> = by_tag.into_values().collect();
    projects.sort_by(|a, b| a.tag.cmp(&b.tag));

    ours.events = events;
    ours.projects = projects;
    ours.deleted = deleted.into_iter().map(|(id, at)| Tombstone { id, at }).collect();
}

// ---------- file io ----------

fn mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn read_file(path: &Path) -> EventFile {
    read_json(path).unwrap_or_default()
}

pub(crate) fn load(root: &Path) -> EventFile {
    let mut file = read_file(&events_path(root));
    apply_tombstones(&mut file);
    normalize(&mut file);
    file
}

/// The events due in the next `days` days, one line each, for bebe's system prompt. The id is shown
/// so the model can call `update_event` / `delete_event` on what it reads.
pub(crate) fn upcoming_lines(file: &EventFile, today: &str, days: i64) -> String {
    let Ok(start) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return "- (none)".into();
    };
    let end = start + chrono::Duration::days(days);
    let lines: Vec<String> = file
        .events
        .iter()
        .filter(|event| !event.done)
        .filter_map(|event| {
            let date = chrono::NaiveDate::parse_from_str(&event.date, "%Y-%m-%d").ok()?;
            if date < start || date > end {
                return None;
            }
            let day = |date: &str, est: bool| if est { format!("~{date} (估计)") } else { date.to_string() };
            let due = day(&event.date, event.date_est);
            let when = match (&event.shape, event.time.as_deref()) {
                (Shape::Span, _) => match &event.end {
                    Some(end) => format!("{due} 截止 → {} 通知", day(end, event.end_est)),
                    None => format!("{due} 截止（通知未定）"),
                },
                (Shape::Point, Some(time)) => format!("{due} {time}"),
                (Shape::Point, None) => due,
            };
            let tags = if event.tags.is_empty() { String::new() } else { format!(" · {}", event.tags.join(" / ")) };
            let next = event.next.as_ref().map(|id| format!(" · 下一站 id `{id}`")).unwrap_or_default();
            Some(format!("- id `{}`: {when} {}{tags}{next}", event.id, event.title))
        })
        .collect();
    if lines.is_empty() {
        "- (none)".into()
    } else {
        lines.join("\n")
    }
}

/// Fields an outside edit can get wrong are repaired instead of blanking the board: chains that
/// point nowhere or loop are cut, a bad priority falls back to 5.
fn normalize(file: &mut EventFile) {
    let ids: HashSet<String> = file.events.iter().map(|event| event.id.clone()).collect();
    for event in &mut file.events {
        if event.next.as_ref().is_some_and(|next| !ids.contains(next) || next == &event.id) {
            event.next = None;
        }
        event.remind.days_before.retain(|days| (1..=30).contains(days));
    }
    let mut loops = HashSet::new();
    for event in &file.events {
        let mut seen = HashSet::from([event.id.clone()]);
        let mut cursor = event.next.clone();
        while let Some(id) = cursor {
            if !seen.insert(id.clone()) {
                loops.insert(event.id.clone());
                break;
            }
            cursor = file.events.iter().find(|other| other.id == id).and_then(|other| other.next.clone());
        }
    }
    for event in &mut file.events {
        if loops.contains(&event.id) {
            event.next = None;
        }
    }
    for project in &mut file.projects {
        if project.head.as_ref().is_some_and(|head| !ids.contains(head)) {
            project.head = None;
        }
        if !(1..=10).contains(&project.priority) {
            project.priority = default_priority();
        }
        if project.color.as_ref().is_some_and(|color| !is_hex(color)) {
            project.color = None;
        }
    }
}

// ---------- old reminders ----------

/// One-time: moves bebe's local one-off reminders into events (local date + `HH:MM`, point,
/// no tag, reminds on the day), then drops the list from `plan.json`.
fn migrate_reminders(app: &AppHandle) -> Result<Vec<Event>, String> {
    let path = plan_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut plan: serde_json::Value = read_json(&path)?;
    let reminders = match plan.as_object_mut().and_then(|map| map.remove("reminders")) {
        Some(serde_json::Value::Array(reminders)) => reminders,
        _ => return Ok(Vec::new()),
    };
    let mut events = Vec::new();
    for item in &reminders {
        let (Some(at), Some(text)) = (item.get("at").and_then(|value| value.as_i64()), item.get("text").and_then(|value| value.as_str())) else {
            continue;
        };
        let Some(local) = Local.timestamp_millis_opt(at).single() else { continue };
        if text.trim().is_empty() {
            continue;
        }
        let id = item
            .get("id")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("ev-{at}"));
        events.push(Event {
            id,
            title: text.trim().to_string(),
            date: local.format("%Y-%m-%d").to_string(),
            time: Some(local.format("%H:%M").to_string()),
            created_at: at,
            updated_at: at,
            ..Event::default()
        });
    }
    atomic_write(&path, &plan)?;
    Ok(events)
}

// ---------- commands ----------

#[tauri::command]
pub(crate) fn load_events(app: AppHandle) -> Result<EventsState, String> {
    let (_guard, root) = vault::open(&app)?;
    let mut file = load(&root);
    let migrated = migrate_reminders(&app)?;
    if !migrated.is_empty() {
        let known: HashSet<String> = file.events.iter().map(|event| event.id.clone()).collect();
        file.events.extend(migrated.into_iter().filter(|event| !known.contains(&event.id)));
        file.events.sort_by(|a, b| (&a.date, &a.id).cmp(&(&b.date, &b.id)));
        atomic_write(&events_path(&root), &file)?;
    }
    Ok(EventsState { file, mtime: mtime(&events_path(&root)) })
}

/// Saves what the window edited. If the file changed since `state.mtime` (another Mac through
/// 坚果云), the on-disk copy is merged in first; ids this window dropped become tombstones.
#[tauri::command]
pub(crate) fn save_events(app: AppHandle, state: EventsState) -> Result<EventsState, String> {
    let (_guard, root) = vault::open(&app)?;
    let path = events_path(&root);
    let disk = read_file(&path);
    let disk_mtime = mtime(&path);
    let now = Local::now().timestamp_millis();
    let mut file = state.file;
    apply_tombstones(&mut file);
    if state.mtime != disk_mtime {
        merge(&mut file, &disk);
        apply_tombstones(&mut file);
    } else {
        let present: HashSet<&str> = file.events.iter().map(|event| event.id.as_str()).collect();
        let deleted: Vec<String> = disk.events.iter().filter(|event| !present.contains(event.id.as_str())).map(|event| event.id.clone()).collect();
        for id in deleted {
            forget(&mut file, &id);
            file.deleted.push(Tombstone { id, at: now });
        }
    }
    normalize(&mut file);
    validate(&file)?;
    trim_tombstones(&mut file, now);
    atomic_write(&path, &file)?;
    let state = EventsState { file, mtime: mtime(&path) };
    app.emit(EVENTS_EVENT, &state).map_err(|error| format!("无法通知其他窗口：{error}"))?;
    Ok(state)
}

// ---------- fired reminders (this Mac only) ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Fired {
    keys: Vec<String>,
}

#[tauri::command]
pub(crate) fn load_events_fired(app: AppHandle) -> Result<Fired, String> {
    let path = fired_path(&app)?;
    Ok(if path.exists() { read_json(&path)? } else { Fired::default() })
}

#[tauri::command]
pub(crate) fn save_events_fired(app: AppHandle, fired: Fired) -> Result<(), String> {
    atomic_write(&fired_path(&app)?, &fired)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(id: &str, date: &str) -> Event {
        Event { id: id.into(), title: id.into(), date: date.into(), created_at: 1, updated_at: 1, ..Event::default() }
    }

    fn file(events: Vec<Event>, projects: Vec<Project>) -> EventFile {
        EventFile { schema_version: 1, events, projects, deleted: Vec::new() }
    }

    fn project(tag: &str, head: Option<&str>) -> Project {
        Project { id: tag.into(), tag: tag.into(), head: head.map(Into::into), ..Project::default() }
    }

    #[test]
    fn upcoming_lines_show_the_next_thirty_days_with_ids() {
        let span = Event { id: "b".into(), title: "ACL".into(), shape: Shape::Span, date: "2026-12-01".into(), end: Some("2027-02-15".into()), tags: vec!["期刊/ACL".into()], ..Event::default() };
        let done = Event { id: "c".into(), title: "旧事".into(), date: "2026-11-25".into(), done: true, ..Event::default() };
        let text = upcoming_lines(&file(vec![point("a", "2026-11-30"), span, done, point("d", "2027-06-01")], vec![]), "2026-11-24", 30);
        assert!(text.contains("- id `a`: 2026-11-30 a"), "{text}");
        assert!(text.contains("- id `b`: 2026-12-01 截止 → 2027-02-15 通知 ACL · 期刊/ACL"), "{text}");
        assert!(!text.contains("旧事"), "{text}");
        assert!(!text.contains("`d`"), "{text}");
        assert_eq!(upcoming_lines(&file(vec![], vec![]), "2026-11-24", 30), "- (none)");
    }

    #[test]
    fn a_plain_point_and_span_pass() {
        let span = Event { id: "b".into(), title: "ACL".into(), shape: Shape::Span, date: "2027-02-15".into(), end: Some("2027-05-15".into()), ..Event::default() };
        assert!(validate(&file(vec![point("a", "2027-03-01"), span], vec![])).is_ok());
    }

    #[test]
    fn bad_shapes_and_dates_are_rejected() {
        assert!(validate(&file(vec![point("a", "2027-3-1")], vec![])).is_err());
        let mut p = point("a", "2027-03-01");
        p.time = Some("25:00".into());
        assert!(validate(&file(vec![p.clone()], vec![])).is_err());
        p.time = Some("09:30".into());
        p.end = Some("2027-04-01".into());
        assert!(validate(&file(vec![p], vec![])).is_err(), "a point has no end");
        let mut span = Event { id: "s".into(), title: "x".into(), shape: Shape::Span, date: "2027-05-01".into(), end: Some("2027-04-01".into()), ..Event::default() };
        assert!(validate(&file(vec![span.clone()], vec![])).is_err(), "end before date");
        span.end = Some("2027-05-01".into());
        span.time = Some("09:00".into());
        assert!(validate(&file(vec![span], vec![])).is_err(), "a span has no time");
    }

    #[test]
    fn tags_and_remind_ranges_are_checked() {
        let mut p = point("a", "2027-03-01");
        p.tags = vec!["个人事项//工作".into()];
        assert!(validate(&file(vec![p.clone()], vec![])).is_err());
        p.tags = vec!["个人事项/工作".into()];
        p.remind.days_before = vec![0, 31];
        assert!(validate(&file(vec![p], vec![])).is_err());
    }

    #[test]
    fn next_cannot_point_at_itself_or_loop() {
        let mut a = point("a", "2027-03-01");
        a.next = Some("a".into());
        assert!(validate(&file(vec![a], vec![])).is_err());
        let mut a = point("a", "2027-03-01");
        let mut b = point("b", "2027-04-01");
        a.next = Some("b".into());
        b.next = Some("a".into());
        assert!(validate(&file(vec![a, b], vec![])).is_err());
        let mut a = point("a", "2027-03-01");
        a.next = Some("missing".into());
        assert!(validate(&file(vec![a], vec![])).is_err());
    }

    #[test]
    fn projects_need_a_unique_two_level_tag_and_a_real_head() {
        assert!(validate(&file(vec![point("a", "2027-03-01")], vec![project("audit", Some("a"))])).is_err());
        assert!(validate(&file(vec![point("a", "2027-03-01")], vec![project("audit/平台", None), project("audit/平台", None)])).is_err());
        assert!(validate(&file(vec![point("a", "2027-03-01")], vec![project("audit/平台", Some("missing"))])).is_err());
        let mut p = project("audit/平台", Some("a"));
        p.priority = 0;
        assert!(validate(&file(vec![point("a", "2027-03-01")], vec![p])).is_err());
    }

    #[test]
    fn old_data_without_fields_reads_with_defaults() {
        let project: Project = serde_json::from_str(r#"{"id":"p","tag":"audit/平台"}"#).unwrap();
        assert_eq!(project.priority, 5, "missing priority reads as 5");
        assert_eq!(project.head, None);
        let event: Event = serde_json::from_str(r#"{"id":"e","title":"ISR","date":"2027-03-01"}"#).unwrap();
        assert_eq!(event.shape, Shape::Point);
        assert!(event.remind.on_day);
        assert!(event.tags.is_empty());
    }

    #[test]
    fn deleting_cascades_next_and_head() {
        let mut a = point("a", "2027-03-01");
        let b = point("b", "2027-04-01");
        a.next = Some("b".into());
        let mut data = file(vec![a, b], vec![project("audit/平台", Some("b"))]);
        data.deleted = vec![Tombstone { id: "b".into(), at: 1 }];
        apply_tombstones(&mut data);
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].next, None);
        assert_eq!(data.projects[0].head, None);
    }

    #[test]
    fn merge_prefers_the_newer_updated_at_and_keeps_deletions() {
        let mut ours = file(vec![point("a", "2027-03-01")], vec![project("audit/平台", Some("a"))]);
        ours.events[0].title = "new".into();
        ours.events[0].updated_at = 5;
        ours.projects[0].priority = 9;
        ours.projects[0].updated_at = 5;
        ours.deleted = vec![Tombstone { id: "gone".into(), at: 9 }];
        let mut other = file(
            vec![point("a", "2027-03-01"), point("gone", "2027-05-01"), point("b", "2027-06-01")],
            vec![project("audit/平台", None)],
        );
        other.events[1].updated_at = 99; // the other Mac still has the deleted event
        other.events[2].updated_at = 2;
        merge(&mut ours, &other);
        let titles: Vec<&str> = ours.events.iter().map(|event| event.title.as_str()).collect();
        assert_eq!(titles, vec!["new", "b"], "deleted stays gone, newer wins, b is added");
        assert_eq!(ours.projects[0].priority, 9, "our newer project wins");
        assert_eq!(ours.deleted.iter().find(|stone| stone.id == "gone").map(|stone| stone.at), Some(9));
    }

    #[test]
    fn tombstones_expire_after_ninety_days_and_drop_revived_ids() {
        let now = 100 * 86_400_000;
        let mut data = file(vec![point("live", "2027-03-01")], vec![]);
        data.deleted = vec![
            Tombstone { id: "live".into(), at: now },
            Tombstone { id: "old".into(), at: now - 91 * 86_400_000 },
            Tombstone { id: "fresh".into(), at: now - 1 },
        ];
        trim_tombstones(&mut data, now);
        let ids: Vec<&str> = data.deleted.iter().map(|stone| stone.id.as_str()).collect();
        assert_eq!(ids, vec!["fresh"]);
    }

    #[test]
    fn normalize_cuts_dangling_and_looping_chains() {
        let mut a = point("a", "2027-03-01");
        a.next = Some("b".into());
        let mut b = point("b", "2027-04-01");
        b.next = Some("a".into());
        let mut dangling = point("c", "2027-05-01");
        dangling.next = Some("missing".into());
        let mut priority = project("audit/平台", None);
        priority.priority = 0;
        let mut data = file(vec![a, b, dangling], vec![priority]);
        normalize(&mut data);
        assert!(data.events.iter().all(|event| event.next.is_none()));
        assert_eq!(data.projects[0].priority, 5);
    }

    #[test]
    fn the_events_file_round_trips_through_json() {
        let span = Event {
            id: "s".into(),
            title: "ACL 2027".into(),
            shape: Shape::Span,
            date: "2027-02-15".into(),
            date_est: true,
            tags: vec!["NLP/ACL".into()],
            remind: Remind { on_day: true, days_before: vec![7, 1] },
            created_at: 10,
            updated_at: 20,
            ..Event::default()
        };
        let data = file(vec![span], vec![project("audit/平台", None)]);
        let text = serde_json::to_string(&data).unwrap();
        let back: EventFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back, data);
        assert!(text.contains("\"daysBefore\":[7,1]"));
        assert!(text.contains("\"shape\":\"span\""));
    }

    #[test]
    fn clocks_hex_and_dates_are_screened() {
        assert!(valid_clock("09:30"));
        assert!(!valid_clock("9:30"));
        assert!(!valid_clock("24:00"));
        assert!(!valid_clock("09-30"));
        assert!(is_hex("#2c4a7c"));
        assert!(!is_hex("2c4a7c"));
        assert!(!is_hex("#2c4a7"));
        assert!(!valid_date("2026-02-29"), "2026 is not a leap year");
        assert!(valid_date("2028-02-29"));
    }

    #[test]
    fn reminders_split_into_local_date_and_time() {
        let at = Local.with_ymd_and_hms(2026, 11, 25, 9, 30, 0).single().unwrap().timestamp_millis();
        let local = Local.timestamp_millis_opt(at).single().unwrap();
        assert_eq!(local.format("%Y-%m-%d").to_string(), "2026-11-25");
        assert_eq!(local.format("%H:%M").to_string(), "09:30");
        assert_eq!(local.timestamp_millis(), at, "split and rejoined keeps the instant");
    }
}
