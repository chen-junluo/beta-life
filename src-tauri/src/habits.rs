//! P6 habit history and reasons.
//!
//! - History: `时间板/.beta-life/history/YYYY-MM.jsonl`, one line per habit per archived day (append
//!   only). `day.json` holds the day the board's `done` checks belong to; when the main window opens
//!   on a later day (or stays open past 0:00) that day is archived once and the checks are cleared.
//! - Reasons: bebe asks why a period's habits were not done; the AI splits the answer per habit.

use crate::{call_provider, load_settings, read_api_key, vault, AppSettings};
use chrono::NaiveDate;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::AppHandle;

const DEFAULT_HABIT_REASONS_PROMPT: &str = r#"把用户写的原因分配给对应的习惯，每个习惯一句话：
1. 只保留原因本身，去掉语气词和道歉，尽量用用户自己的说法，不超过 30 个字。
2. 一句原因说的是好几个习惯（比如「今天一直在开会」），就分给每一个相关的习惯。
3. 用户没提到的习惯不要写；不要编造原因，也不要给建议。"#;

pub(crate) fn default_habit_reasons_prompt() -> String {
    DEFAULT_HABIT_REASONS_PROMPT.into()
}

const DEFAULT_HABIT_SUGGESTION_PROMPT: &str = r#"给每个完成率偏低的习惯写一条助推建议，作为「- 助推建议：」下面的 Tab 缩进子 bullet，格式「习惯名：建议」：
1. 先看这个习惯的【阻挠习惯的原因】和最近几天日记里相关的内容，建议要针对反复出现的原因。
2. 建议要小而具体、今天就能做：缩小到 2 分钟版本、换到更合适的时段或整点、绑定在已经稳定的习惯后面、提前准备好环境。
3. 一个习惯一条，不超过 50 个字；不说教、不评价；语言跟日记一致。"#;

pub(crate) fn default_habit_suggestion_prompt() -> String {
    DEFAULT_HABIT_SUGGESTION_PROMPT.into()
}

/// A reason line is at most this many characters.
const REASON_MAX_CHARS: usize = 80;

fn history_dir(root: &Path) -> PathBuf {
    root.join(vault::BOARD).join(vault::META).join("history")
}

fn month_path(dir: &Path, date: &str) -> PathBuf {
    dir.join(format!("{}.jsonl", &date[..7]))
}

fn parse_date(value: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| format!("日期应为 YYYY-MM-DD：{value}"))
}

#[derive(Debug, Serialize, Deserialize)]
struct DayMarker {
    date: String,
}

/// One habit on one archived day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HabitRecord {
    date: String,
    board_id: String,
    habit_id: String,
    title: String,
    done: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DayHabit {
    habit_id: String,
    title: String,
    done: bool,
    /// Local `YYYY-MM-DD` the habit was created; habits created after the archived day are left out.
    created: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollRequest {
    /// Local `YYYY-MM-DD` now.
    today: String,
    board_id: String,
    habits: Vec<DayHabit>,
}

fn read_records(path: &Path) -> Vec<HabitRecord> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Archives the day the checks belong to when it is before `today` and returns it; the caller then
/// clears the checks. A day already in the file (the other Mac archived it) is not written twice.
fn roll(dir: &Path, request: &RollRequest) -> Result<Option<String>, String> {
    let today = parse_date(&request.today)?;
    let marker_path = dir.join("day.json");
    let marker = crate::read_json::<DayMarker>(&marker_path).ok().and_then(|marker| parse_date(&marker.date).ok());
    let write_marker = || crate::atomic_write(&marker_path, &DayMarker { date: request.today.clone() });
    let Some(day) = marker else {
        // First run: nobody knows which day the current checks are from.
        write_marker()?;
        return Ok(None);
    };
    if day >= today {
        return Ok(None);
    }
    let date = day.format("%Y-%m-%d").to_string();
    let path = month_path(dir, &date);
    if !read_records(&path).iter().any(|record| record.date == date && record.board_id == request.board_id) {
        let mut lines = String::new();
        for habit in request.habits.iter().filter(|habit| habit.created.as_str() <= date.as_str()) {
            let record = HabitRecord { date: date.clone(), board_id: request.board_id.clone(), habit_id: habit.habit_id.clone(), title: habit.title.clone(), done: habit.done };
            lines.push_str(&serde_json::to_string(&record).map_err(|error| error.to_string())?);
            lines.push('\n');
        }
        fs::create_dir_all(dir).map_err(|error| format!("无法创建习惯记录目录：{error}"))?;
        let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|error| format!("无法写入习惯记录：{error}"))?;
        file.write_all(lines.as_bytes()).map_err(|error| format!("无法写入习惯记录：{error}"))?;
    }
    write_marker()?;
    Ok(Some(date))
}

/// Records from `from` to `to` (inclusive, `YYYY-MM-DD`).
fn history(dir: &Path, from: &str, to: &str) -> Result<Vec<HabitRecord>, String> {
    let (start, end) = (parse_date(from)?, parse_date(to)?);
    if end < start || (end - start).num_days() > 400 {
        return Err("习惯记录的日期范围无效".into());
    }
    let mut months = Vec::new();
    let mut day = start;
    while day <= end {
        let month = day.format("%Y-%m").to_string();
        if months.last() != Some(&month) {
            months.push(month);
        }
        day = day.succ_opt().ok_or("日期超出范围")?;
    }
    Ok(months
        .iter()
        .flat_map(|month| read_records(&dir.join(format!("{month}.jsonl"))))
        .filter(|record| record.date.as_str() >= from && record.date.as_str() <= to)
        .collect())
}

#[tauri::command]
pub(crate) fn roll_habit_day(app: AppHandle, request: RollRequest) -> Result<Option<String>, String> {
    let (_guard, root) = vault::open(&app)?;
    roll(&history_dir(&root), &request)
}

#[tauri::command]
pub(crate) fn load_habit_history(app: AppHandle, from: String, to: String) -> Result<Vec<HabitRecord>, String> {
    let (_guard, root) = vault::open(&app)?;
    history(&history_dir(&root), &from, &to)
}

// ---------- reasons ----------

#[derive(Debug, Deserialize)]
pub(crate) struct ReasonHabit {
    id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReasonsRequest {
    /// What the user typed into bebe's question.
    text: String,
    /// The period's unfinished habits.
    habits: Vec<ReasonHabit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HabitReason {
    habit_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ReasonsReply {
    reasons: Vec<HabitReason>,
}

fn reasons_system_prompt(settings: &AppSettings, habits: &[ReasonHabit]) -> String {
    let prompt = if settings.ai.habit_reasons_prompt.trim().is_empty() { DEFAULT_HABIT_REASONS_PROMPT } else { settings.ai.habit_reasons_prompt.trim() };
    let list = habits.iter().map(|habit| format!("- id: {} · {}", habit.id, habit.title)).collect::<Vec<_>>().join("\n");
    format!(
        "{prompt}\n\n用户在一个时段结束前被问「为什么这些习惯没完成？」，下面是没完成的习惯：\n{list}\n\n原因的语言跟用户输入一致。\n\nJSON 输出协议：只返回一个有效 JSON object，不要附加 Markdown 代码块或解释：{{\"reasons\": [{{\"habitId\": \"上面列出的 id\", \"text\": \"一行原因\"}}]}}。每个 habitId 最多出现一次；用户的话和哪个习惯都无关时返回空数组。"
    )
}

/// Only listed habits, each once, one non-empty line of at most `REASON_MAX_CHARS`.
fn validate_reasons(reasons: Vec<HabitReason>, habits: &[ReasonHabit]) -> Result<Vec<HabitReason>, String> {
    let known: HashSet<&str> = habits.iter().map(|habit| habit.id.as_str()).collect();
    let mut seen = HashSet::new();
    reasons
        .into_iter()
        .map(|reason| {
            let text = reason.text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !known.contains(reason.habit_id.as_str()) {
                return Err(format!("AI 返回了不在列表里的习惯：{}", reason.habit_id));
            }
            if !seen.insert(reason.habit_id.clone()) {
                return Err(format!("AI 给同一个习惯返回了两条原因：{}", reason.habit_id));
            }
            if text.is_empty() || text.chars().count() > REASON_MAX_CHARS {
                return Err(format!("AI 返回的原因应为 1–{REASON_MAX_CHARS} 个字"));
            }
            Ok(HabitReason { habit_id: reason.habit_id, text })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn ai_habit_reasons(app: AppHandle, request: ReasonsRequest) -> Result<Vec<HabitReason>, String> {
    if request.text.trim().is_empty() || request.habits.is_empty() {
        return Err("没有原因或习惯".into());
    }
    let settings = load_settings(&app)?;
    let key = read_api_key(&app)?.ok_or_else(|| "请先在 Settings 中保存 API key".to_string())?;
    let base = settings.ai.base_url.trim().trim_end_matches('/');
    let endpoint = if base.ends_with("/chat/completions") { base.to_string() } else { format!("{base}/chat/completions") };
    let messages = vec![
        json!({ "role": "system", "content": reasons_system_prompt(&settings, &request.habits) }),
        json!({ "role": "user", "content": request.text.trim() }),
    ];
    let client = Client::builder().timeout(Duration::from_secs(60)).build().map_err(|error| format!("无法初始化 AI 客户端：{error}"))?;
    let (content, _) = call_provider(&client, &endpoint, &key, &settings.ai, messages).await?;
    let reply: ReasonsReply = serde_json::from_str(&content).map_err(|error| format!("AI 没有返回有效的原因 JSON：{error}"))?;
    validate_reasons(reply.reasons, &request.habits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day_habit(id: &str, done: bool, created: &str) -> DayHabit {
        DayHabit { habit_id: id.into(), title: format!("习惯 {id}"), done, created: created.into() }
    }

    fn request(today: &str, habits: Vec<DayHabit>) -> RollRequest {
        RollRequest { today: today.into(), board_id: "b1".into(), habits }
    }

    #[test]
    fn rolls_each_day_once_and_skips_habits_created_later() {
        let root = vault::test_root("habit-history");
        let dir = history_dir(&root);
        // First run only remembers the day.
        assert_eq!(roll(&dir, &request("2026-11-11", vec![day_habit("a", true, "2026-11-01")])).unwrap(), None);
        assert_eq!(roll(&dir, &request("2026-11-11", vec![day_habit("a", true, "2026-11-01")])).unwrap(), None);
        // Next day: 11-11 is archived; a habit created on 11-12 is not part of it.
        let habits = vec![day_habit("a", true, "2026-11-01"), day_habit("b", false, "2026-11-10"), day_habit("c", false, "2026-11-12")];
        assert_eq!(roll(&dir, &request("2026-11-12", habits)).unwrap(), Some("2026-11-11".into()));
        assert_eq!(roll(&dir, &request("2026-11-12", vec![])).unwrap(), None, "already rolled today");
        // The other Mac rolled the same day already: the marker moves on, no duplicate lines.
        crate::atomic_write(&dir.join("day.json"), &DayMarker { date: "2026-11-11".into() }).unwrap();
        assert_eq!(roll(&dir, &request("2026-11-12", vec![day_habit("a", false, "2026-11-01")])).unwrap(), Some("2026-11-11".into()));
        let records = history(&dir, "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(records.iter().map(|record| (record.habit_id.as_str(), record.done)).collect::<Vec<_>>(), vec![("a", true), ("b", false)]);
        // Days apart, across a month: only the day the checks belong to is archived.
        crate::atomic_write(&dir.join("day.json"), &DayMarker { date: "2026-11-30".into() }).unwrap();
        assert_eq!(roll(&dir, &request("2026-12-03", vec![day_habit("a", true, "2026-11-01")])).unwrap(), Some("2026-11-30".into()));
        assert_eq!(history(&dir, "2026-11-25", "2026-12-03").unwrap().len(), 1);
        assert!(history(&dir, "2026-12-03", "2026-11-25").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reasons_are_checked_against_the_listed_habits() {
        let habits = vec![ReasonHabit { id: "a".into(), title: "晨跑".into() }, ReasonHabit { id: "b".into(), title: "读论文".into() }];
        let reason = |id: &str, text: &str| HabitReason { habit_id: id.into(), text: text.into() };
        assert_eq!(validate_reasons(vec![reason("a", " 下雨\n了 ")], &habits).unwrap(), vec![reason("a", "下雨 了")]);
        assert!(validate_reasons(vec![reason("x", "下雨")], &habits).is_err());
        assert!(validate_reasons(vec![reason("a", "下雨"), reason("a", "累")], &habits).is_err());
        assert!(validate_reasons(vec![reason("b", " ")], &habits).is_err());
        assert!(validate_reasons(vec![reason("b", &"长".repeat(81))], &habits).is_err());
        let prompt = reasons_system_prompt(&crate::default_settings(), &habits);
        assert!(prompt.contains("- id: a · 晨跑") && prompt.contains("\"reasons\""));
    }
}
