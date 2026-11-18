//! 昨天的 to-do: the first time the user is around in the morning, bebe lists what the last diary day
//! said it would do and did not mark done. The AI reads them out of free text (the diary has no check
//! boxes); the 聊一下 conversation (`carry_todos` task) then marks them ✅ / ❎ or moves them to today.

use crate::{call_provider, load_settings, read_api_key, vault, AppSettings};
use chrono::{Duration as Days, NaiveDate};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashSet, path::Path, time::Duration};
use tauri::AppHandle;

const DEFAULT_DIARY_TODOS_PROMPT: &str = r#"从日记里找出还没做完的 to-do：
1. 算 to-do：写了要做、打算做、还需要做，但这一天的日记里没写已经做完的事；一句话里列了好几件就拆开，一件一条。
2. 不算：已经做完的事、感想和记录、习惯统计，以及后面已经标了 ✅ 或 ❎ 的。
3. 每条用日记原话里最短又能看懂的说法，不超过 30 个字，不改意思；语言跟日记一致。"#;

pub(crate) fn default_diary_todos_prompt() -> String {
    DEFAULT_DIARY_TODOS_PROMPT.into()
}

/// The user-editable part, shared by the morning list and the 聊一下 task.
pub(crate) fn todos_prompt(settings: &AppSettings) -> &str {
    let prompt = settings.ai.diary_todos_prompt.trim();
    if prompt.is_empty() { DEFAULT_DIARY_TODOS_PROMPT } else { prompt }
}

/// The last diary day is looked for this many days back.
const LOOK_BACK_DAYS: i64 = 7;
const MAX_TODOS: usize = 20;
/// The prompt asks for 30 characters; a little over still fits the bubble.
const TODO_MAX_CHARS: usize = 60;

/// The hand-written part of a day: everything above the 【AI总结】 line.
fn hand_written(body: &str) -> String {
    body.lines().take_while(|line| !line.contains("【AI总结】")).collect::<Vec<_>>().join("\n").trim().to_string()
}

fn day_code(date: NaiveDate) -> String {
    date.format("%y%m%d").to_string()
}

/// The latest day before `today` (at most `LOOK_BACK_DAYS` back) with something hand-written:
/// its `YYMMDD` and that part of its body.
fn last_day(root: &Path, today: NaiveDate) -> Result<Option<(String, String)>, String> {
    let first = day_code(today - Days::days(LOOK_BACK_DAYS));
    let before = day_code(today);
    let mut months = vec![first[..4].to_string(), before[..4].to_string()];
    months.dedup();
    let mut best: Option<(String, String)> = None;
    for month in months {
        for day in vault::diary::parse(&vault::diary::read_month(root, &month)?) {
            let Some(date) = day.date else { continue };
            let text = hand_written(&day.body);
            if date.as_str() < first.as_str() || date.as_str() >= before.as_str() || text.is_empty() {
                continue;
            }
            // A repeated date (`YYMMDD-2`) keeps the later block.
            if best.as_ref().is_none_or(|(code, _)| date.as_str() >= code.as_str()) {
                best = Some((date, text));
            }
        }
    }
    Ok(best)
}

#[derive(Debug, Deserialize)]
struct TodosReply {
    todos: Vec<String>,
}

/// One line each, duplicates dropped; an empty list is fine (nothing left to do).
fn validate_todos(todos: Vec<String>) -> Result<Vec<String>, String> {
    if todos.len() > MAX_TODOS {
        return Err(format!("AI 最多返回 {MAX_TODOS} 条 to-do"));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for todo in todos {
        let text = todo.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > TODO_MAX_CHARS {
            return Err(format!("AI 返回的 to-do 应在 {TODO_MAX_CHARS} 个字以内"));
        }
        if seen.insert(text.clone()) {
            result.push(text);
        }
    }
    Ok(result)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoOffer {
    /// `YYMMDD` of the diary day the to-dos come from.
    day: String,
    todos: Vec<String>,
}

/// bebe's morning list; None when there is no recent day or nothing is left to do.
#[tauri::command]
pub(crate) async fn ai_diary_todos(app: AppHandle, today: String) -> Result<Option<TodoOffer>, String> {
    let today = NaiveDate::parse_from_str(&today, "%Y-%m-%d").map_err(|_| format!("日期应为 YYYY-MM-DD：{today}"))?;
    let found = {
        let (_guard, root) = vault::open(&app)?;
        last_day(&root, today)?
    };
    let Some((day, text)) = found else { return Ok(None) };
    let settings = load_settings(&app)?;
    let key = read_api_key(&app)?.ok_or_else(|| "请先在 Settings 中保存 API key".to_string())?;
    let base = settings.ai.base_url.trim().trim_end_matches('/');
    let endpoint = if base.ends_with("/chat/completions") { base.to_string() } else { format!("{base}/chat/completions") };
    let system = format!(
        "{}\n\n用户消息是一天日记里用户自己写的部分。\n\nJSON 输出协议：只返回一个有效 JSON object，不要附加 Markdown 代码块或解释：{{\"todos\": [\"一条 to-do\"]}}；没有就返回空数组。",
        todos_prompt(&settings)
    );
    let messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": text })];
    let client = Client::builder().timeout(Duration::from_secs(60)).build().map_err(|error| format!("无法初始化 AI 客户端：{error}"))?;
    let (content, _) = call_provider(&client, &endpoint, &key, &settings.ai, messages).await?;
    let reply: TodosReply = serde_json::from_str(&content).map_err(|error| format!("AI 没有返回有效的 to-do JSON：{error}"))?;
    let todos = validate_todos(reply.todos)?;
    Ok((!todos.is_empty()).then_some(TodoOffer { day, todos }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn picks_the_latest_written_day_before_today_within_a_week() {
        let root = vault::test_root("diary-todos");
        let dir = vault::diary::tab(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2610 diary.md"), "## 261030周五\n\n- 十月的事\n").unwrap();
        fs::write(
            dir.join("2611 diary.md"),
            "## 261101周日\n\n- 改论文\n\n=====【AI总结】=====\n\n- 习惯：完成 1/2\n\n---\n\n## 261102周一\n\n=====【AI总结】=====\n\n- 只有统计\n\n---\n\n## 261103周二\n\n- 今天的\n",
        )
        .unwrap();
        let date = |text: &str| NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap();
        // 11-02 has only Beta Life's statistics; 11-03 is today; the summary below the line is left out.
        assert_eq!(last_day(&root, date("2026-11-03")).unwrap(), Some(("261101".into(), "- 改论文".into())));
        // Across months.
        assert_eq!(last_day(&root, date("2026-11-01")).unwrap(), Some(("261030".into(), "- 十月的事".into())));
        // More than a week back: nothing.
        assert_eq!(last_day(&root, date("2026-11-20")).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn todos_are_single_lines_without_duplicates() {
        assert_eq!(validate_todos(vec![" 改 reference\n ".into(), "".into(), "改 reference".into(), "看 response letter".into()]).unwrap(), vec!["改 reference", "看 response letter"]);
        assert!(validate_todos(vec!["长".repeat(TODO_MAX_CHARS + 1)]).is_err());
        assert!(validate_todos(vec!["x".into(); MAX_TODOS + 1]).is_err());
        assert!(validate_todos(Vec::new()).unwrap().is_empty());
    }
}
