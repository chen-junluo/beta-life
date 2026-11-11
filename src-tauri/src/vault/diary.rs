//! 日记: one md per month, `日记/YYMM diary.md`. Each day is a section that starts with a `## YYMMDD周X`
//! heading; the body under it is free-form Markdown. Sections are separated by a blank line, `---` and a
//! blank line. Saving a day rewrites only that day's bytes; every other byte of the file stays.

use super::{fenced_lines, md_files, read_md, remove, stem, write_md, DIARY};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const SEPARATOR: &str = "\n\n---\n\n";
const WEEKDAYS: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/// Id of the text before the first day.
pub(crate) const PREAMBLE: &str = "preamble";

pub(crate) fn tab(root: &Path) -> PathBuf {
    root.join(DIARY)
}

fn valid_month(month: &str) -> bool {
    month.len() == 4 && month.bytes().all(|byte| byte.is_ascii_digit())
}

fn month_path(root: &Path, month: &str) -> PathBuf {
    tab(root).join(format!("{month} diary.md"))
}

/// `YYMMDD` of a day heading: `## 261111周三`, `## 260904 周五`, `## 260702`.
pub(crate) fn day_date(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("## ")?.trim_start_matches(' ');
    let digits = rest.get(..6)?;
    let more = rest[digits.len()..].starts_with(|character: char| character.is_ascii_digit());
    (digits.bytes().all(|byte| byte.is_ascii_digit()) && !more).then_some(digits)
}

/// `261111` → `261111周三`; None when it is not a real date.
pub(crate) fn day_label(date: &str) -> Option<String> {
    if date.len() != 6 {
        return None;
    }
    let number = |range: std::ops::Range<usize>| date.get(range)?.parse::<u32>().ok();
    let day = NaiveDate::from_ymd_opt(2000 + number(0..2)? as i32, number(2..4)?, number(4..6)?)?;
    Some(format!("{date}{}", WEEKDAYS[day.weekday().num_days_from_monday() as usize]))
}

/// Blank lines and `---` rules between days belong to the gap, not to either day.
fn gap_line(line: &str) -> bool {
    matches!(line.trim(), "" | "---" | "***" | "___")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiaryDay {
    /// `YYMMDD`; a second section with the same date is `YYMMDD-2`; text before the first day is `preamble`.
    pub(crate) id: String,
    pub(crate) date: Option<String>,
    /// The heading without `## `, e.g. `261111周三`.
    pub(crate) title: String,
    /// Everything under the heading, without the blank lines around it.
    pub(crate) body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiaryMonth {
    month: String,
    days: Vec<DiaryDay>,
}

/// A section's byte range: `start..end` without the gap after it; the body is `body..end`.
struct Block {
    id: String,
    date: Option<String>,
    start: usize,
    /// End of the heading line (== `start` for the preamble).
    heading: usize,
    body: usize,
    end: usize,
}

fn blocks(text: &str) -> Vec<Block> {
    let lines = fenced_lines(text);
    let mut offsets = Vec::with_capacity(lines.len());
    let mut at = 0;
    for (line, _) in &lines {
        offsets.push(at);
        at += line.len() + 1;
    }
    let first_content = |from: usize, to: usize| (from..to).find(|&index| !gap_line(lines[index].0));
    let last_content = |from: usize, to: usize| (from..to).rev().find(|&index| !gap_line(lines[index].0));
    let line_end = |index: usize| offsets[index] + lines[index].0.len();
    let starts: Vec<usize> = (0..lines.len())
        .filter(|&index| !lines[index].1 && day_date(lines[index].0).is_some())
        .collect();
    let mut result = Vec::new();
    let first_day = starts.first().copied().unwrap_or(lines.len());
    if let (Some(first), Some(last)) = (first_content(0, first_day), last_content(0, first_day)) {
        let start = offsets[first];
        result.push(Block { id: PREAMBLE.into(), date: None, start, heading: start, body: start, end: line_end(last) });
    }
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (index, &line) in starts.iter().enumerate() {
        let next = starts.get(index + 1).copied().unwrap_or(lines.len());
        let date = day_date(lines[line].0).unwrap_or_default();
        let count = seen.entry(date).or_default();
        *count += 1;
        let id = if *count == 1 { date.to_string() } else { format!("{date}-{count}") };
        let heading = line_end(line);
        let (body, end) = match (first_content(line + 1, next), last_content(line + 1, next)) {
            (Some(first), Some(last)) => (offsets[first], line_end(last)),
            _ => (heading, heading),
        };
        result.push(Block { id, date: Some(date.to_string()), start: offsets[line], heading, body, end });
    }
    result
}

pub(crate) fn parse(text: &str) -> Vec<DiaryDay> {
    blocks(text)
        .into_iter()
        .map(|block| DiaryDay {
            title: text[block.start..block.heading].trim_start_matches('#').trim().to_string(),
            body: text[block.body..block.end].to_string(),
            id: block.id,
            date: block.date,
        })
        .collect()
}

/// A day heading inside a body would split the day in two.
fn check(body: &str) -> Result<(), String> {
    if fenced_lines(body).iter().any(|(line, fenced)| !fenced && day_date(line).is_some()) {
        return Err("正文里不能有 `## YYMMDD` 这样的日期标题；另一天请单独新建".into());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) enum Edit {
    /// The new file text and the saved day's id (`None` after a delete).
    Saved(String, Option<String>),
    /// The day's body changed on disk since `base` was read; `None` when the day is gone.
    Conflict(Option<String>),
}

fn id_at(file: &str, start: usize) -> Option<String> {
    blocks(file).into_iter().find(|block| block.start == start).map(|block| block.id)
}

/// What to do with one day: write this body, or delete the day.
pub(crate) enum Change<'a> {
    Body(&'a str),
    Delete,
}

/// Replaces a day's body, adds a new day (from `date`, or the id) or deletes one. `base` is the body as
/// the caller last read it; a different body on disk is a conflict unless `force`.
pub(crate) fn edit(file: &str, month: &str, id: Option<&str>, date: Option<&str>, base: Option<&str>, change: Change, force: bool) -> Result<Edit, String> {
    let body = match change {
        Change::Body(body) => {
            let body = body.trim_start_matches('\n').trim_end_matches('\n');
            check(body)?;
            Some(body)
        }
        Change::Delete => None,
    };
    let blocks = blocks(file);
    let Some(index) = id.and_then(|id| blocks.iter().position(|block| block.id == id)) else {
        if base.is_some() && !force {
            return Ok(Edit::Conflict(None));
        }
        let Some(body) = body else {
            return Ok(Edit::Saved(file.to_string(), None));
        };
        if id == Some(PREAMBLE) {
            if body.trim().is_empty() {
                return Ok(Edit::Saved(file.to_string(), None));
            }
            let next = if file.trim().is_empty() { format!("{body}\n") } else { format!("{body}{SEPARATOR}{file}") };
            return Ok(Edit::Saved(next, Some(PREAMBLE.into())));
        }
        let date = date.or_else(|| id.and_then(|id| id.get(..6))).unwrap_or_default();
        let label = day_label(date).ok_or_else(|| format!("日期无效：{date}"))?;
        if !date.starts_with(month) {
            return Err(format!("{date} 不属于 {month} 这个月"));
        }
        let section = if body.is_empty() { format!("## {label}") } else { format!("## {label}\n\n{body}") };
        // New days go to the end; a trailing gap (e.g. a final `---`) stays at the very end.
        let (next, start) = match blocks.last() {
            None => (format!("{section}\n"), 0),
            Some(last) => {
                let start = last.end + SEPARATOR.len();
                (format!("{}{SEPARATOR}{section}{}", &file[..last.end], &file[last.end..]), start)
            }
        };
        let id = id_at(&next, start);
        return Ok(Edit::Saved(next, id));
    };
    let block = &blocks[index];
    let current = &file[block.body..block.end];
    if base != Some(current) && !force {
        return Ok(Edit::Conflict(Some(current.to_string())));
    }
    let preamble = block.id == PREAMBLE;
    if let Some(body) = body.filter(|body| !preamble || !body.trim().is_empty()) {
        let next = if preamble {
            format!("{}{body}{}", &file[..block.start], &file[block.end..])
        } else if body.is_empty() {
            format!("{}{}", &file[..block.heading], &file[block.end..])
        } else {
            format!("{}\n\n{body}{}", &file[..block.heading], &file[block.end..])
        };
        let id = id_at(&next, block.start);
        return Ok(Edit::Saved(next, id));
    }
    // A day leaves with its gap: the one after it, or before it when it is the last day.
    let next = if let Some(following) = blocks.get(index + 1) {
        format!("{}{}", &file[..block.start], &file[following.start..])
    } else if let Some(previous) = index.checked_sub(1).map(|previous| &blocks[previous]) {
        format!("{}{}", &file[..previous.end], &file[block.end..])
    } else {
        String::new()
    };
    Ok(Edit::Saved(next, None))
}

pub(crate) fn months(root: &Path) -> Vec<String> {
    let mut months: Vec<String> = md_files(&tab(root), false)
        .iter()
        .filter_map(|path| stem(path).strip_suffix(" diary").filter(|month| valid_month(month)).map(str::to_string))
        .collect();
    months.sort();
    months
}

fn read_month(root: &Path, month: &str) -> Result<String, String> {
    let path = month_path(root, month);
    if path.exists() {
        read_md(&path)
    } else {
        Ok(String::new())
    }
}

fn checked_month(month: &str) -> Result<(), String> {
    if valid_month(month) {
        Ok(())
    } else {
        Err(format!("月份格式无效：{month}"))
    }
}

#[tauri::command]
pub(crate) fn list_diary_months(app: AppHandle) -> Result<Vec<String>, String> {
    let (_guard, root) = super::open(&app)?;
    Ok(months(&root))
}

#[tauri::command]
pub(crate) fn load_diary_month(app: AppHandle, month: String) -> Result<DiaryMonth, String> {
    checked_month(&month)?;
    let (_guard, root) = super::open(&app)?;
    let days = parse(&read_month(&root, &month)?);
    Ok(DiaryMonth { month, days })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDay {
    month: String,
    /// `None` for a day that is not in the file yet.
    id: Option<String>,
    /// `YYMMDD` of a new day.
    date: Option<String>,
    /// The body as last read; `None` for a new day.
    base: Option<String>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    delete: bool,
    #[serde(default)]
    force: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum SaveOutcome {
    Saved { id: Option<String>, month: DiaryMonth },
    Conflict { current: Option<String> },
}

#[tauri::command]
pub(crate) fn save_diary_day(app: AppHandle, request: SaveDay) -> Result<SaveOutcome, String> {
    checked_month(&request.month)?;
    let (_guard, root) = super::open(&app)?;
    save(&root, request)
}

fn save(root: &Path, request: SaveDay) -> Result<SaveOutcome, String> {
    let path = month_path(root, &request.month);
    let file = read_month(root, &request.month)?;
    let change = if request.delete { Change::Delete } else { Change::Body(&request.body) };
    match edit(&file, &request.month, request.id.as_deref(), request.date.as_deref(), request.base.as_deref(), change, request.force)? {
        Edit::Conflict(current) => Ok(SaveOutcome::Conflict { current }),
        Edit::Saved(next, id) => {
            if next.trim().is_empty() {
                remove(&path)?;
            } else if next != file {
                write_md(&path, &next)?;
            }
            Ok(SaveOutcome::Saved { id, month: DiaryMonth { month: request.month, days: parse(&next) } })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::test_root;

    /// A preamble, `---` gaps, an old blank-line gap, a heading without a weekday, a body with nested
    /// lists, paragraphs and an inner `---`, an empty day, a repeated date, no trailing newline.
    const FILE: &str = "月初的想法\n\n---\n\n## 261101周日\n\n- 早起\n\t- 跑步\n\n一段话\n\n---\n\n## 261102\n\n\t- 缩进开头\n- a\n\n---\n\n下半天\n\n## 261103周二\n\n---\n\n## 261102周一\n\n第二次";

    fn ids(text: &str) -> Vec<String> {
        parse(text).into_iter().map(|day| day.id).collect()
    }

    fn saved(edit: Edit) -> (String, Option<String>) {
        match edit {
            Edit::Saved(text, id) => (text, id),
            Edit::Conflict(_) => panic!("unexpected conflict"),
        }
    }

    #[test]
    fn reads_day_headings() {
        assert_eq!(day_date("## 261111周三"), Some("261111"));
        assert_eq!(day_date("## 260904 周五"), Some("260904"));
        assert_eq!(day_date("## 260702"), Some("260702"));
        assert_eq!(day_date("- 261111周三"), None);
        assert_eq!(day_date("### 261111"), None);
        assert_eq!(day_date("## 2611111"), None);
        assert_eq!(day_label("261111").as_deref(), Some("261111周三"));
        assert_eq!(day_label("260231"), None);
    }

    #[test]
    fn splits_sections_and_keeps_bodies() {
        let days = parse(FILE);
        assert_eq!(ids(FILE), ["preamble", "261101", "261102", "261103", "261102-2"]);
        assert_eq!(days[0].body, "月初的想法");
        assert_eq!((days[1].title.as_str(), days[1].body.as_str()), ("261101周日", "- 早起\n\t- 跑步\n\n一段话"));
        assert_eq!((days[2].title.as_str(), days[2].body.as_str()), ("261102", "\t- 缩进开头\n- a\n\n---\n\n下半天"));
        assert_eq!(days[3].body, "");
        assert_eq!(days[4].body, "第二次");
    }

    #[test]
    fn a_heading_inside_a_code_block_does_not_start_a_day() {
        assert_eq!(ids("## 261101周日\n\n```\n## 261102周一\n```\n\n## 261103周二"), ["261101", "261103"]);
    }

    #[test]
    fn saving_a_body_leaves_every_other_byte_alone() {
        let (next, id) = saved(edit(FILE, "2611", Some("261101"), None, Some("- 早起\n\t- 跑步\n\n一段话"), Change::Body("- 早起\n\t- 跑步 5km\n"), false).unwrap());
        assert_eq!(id.as_deref(), Some("261101"));
        assert_eq!(next, FILE.replace("\t- 跑步\n\n一段话", "\t- 跑步 5km"));
        let (next, _) = saved(edit(FILE, "2611", Some("261103"), None, Some(""), Change::Body("补上"), false).unwrap());
        assert_eq!(next, FILE.replace("## 261103周二\n", "## 261103周二\n\n补上\n"));
        let (next, _) = saved(edit(FILE, "2611", Some("261102-2"), None, Some("第二次"), Change::Body(""), false).unwrap());
        assert!(next.ends_with("## 261102周一"));
    }

    #[test]
    fn new_days_go_to_the_end_with_a_heading() {
        let (next, id) = saved(edit(FILE, "2611", None, Some("261104"), None, Change::Body("- 新"), false).unwrap());
        assert_eq!(next, format!("{FILE}\n\n---\n\n## 261104周三\n\n- 新"));
        assert_eq!(id.as_deref(), Some("261104"));
        let (next, _) = saved(edit("## 261101周日\n\n- a\n\n---\n", "2611", None, Some("261102"), None, Change::Body(""), false).unwrap());
        assert_eq!(next, "## 261101周日\n\n- a\n\n---\n\n## 261102周一\n\n---\n");
        let (next, _) = saved(edit("", "2611", None, Some("261101"), None, Change::Body("- "), false).unwrap());
        assert_eq!(next, "## 261101周日\n\n- \n");
        assert!(edit("", "2611", None, Some("261201"), None, Change::Body("x"), false).is_err());
        assert!(edit("", "2611", None, Some("261131"), None, Change::Body("x"), false).is_err());
    }

    #[test]
    fn a_body_cannot_hold_another_day_heading() {
        assert!(edit(FILE, "2611", Some("261103"), None, Some(""), Change::Body("x\n\n## 261104周三\n\ny"), false).is_err());
    }

    #[test]
    fn a_day_changed_on_disk_is_a_conflict_until_forced() {
        assert_eq!(edit(FILE, "2611", Some("261102-2"), None, Some("旧"), Change::Body("我的"), false).unwrap(), Edit::Conflict(Some("第二次".into())));
        let (next, _) = saved(edit(FILE, "2611", Some("261102-2"), None, Some("旧"), Change::Body("我的"), true).unwrap());
        assert!(next.ends_with("## 261102周一\n\n我的"));
        assert_eq!(edit(FILE, "2611", Some("261109"), None, Some("x"), Change::Body("y"), false).unwrap(), Edit::Conflict(None));
    }

    #[test]
    fn deleting_a_day_takes_its_gap_with_it() {
        let (next, id) = saved(edit(FILE, "2611", Some("261103"), None, Some(""), Change::Delete, false).unwrap());
        assert_eq!(id, None);
        // The gap after the deleted day goes with it; the one before it (here an old blank-line gap) stays.
        assert!(next.contains("下半天\n\n## 261102周一"));
        let (next, _) = saved(edit(FILE, "2611", Some("261102-2"), None, Some("第二次"), Change::Delete, false).unwrap());
        assert!(next.ends_with("## 261103周二"));
        let (next, _) = saved(edit("## 261101周日\n", "2611", Some("261101"), None, Some(""), Change::Delete, false).unwrap());
        assert_eq!(next, "");
    }

    /// `BETA_LIFE_DIARY_DIR=<folder of YYMM diary.md> cargo test real_diaries -- --ignored --nocapture`:
    /// re-saving every day unchanged must give back the same bytes. Read only.
    #[test]
    #[ignore]
    fn real_diaries_survive_saving_every_day() {
        let dir = PathBuf::from(std::env::var("BETA_LIFE_DIARY_DIR").expect("set BETA_LIFE_DIARY_DIR"));
        for path in md_files(&dir, false) {
            let Some(month) = stem(&path).strip_suffix(" diary").filter(|month| valid_month(month)).map(str::to_string) else { continue };
            let file = read_md(&path).unwrap();
            let days = parse(&file);
            for day in &days {
                let Ok(Edit::Saved(next, id)) = edit(&file, &month, Some(&day.id), None, Some(&day.body), Change::Body(&day.body), false) else {
                    panic!("{month} {}: not saved", day.id);
                };
                // Private text: report positions only, never the content.
                let differs = next.bytes().zip(file.bytes()).position(|(left, right)| left != right);
                assert!(next == file, "{month} {}: differs at byte {differs:?} (lengths {} / {})", day.id, next.len(), file.len());
                assert!(id.as_deref() == Some(day.id.as_str()), "{month} {}: saved as {id:?}", day.id);
            }
            println!("{month}: {} sections, {} with a repeated date", days.len(), days.iter().filter(|day| day.id.contains('-')).count());
        }
    }

    #[test]
    fn save_writes_the_month_file_and_lists_months() {
        let root = test_root("diary");
        let request = |body: &str, id: Option<&str>, base: Option<&str>, delete: bool| SaveDay {
            month: "2611".into(),
            id: id.map(str::to_string),
            date: Some("261111".into()),
            base: base.map(str::to_string),
            body: body.into(),
            delete,
            force: false,
        };
        let SaveOutcome::Saved { id, month } = save(&root, request("- 写日记", None, None, false)).unwrap() else { panic!() };
        assert_eq!(id.as_deref(), Some("261111"));
        assert_eq!(month.days[0].title, "261111周三");
        assert_eq!(std::fs::read_to_string(root.join("日记/2611 diary.md")).unwrap(), "## 261111周三\n\n- 写日记\n");
        std::fs::write(root.join("日记/diary-temp.md"), "x").unwrap();
        assert_eq!(months(&root), ["2611"]);
        save(&root, request("", Some("261111"), Some("- 写日记"), true)).unwrap();
        assert!(!root.join("日记/2611 diary.md").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
