//! 社交模拟器: `社交模拟器/<角色名>/` with two profile files and one md per practice version.
//!
//! - `角色设定.md`: 身份与场景、性格、`## 可能会问的问题` (the question bank).
//! - `应对与正样本.md`: `## 原则` and `## 正样本`.
//! - `QA记录/<主题><YYMMDD>.md`: one version. A version for the same topic on the same day gets `-2`.
//!   Frontmatter holds `question`, `topic`, `starred`, `status`; the body is flat `Q：` / `A：` turns,
//!   each with an optional `> 7/10 · 点评` line, and an optional trailing `## 评估`.

use super::fm::{self, raw, s};
use super::{claim_name, file_stem, fenced_lines, issue, md_files, name_key, read_md, rename_dir, trash, used_names, write_md, Issue, META, SOCIAL};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(crate) const ROLE: &str = "角色设定.md";
pub(crate) const PLAYBOOK: &str = "应对与正样本.md";
const RECORDS: &str = "QA记录";
const QUESTIONS: &str = "## 可能会问的问题";
const EVALUATION: &str = "## 评估";

pub(crate) fn tab(root: &Path) -> PathBuf {
    root.join(SOCIAL)
}

fn role_dir(root: &Path, role: &str) -> PathBuf {
    tab(root).join(role)
}

fn meta(root: &Path) -> PathBuf {
    tab(root).join(META)
}

pub(crate) fn role_template() -> String {
    "## 身份与场景\n\n## 性格\n\n## 可能会问的问题\n".into()
}

pub(crate) fn playbook_template() -> String {
    "## 原则\n\n## 正样本\n".into()
}

/// `YYMMDD` of today, local time.
pub(crate) fn today_code() -> String {
    let today = chrono::Local::now().date_naive();
    format!("{:02}{:02}{:02}", today.year() % 100, today.month(), today.day())
}

/// The file name of a new version: `<topic><YYMMDD>`, or `-2`, `-3`… when that day already has one.
fn version_name(topic: &str, date: &str, used: &mut HashSet<String>) -> String {
    let stem = format!("{}{date}", file_stem(topic, "练习"));
    let mut candidate = stem.clone();
    let mut number = 2;
    while used.contains(&name_key(&candidate)) {
        candidate = format!("{stem}-{number}");
        number += 1;
    }
    used.insert(name_key(&candidate));
    candidate
}

// ---------- Q/A parsing ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnScore {
    pub(crate) score: u8,
    pub(crate) comment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Turn {
    pub(crate) question: String,
    pub(crate) answer: String,
    pub(crate) score: Option<TurnScore>,
}

/// A `Q：` or `A：` line, with the label and the text after it.
fn labeled(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let (label, rest) = trimmed.split_once(['：', ':'])?;
    (indent == 0 && (label == "Q" || label == "A")).then_some((label, rest.trim()))
}

/// A score line `> 7/10 · 点评`; anything else is ordinary text.
fn score_line(line: &str) -> Option<TurnScore> {
    let rest = line.trim().strip_prefix('>')?.trim();
    let (score, comment) = rest.split_once("/10")?;
    let score = score.trim().parse::<u8>().ok().filter(|score| (1..=10).contains(score))?;
    let comment = comment.trim().trim_start_matches(['·', '•', '-', ' ']).trim().to_string();
    Some(TurnScore { score, comment })
}

/// A version body: text before the first `Q：` (kept as is), the turns, and `## 评估`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Body {
    pub(crate) preamble: String,
    pub(crate) turns: Vec<Turn>,
    pub(crate) evaluation: String,
}

struct Draft {
    question: Vec<String>,
    answer: Option<Vec<String>>,
    score: Option<TurnScore>,
}

impl Draft {
    fn finish(self) -> Turn {
        let join = |lines: &[String]| super::trim_blank_lines(&lines.join("\n"));
        Turn {
            question: join(&self.question),
            answer: self.answer.as_deref().map(join).unwrap_or_default(),
            score: self.score,
        }
    }
}

/// Flat turns: `Q：` starts a turn, `A：` answers it, `> 7/10 · 点评` after the answer scores it.
/// Labels inside a fence or a bullet stay text; an `A：` without a question stays preamble text.
pub(crate) fn parse_body(body: &str) -> Body {
    let lines = fenced_lines(body);
    let eval_at = lines.iter().rposition(|(line, fenced)| !fenced && line.trim_end() == EVALUATION);
    let mut preamble: Vec<&str> = Vec::new();
    let mut turns = Vec::new();
    let mut draft: Option<Draft> = None;
    for (line, fenced) in &lines[..eval_at.unwrap_or(lines.len())] {
        let label = if *fenced { None } else { labeled(line) };
        match (label, draft.as_mut()) {
            (Some(("Q", text)), _) => {
                if let Some(done) = draft.take() {
                    turns.push(done.finish());
                }
                draft = Some(Draft { question: vec![text.to_string()], answer: None, score: None });
            }
            (Some(("A", text)), Some(current)) if current.answer.is_none() => {
                current.answer = Some(vec![text.to_string()]);
            }
            (_, Some(current)) => {
                if !fenced && current.answer.is_some() && current.score.is_none() {
                    if let Some(score) = score_line(line) {
                        current.score = Some(score);
                        continue;
                    }
                }
                match current.answer.as_mut() {
                    Some(answer) => answer.push(line.to_string()),
                    None => current.question.push(line.to_string()),
                }
            }
            (_, None) => preamble.push(line),
        }
    }
    if let Some(done) = draft {
        turns.push(done.finish());
    }
    let evaluation = eval_at
        .map(|index| super::trim_blank_lines(&lines[index + 1..].iter().map(|(line, _)| *line).collect::<Vec<_>>().join("\n")))
        .unwrap_or_default();
    Body { preamble: super::trim_blank_lines(&preamble.join("\n")), turns, evaluation }
}

/// Renders turns back; the first line of a question or answer stays on the label line.
fn render_body(body: &Body) -> String {
    let mut output = String::new();
    if !body.preamble.is_empty() {
        output.push_str(&body.preamble);
        output.push('\n');
    }
    for turn in &body.turns {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("Q：");
        output.push_str(&turn.question);
        output.push('\n');
        output.push_str("A：");
        // A list starts on its own line so Obsidian renders it as a list.
        if starts_with_bullet(&turn.answer) {
            output.push('\n');
        }
        output.push_str(&turn.answer);
        output.push('\n');
        if let Some(score) = &turn.score {
            output.push_str(&format!("> {}/10 · {}\n", score.score, score.comment));
        }
    }
    if !body.evaluation.trim().is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(EVALUATION);
        output.push('\n');
        output.push_str(body.evaluation.trim());
        output.push('\n');
    }
    output
}

fn bullet(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") || matches!(trimmed, "-" | "*" | "+")
}

fn starts_with_bullet(text: &str) -> bool {
    text.lines().next().is_some_and(bullet)
}

/// Deepest bullet nesting in `text` (tabs or spaces, any width), fenced lines ignored. `0` = no bullets.
pub(crate) fn bullet_depth(text: &str) -> usize {
    let mut indents: Vec<usize> = Vec::new();
    let mut deepest = 0;
    for (line, fenced) in fenced_lines(text) {
        if fenced || !bullet(line) {
            continue;
        }
        let width: usize = line.chars().take_while(|c| c.is_whitespace()).map(|c| if c == '\t' { 4 } else { 1 }).sum();
        while indents.last().is_some_and(|last| *last > width) {
            indents.pop();
        }
        if indents.last() != Some(&width) {
            indents.push(width);
        }
        deepest = deepest.max(indents.len());
    }
    deepest
}

// ---------- versions ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Version {
    /// The file stem, e.g. `进度询问261111`.
    pub(crate) id: String,
    pub(crate) question: String,
    pub(crate) topic: String,
    pub(crate) starred: bool,
    /// `open` or `done`.
    pub(crate) status: String,
    pub(crate) turns: Vec<Turn>,
    pub(crate) evaluation: String,
    /// Text before the first `Q：`, written back unchanged.
    #[serde(skip)]
    pub(crate) preamble: String,
}

fn status_of(value: Option<String>) -> String {
    match value.as_deref() {
        Some("done") => "done".to_string(),
        _ => "open".to_string(),
    }
}

pub(crate) fn parse_version(text: &str, id: &str) -> Result<Version, String> {
    let (front, body) = fm::parse(text)?;
    let Body { preamble, turns, evaluation } = parse_body(&body);
    Ok(Version {
        id: id.to_string(),
        question: front.get("question").unwrap_or_default(),
        topic: front.get("topic").unwrap_or_default(),
        starred: matches!(front.get("starred").as_deref(), Some("true")),
        status: status_of(front.get("status")),
        turns,
        evaluation,
        preamble,
    })
}

pub(crate) fn serialize_version(version: &Version) -> String {
    fm::render(
        &[
            ("question", s(&version.question)),
            ("topic", s(&version.topic)),
            ("starred", raw(version.starred)),
            ("status", s(&version.status)),
        ],
        &render_body(&Body { preamble: version.preamble.clone(), turns: version.turns.clone(), evaluation: version.evaluation.clone() }),
    )
}

fn records_dir(root: &Path, role: &str) -> PathBuf {
    role_dir(root, role).join(RECORDS)
}

/// Every version of one role, oldest file first; unreadable files become issues and are skipped.
pub(crate) fn load_versions(root: &Path, role: &str) -> (Vec<(PathBuf, Version)>, Vec<Issue>) {
    let mut issues = Vec::new();
    let mut versions = Vec::new();
    for path in md_files(&records_dir(root, role), false) {
        match read_md(&path).and_then(|text| parse_version(&text, &super::stem(&path))) {
            Ok(version) => versions.push((path, version)),
            Err(error) => issues.push(issue("social", root, &path, error)),
        }
    }
    (versions, issues)
}

fn find_version(root: &Path, role: &str, id: &str) -> Result<(PathBuf, Version), String> {
    load_versions(root, role)
        .0
        .into_iter()
        .find(|(_, version)| version.id == id)
        .ok_or_else(|| format!("没有这个版本：{id}"))
}

fn write_version(path: &Path, version: &Version) -> Result<(), String> {
    write_md(path, &serialize_version(version))
}

// ---------- roles ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionSummary {
    pub(crate) id: String,
    pub(crate) date: String,
    pub(crate) starred: bool,
    pub(crate) status: String,
    /// Mean of the scored turns, one decimal; absent when nothing is scored yet.
    pub(crate) average: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionGroup {
    pub(crate) question: String,
    pub(crate) topic: String,
    pub(crate) versions: Vec<VersionSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoleSummary {
    pub(crate) name: String,
    pub(crate) scene: String,
    pub(crate) favorites: Vec<VersionSummary>,
    pub(crate) questions: Vec<QuestionGroup>,
}

/// The first non-empty bullet under `## 身份与场景`, shown next to the role name.
fn scene_of(text: &str) -> String {
    let (_, body) = split_front(text);
    let lines = fenced_lines(body);
    let start = lines.iter().position(|(line, fenced)| !fenced && line.trim_end() == "## 身份与场景");
    let Some(start) = start else { return String::new() };
    lines
        .iter()
        .skip(start + 1)
        .take_while(|(line, fenced)| *fenced || !line.trim_end().starts_with("## "))
        .filter_map(|(line, fenced)| (!fenced).then_some(*line))
        .map(str::trim)
        .find_map(|line| line.strip_prefix(['-', '*', '+']).map(str::trim))
        .filter(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Bullets under `## 可能会问的问题`.
fn bank_questions(text: &str) -> Vec<String> {
    let (_, body) = split_front(text);
    let lines = fenced_lines(body);
    let Some(start) = lines.iter().position(|(line, fenced)| !fenced && line.trim_end() == QUESTIONS) else {
        return Vec::new();
    };
    lines
        .iter()
        .skip(start + 1)
        .take_while(|(line, fenced)| *fenced || !line.trim_end().starts_with("## "))
        .filter(|(_, fenced)| !fenced)
        .filter_map(|(line, _)| line.trim().strip_prefix(['-', '*', '+']).map(str::trim))
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The raw frontmatter block (with its closing line) and the body after it.
fn split_front(text: &str) -> (&str, &str) {
    if let Some(rest) = text.strip_prefix("---\n") {
        let mut offset = 4;
        for line in rest.split_inclusive('\n') {
            offset += line.len();
            if matches!(line.trim_end(), "---" | "...") {
                return (&text[..offset], &text[offset..]);
            }
        }
    }
    ("", text)
}

/// Appends `question` to the bank unless it is already there; returns whether it changed.
/// Everything outside the bank section is kept byte for byte.
pub(crate) fn add_bank_question(text: &str, question: &str) -> (String, bool) {
    let question = question.trim();
    if question.is_empty() || bank_questions(text).iter().any(|item| item == question) {
        return (text.to_string(), false);
    }
    let (front, body) = split_front(text);
    let lines: Vec<&str> = body.split('\n').collect();
    let fenced = fenced_lines(body);
    let bullet = format!("- {question}");
    let body = match fenced.iter().position(|(line, fenced)| !fenced && line.trim_end() == QUESTIONS) {
        Some(index) => {
            let end = fenced
                .iter()
                .skip(index + 1)
                .position(|(line, fenced)| !fenced && line.trim_end().starts_with("## "))
                .map_or(lines.len(), |offset| index + 1 + offset);
            let mut head = lines[..end].to_vec();
            let mut gap = 0;
            while head.len() > index + 1 && head.last().is_some_and(|line| line.trim().is_empty()) {
                head.pop();
                gap += 1;
            }
            head.push(bullet.as_str());
            let mut next = head.join("\n");
            let tail = lines[end..].join("\n");
            if end < lines.len() {
                next.push_str(&"\n".repeat(gap.max(1) + 1));
                next.push_str(&tail);
            } else {
                next.push('\n');
            }
            next
        }
        None => format!("{}\n\n{QUESTIONS}\n{bullet}\n", body.trim_end()),
    };
    (format!("{front}{body}"), true)
}

fn date_of(id: &str) -> String {
    id.chars()
        .rev()
        .skip_while(|character| !character.is_ascii_digit())
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn average_of(version: &Version) -> Option<f32> {
    let scores: Vec<u8> = version.turns.iter().filter_map(|turn| turn.score.as_ref().map(|score| score.score)).collect();
    if scores.is_empty() {
        None
    } else {
        let mean = scores.iter().map(|score| f32::from(*score)).sum::<f32>() / scores.len() as f32;
        Some((mean * 10.0).round() / 10.0)
    }
}

fn summary_of(version: &Version) -> VersionSummary {
    VersionSummary {
        id: version.id.clone(),
        date: date_of(&version.id),
        starred: version.starred,
        status: version.status.clone(),
        average: average_of(version),
    }
}

/// One role's tree: the two files are implicit, then favorites, then questions with their versions.
pub(crate) fn role_summary(root: &Path, name: &str) -> Result<(RoleSummary, Vec<Issue>), String> {
    let dir = role_dir(root, name);
    let role_text = read_md(&dir.join(ROLE)).unwrap_or_default();
    let bank = bank_questions(&role_text);
    let (versions, issues) = load_versions(root, name);
    let mut groups: Vec<QuestionGroup> = Vec::new();
    for (_, version) in &versions {
        let summary = summary_of(version);
        match groups.iter_mut().find(|group| group.question == version.question) {
            Some(group) => group.versions.push(summary),
            None => groups.push(QuestionGroup {
                question: version.question.clone(),
                topic: version.topic.clone(),
                versions: vec![summary],
            }),
        }
    }
    for question in bank {
        if !groups.iter().any(|group| group.question == question) {
            groups.push(QuestionGroup { question, topic: String::new(), versions: Vec::new() });
        }
    }
    let favorites = versions.iter().filter(|(_, version)| version.starred).map(|(_, version)| summary_of(version)).collect();
    Ok((RoleSummary { name: name.to_string(), scene: scene_of(&role_text), favorites, questions: groups }, issues))
}

pub(crate) fn list_roles(root: &Path) -> Result<(Vec<RoleSummary>, Vec<Issue>), String> {
    let mut roles = Vec::new();
    let mut issues = Vec::new();
    for name in super::subdirs(&tab(root)) {
        let (role, role_issues) = role_summary(root, &name)?;
        roles.push(role);
        issues.extend(role_issues);
    }
    Ok((roles, issues))
}

// ---------- commands ----------

use tauri::AppHandle;

fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("角色名不能为空，也不能包含 / 或 \\".into());
    }
    Ok(name.to_string())
}

#[tauri::command]
pub(crate) fn list_social_roles(app: AppHandle) -> Result<Vec<RoleSummary>, String> {
    let (_guard, root) = super::open(&app)?;
    let (roles, issues) = list_roles(&root)?;
    super::set_issues("social", issues);
    Ok(roles)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SocialFile {
    pub(crate) body: String,
}

#[tauri::command]
pub(crate) fn load_social_file(app: AppHandle, role: String, kind: String) -> Result<SocialFile, String> {
    let (_guard, root) = super::open(&app)?;
    let name = if kind == "playbook" { PLAYBOOK } else { ROLE };
    let path = role_dir(&root, &role).join(name);
    let body = if path.exists() { read_md(&path)? } else { String::new() };
    Ok(SocialFile { body })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveFileRequest {
    role: String,
    kind: String,
    /// The body as last read; a different body on disk is a conflict unless `force`.
    base: String,
    body: String,
    force: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum SaveFileOutcome {
    Saved,
    Conflict { current: String },
}

#[tauri::command]
pub(crate) fn save_social_file(app: AppHandle, request: SaveFileRequest) -> Result<SaveFileOutcome, String> {
    let (_guard, root) = super::open(&app)?;
    let name = if request.kind == "playbook" { PLAYBOOK } else { ROLE };
    let path = role_dir(&root, &checked_name(&request.role)?).join(name);
    let current = if path.exists() { read_md(&path)? } else { String::new() };
    if !request.force && current != request.base {
        return Ok(SaveFileOutcome::Conflict { current });
    }
    write_md(&path, &request.body)?;
    Ok(SaveFileOutcome::Saved)
}

#[tauri::command]
pub(crate) fn load_social_version(app: AppHandle, role: String, id: String) -> Result<Version, String> {
    let (_guard, root) = super::open(&app)?;
    Ok(find_version(&root, &role, &id)?.1)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveVersionRequest {
    role: String,
    id: String,
    turns: Vec<Turn>,
    evaluation: String,
    status: String,
}

#[tauri::command]
pub(crate) fn save_social_version(app: AppHandle, request: SaveVersionRequest) -> Result<Version, String> {
    let (_guard, root) = super::open(&app)?;
    let (path, mut version) = find_version(&root, &request.role, &request.id)?;
    version.turns = request.turns;
    version.evaluation = request.evaluation;
    version.status = status_of(Some(request.status));
    write_version(&path, &version)?;
    Ok(version)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewVersionRequest {
    role: String,
    question: String,
    topic: String,
}

#[tauri::command]
pub(crate) fn new_social_version(app: AppHandle, request: NewVersionRequest) -> Result<Version, String> {
    let (_guard, root) = super::open(&app)?;
    let role = checked_name(&request.role)?;
    let question = request.question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".into());
    }
    let topic = {
        let trimmed = request.topic.trim();
        if trimmed.is_empty() { file_stem(&question, "练习") } else { trimmed.to_string() }
    };
    let dir = records_dir(&root, &role);
    let mut used = used_names(&dir);
    let name = version_name(&topic, &today_code(), &mut used);
    let version = Version {
        id: name.clone(),
        question,
        topic,
        starred: false,
        status: "open".into(),
        turns: vec![Turn { question: request.question.trim().to_string(), answer: String::new(), score: None }],
        evaluation: String::new(),
        preamble: String::new(),
    };
    write_version(&dir.join(format!("{name}.md")), &version)?;
    Ok(version)
}

#[tauri::command]
pub(crate) fn set_social_star(app: AppHandle, role: String, id: String, starred: bool) -> Result<(), String> {
    let (_guard, root) = super::open(&app)?;
    let (path, mut version) = find_version(&root, &role, &id)?;
    version.starred = starred;
    write_version(&path, &version)
}

#[tauri::command]
pub(crate) fn new_social_role(app: AppHandle, name: String) -> Result<String, String> {
    let (_guard, root) = super::open(&app)?;
    let desired = file_stem(&checked_name(&name)?, "未命名角色");
    let mut used: HashSet<String> = super::subdirs(&tab(&root)).iter().map(|dir| name_key(dir)).collect();
    let claimed = claim_name(&desired, &mut used);
    let dir = role_dir(&root, &claimed);
    write_md(&dir.join(ROLE), &role_template())?;
    write_md(&dir.join(PLAYBOOK), &playbook_template())?;
    Ok(claimed)
}

#[tauri::command]
pub(crate) fn add_social_question(app: AppHandle, role: String, question: String) -> Result<bool, String> {
    let (_guard, root) = super::open(&app)?;
    let path = role_dir(&root, &checked_name(&role)?).join(ROLE);
    let current = if path.exists() { read_md(&path)? } else { role_template() };
    let (next, added) = add_bank_question(&current, &question);
    if added {
        write_md(&path, &next)?;
    }
    Ok(added)
}

/// Moves a role folder or one version into `社交模拟器/.beta-life/trash/`.
#[tauri::command]
pub(crate) fn trash_social(app: AppHandle, role: String, id: Option<String>) -> Result<(), String> {
    let (_guard, root) = super::open(&app)?;
    let role = checked_name(&role)?;
    match id {
        Some(id) => {
            let (path, _) = find_version(&root, &role, &id)?;
            trash(&meta(&root), &path)
        }
        None => {
            let dir = role_dir(&root, &role);
            if !dir.is_dir() {
                return Err(format!("没有这个角色：{role}"));
            }
            trash(&meta(&root), &dir)
        }
    }
}

/// Renames a role folder, appending ` 2` when the target name is taken.
#[tauri::command]
pub(crate) fn rename_social_role(app: AppHandle, role: String, name: String) -> Result<String, String> {
    let (_guard, root) = super::open(&app)?;
    let role = checked_name(&role)?;
    let desired = file_stem(&checked_name(&name)?, "未命名角色");
    if name_key(&desired) == name_key(&role) {
        return Ok(role);
    }
    let mut used: HashSet<String> = super::subdirs(&tab(&root)).iter().map(|dir| name_key(dir)).collect();
    used.remove(&name_key(&role));
    let claimed = claim_name(&desired, &mut used);
    rename_dir(&role_dir(&root, &role), &role_dir(&root, &claimed))?;
    Ok(claimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::test_root;

    const SAMPLE: &str = "\
Q：这学期进展怎么样？
A：论文 A 已投；下一步补两组对照实验。
> 8/10 · 先给结论，有重点

Q：那 B 为什么还没投？
A：
- 缺口：第三批样本没回来
  - 已催，12/5 前
- 兜底：先写初稿
> 6/10 · 略被动

## 评估
- 被追问时先给可核对的事实
";

    #[test]
    fn parses_flat_turns_with_scores_and_an_evaluation() {
        let Body { turns, evaluation, .. } = parse_body(SAMPLE);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].question, "这学期进展怎么样？");
        assert_eq!(turns[0].score, Some(TurnScore { score: 8, comment: "先给结论，有重点".into() }));
        assert_eq!(turns[1].answer, "- 缺口：第三批样本没回来\n  - 已催，12/5 前\n- 兜底：先写初稿");
        assert_eq!(turns[1].score.as_ref().map(|score| score.score), Some(6));
        assert_eq!(evaluation, "- 被追问时先给可核对的事实");
    }

    #[test]
    fn a_label_inside_a_fence_or_a_bullet_stays_text() {
        let body = "Q：问\nA：\n- 例子：Q：这不是新的一轮\n```\nQ：代码里的\n```\n> 9/10 · 好\n";
        let turns = parse_body(body).turns;
        assert_eq!(turns.len(), 1);
        assert!(turns[0].answer.contains("Q：这不是新的一轮"));
        assert!(turns[0].answer.contains("Q：代码里的"));
        assert_eq!(turns[0].score.as_ref().map(|score| score.score), Some(9));
    }

    #[test]
    fn turns_round_trip() {
        let body = parse_body(&format!("开头的笔记\n\n{SAMPLE}"));
        assert_eq!(body.preamble, "开头的笔记");
        assert_eq!(parse_body(&render_body(&body)), body);
    }

    #[test]
    fn bullet_depth_counts_two_levels_and_ignores_fences() {
        assert_eq!(bullet_depth("- 一\n  - 二\n"), 2);
        assert_eq!(bullet_depth("- 一\n  - 二\n    - 三\n"), 3);
        assert_eq!(bullet_depth("```\n- 代码\n```\n普通文字\n"), 0);
    }

    #[test]
    fn a_second_version_the_same_day_gets_a_suffix() {
        let root = test_root("social");
        let dir = records_dir(&root, "王老师");
        std::fs::create_dir_all(&dir).unwrap();
        let mut used = used_names(&dir);
        let first = version_name("进度询问", "261123", &mut used);
        write_md(&dir.join(format!("{first}.md")), "").unwrap();
        let mut used = used_names(&dir);
        assert_eq!(first, "进度询问261123");
        assert_eq!(version_name("进度询问", "261123", &mut used), "进度询问261123-2");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn starring_and_saving_round_trip_through_the_file() {
        let root = test_root("social-star");
        let dir = records_dir(&root, "王老师");
        let version = Version {
            id: "进度询问261111".into(),
            question: "这学期进展怎么样？".into(),
            topic: "进度询问".into(),
            starred: false,
            status: "open".into(),
            turns: parse_body(SAMPLE).turns,
            evaluation: String::new(),
            preamble: String::new(),
        };
        let path = dir.join("进度询问261111.md");
        write_version(&path, &version).unwrap();
        let loaded = parse_version(&read_md(&path).unwrap(), "x").unwrap();
        assert_eq!(loaded.turns, version.turns);
        assert!(!loaded.starred);

        let mut starred = loaded;
        starred.starred = true;
        starred.status = "done".into();
        write_version(&path, &starred).unwrap();
        let again = parse_version(&read_md(&path).unwrap(), "x").unwrap();
        assert!(again.starred);
        assert_eq!(again.status, "done");
        assert_eq!(average_of(&again), Some(7.0));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_question_bank_grows_without_duplicates() {
        let template = role_template();
        let (once, added) = add_bank_question(&template, "这学期进展怎么样？");
        assert!(added);
        assert_eq!(bank_questions(&once), vec!["这学期进展怎么样？".to_string()]);
        let (twice, added) = add_bank_question(&once, "这学期进展怎么样？");
        assert!(!added);
        assert_eq!(twice, once);
        let (more, _) = add_bank_question(&once, "毕业后什么打算？");
        assert_eq!(bank_questions(&more), vec!["这学期进展怎么样？".to_string(), "毕业后什么打算？".to_string()]);
    }

    #[test]
    fn an_unpracticed_bank_question_shows_as_an_empty_group() {
        let root = test_root("social-tree");
        let dir = role_dir(&root, "王老师");
        write_md(&dir.join(ROLE), &add_bank_question(&role_template(), "你的工作和组里别人怎么区分？").0).unwrap();
        let version = Version {
            id: "进度询问261111".into(),
            question: "这学期进展怎么样？".into(),
            topic: "进度询问".into(),
            starred: true,
            status: "done".into(),
            turns: parse_body(SAMPLE).turns,
            evaluation: String::new(),
            preamble: String::new(),
        };
        write_version(&records_dir(&root, "王老师").join("进度询问261111.md"), &version).unwrap();
        let (summary, issues) = role_summary(&root, "王老师").unwrap();
        assert!(issues.is_empty());
        assert_eq!(summary.favorites.len(), 1);
        assert_eq!(summary.questions.len(), 2);
        assert!(summary.questions.iter().any(|group| group.question == "你的工作和组里别人怎么区分？" && group.versions.is_empty()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trashing_a_version_removes_it_and_keeps_a_copy() {
        let root = test_root("social-trash");
        let dir = records_dir(&root, "王老师");
        let path = dir.join("进度询问261111.md");
        write_md(&path, "Q：问\nA：答\n").unwrap();
        trash(&meta(&root), &path).unwrap();
        assert!(!path.exists());
        let trash_dir = meta(&root).join("trash");
        assert_eq!(std::fs::read_dir(&trash_dir).unwrap().flatten().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
