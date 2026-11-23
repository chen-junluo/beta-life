//! 社交模拟器: `社交模拟器/<角色名>/` with two profile files and one md per practice version.
//!
//! - `角色设定.md`: 身份与场景、性格、`## 可能会问的问题` (AI 的背景材料，不进左栏).
//! - `应对与正样本.md`: `## 原则` and `## 正样本`.
//! - `QA记录/<名>.md`: one version; the tree lists versions, grouped by their first question, and the
//!   tag next to a question is `topic`. Frontmatter holds `question`, `topic`, `starred`, `status`;
//!   the body is flat `Q：` / `A：` turns, each with an optional `> 7/10 · 点评` line, and an
//!   optional trailing `## 评估`.

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

/// `stem`, or `stem-2`, `stem-3`… when it is taken.
fn unique_name(stem: String, used: &mut HashSet<String>) -> String {
    let mut candidate = stem.clone();
    let mut number = 2;
    while used.contains(&name_key(&candidate)) {
        candidate = format!("{stem}-{number}");
        number += 1;
    }
    used.insert(name_key(&candidate));
    candidate
}

/// `id` without a trailing `-N` duplicate marker (`进度询问261111-2` → `进度询问261111`).
fn without_suffix(id: &str) -> &str {
    match id.rsplit_once('-') {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()) => head,
        _ => id,
    }
}

/// `id` without its trailing `YYMMDD`; the whole id when it has no date.
fn without_date(id: &str) -> &str {
    let id = without_suffix(id);
    match id.char_indices().rev().nth(5) {
        Some((at, _)) if id[at..].bytes().all(|byte| byte.is_ascii_digit()) => &id[..at],
        _ => id,
    }
}

/// True when `id` ends with `YYMMDD` and an optional `-N`, so a rename can keep the date.
fn has_date(id: &str) -> bool {
    without_date(id).len() < without_suffix(id).len()
}

/// The tag in a version id: everything before the trailing `YYMMDD` and any `-2`.
fn tag_of(id: &str) -> String {
    without_date(id).trim().to_string()
}

/// The file name of a new version: `<tag><YYMMDD>`, or `-2`, `-3`… when that day already has one.
/// An empty tag gives the bare date.
fn version_name(tag: &str, date: &str, used: &mut HashSet<String>) -> String {
    let tag = tag.trim();
    let stem = if tag.is_empty() { date.to_string() } else { format!("{}{date}", file_stem(tag, "练习")) };
    unique_name(stem, used)
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

/// A `C：`, `Q：` or `A：` line, with the label and the text after it.
fn labeled(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let (label, rest) = trimmed.split_once(['：', ':'])?;
    (indent == 0 && (label == "C" || label == "Q" || label == "A")).then_some((label, rest.trim()))
}

/// A score line `> 7/10 · 点评`; anything else is ordinary text.
fn score_line(line: &str) -> Option<TurnScore> {
    let rest = line.trim().strip_prefix('>')?.trim();
    let (score, comment) = rest.split_once("/10")?;
    let score = score.trim().parse::<u8>().ok().filter(|score| (1..=10).contains(score))?;
    let comment = comment.trim().trim_start_matches(['·', '•', '-', ' ']).trim().to_string();
    Some(TurnScore { score, comment })
}

/// A version body: text before the first `Q：` (kept as is), the `C：` context, the turns, and `## 评估`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Body {
    pub(crate) preamble: String,
    pub(crate) context: String,
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

/// Flat turns: `C：` opens the context, `Q：` starts a turn, `A：` answers it, `> 7/10 · 点评` after
/// the answer scores it. Labels inside a fence or a bullet stay text; an `A：` without a question
/// stays preamble text.
pub(crate) fn parse_body(body: &str) -> Body {
    let lines = fenced_lines(body);
    let eval_at = lines.iter().rposition(|(line, fenced)| !fenced && line.trim_end() == EVALUATION);
    let mut preamble: Vec<&str> = Vec::new();
    let mut context: Vec<&str> = Vec::new();
    let mut in_context = false;
    let mut turns = Vec::new();
    let mut draft: Option<Draft> = None;
    for (line, fenced) in &lines[..eval_at.unwrap_or(lines.len())] {
        let label = if *fenced { None } else { labeled(line) };
        match (label, draft.as_mut()) {
            (Some(("C", text)), _) => {
                if let Some(done) = draft.take() {
                    turns.push(done.finish());
                }
                context = vec![text];
                in_context = true;
            }
            (Some(("Q", text)), _) => {
                if let Some(done) = draft.take() {
                    turns.push(done.finish());
                }
                in_context = false;
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
            (_, None) if in_context => context.push(line),
            (_, None) => preamble.push(line),
        }
    }
    if let Some(done) = draft {
        turns.push(done.finish());
    }
    let evaluation = eval_at
        .map(|index| super::trim_blank_lines(&lines[index + 1..].iter().map(|(line, _)| *line).collect::<Vec<_>>().join("\n")))
        .unwrap_or_default();
    Body { preamble: super::trim_blank_lines(&preamble.join("\n")), context: super::trim_blank_lines(&context.join("\n")), turns, evaluation }
}

/// Renders turns back; the first line of a context, question or answer stays on the label line.
fn render_body(body: &Body) -> String {
    let mut output = String::new();
    if !body.preamble.is_empty() {
        output.push_str(&body.preamble);
        output.push('\n');
    }
    if !body.context.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("C：");
        output.push_str(&body.context);
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
    /// The `C：` line before the first turn: the premise the questions grow out of.
    pub(crate) context: String,
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
    let Body { preamble, context, turns, evaluation } = parse_body(&body);
    Ok(Version {
        id: id.to_string(),
        question: front.get("question").unwrap_or_default(),
        // The file name is the source of truth for the tag; frontmatter just mirrors it.
        topic: tag_of(id),
        starred: matches!(front.get("starred").as_deref(), Some("true")),
        status: status_of(front.get("status")),
        context,
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
        &render_body(&Body { preamble: version.preamble.clone(), context: version.context.clone(), turns: version.turns.clone(), evaluation: version.evaluation.clone() }),
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
    let (versions, issues) = load_versions(root, name);
    let mut groups: Vec<QuestionGroup> = Vec::new();
    for (_, version) in &versions {
        let summary = summary_of(version);
        // Versions still waiting for a starting question stand alone, keyed by their own id.
        match groups.iter_mut().find(|group| !version.question.is_empty() && group.question == version.question) {
            Some(group) => group.versions.push(summary),
            None => groups.push(QuestionGroup {
                question: version.question.clone(),
                topic: version.topic.clone(),
                versions: vec![summary],
            }),
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

/// The folder of a role that must already exist.
fn existing_role(root: &Path, role: &str) -> Result<PathBuf, String> {
    let dir = role_dir(root, &checked_name(role)?);
    if dir.is_dir() { Ok(dir) } else { Err(format!("角色「{}」已经不在了（改名或删除了）", role.trim())) }
}

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
    let path = role_dir(&root, &checked_name(&role)?).join(name);
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
    let path = existing_role(&root, &request.role)?.join(name);
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
    Ok(find_version(&root, &checked_name(&role)?, &id)?.1)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveVersionRequest {
    role: String,
    id: String,
    #[serde(default)]
    context: String,
    turns: Vec<Turn>,
    evaluation: String,
    status: String,
    starred: bool,
}

/// Writes the turns back, taking the group's question from the first turn.
pub(crate) fn save_turns(root: &Path, role: &str, id: &str, context: String, turns: Vec<Turn>, evaluation: &str, status: &str, starred: bool) -> Result<Version, String> {
    let (path, mut version) = find_version(root, role, id)?;
    version.context = super::trim_blank_lines(&context);
    version.turns = turns;
    // The group a version sits under is its first question; a blank one keeps the old value.
    let first = version.turns.first().map(|turn| turn.question.trim().to_string()).unwrap_or_default();
    if !first.is_empty() {
        version.question = first;
    }
    version.topic = tag_of(&version.id);
    version.evaluation = evaluation.to_string();
    version.status = status_of(Some(status.to_string()));
    version.starred = starred;
    write_version(&path, &version)?;
    Ok(version)
}

#[tauri::command]
pub(crate) fn save_social_version(app: AppHandle, request: SaveVersionRequest) -> Result<Version, String> {
    let (_guard, root) = super::open(&app)?;
    save_turns(&root, &checked_name(&request.role)?, &request.id, request.context, request.turns, &request.evaluation, &request.status, request.starred)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewVersionRequest {
    role: String,
    /// Empty starts a blank version: `<YYMMDD>` with one empty `Q：`/`A：` pair to fill in.
    #[serde(default)]
    question: String,
    /// The tag in the file name; empty gives the bare date.
    #[serde(default)]
    topic: String,
}

/// A new version file named `<tag><YYMMDD>`, or `<YYMMDD>` when the tag is empty; an empty
/// `question` leaves nothing but an empty `Q：`/`A：` pair to fill in.
pub(crate) fn new_version(root: &Path, role: &str, question: &str, topic: &str) -> Result<Version, String> {
    existing_role(root, role)?;
    let question = question.trim().to_string();
    let dir = records_dir(root, role);
    let name = version_name(topic, &today_code(), &mut used_names(&dir));
    let version = Version {
        id: name.clone(),
        question: question.clone(),
        topic: tag_of(&name),
        starred: false,
        status: "open".into(),
        context: String::new(),
        turns: vec![Turn { question: question.clone(), answer: String::new(), score: None }],
        evaluation: String::new(),
        preamble: String::new(),
    };
    write_version(&dir.join(format!("{name}.md")), &version)?;
    Ok(version)
}

#[tauri::command]
pub(crate) fn new_social_version(app: AppHandle, request: NewVersionRequest) -> Result<Version, String> {
    let (_guard, root) = super::open(&app)?;
    new_version(&root, &checked_name(&request.role)?, &request.question, &request.topic)
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

/// Moves a version to `<name>.md` in the same folder, appending ` 2` when the name is taken.
pub(crate) fn rename_version(root: &Path, role: &str, id: &str, name: &str) -> Result<String, String> {
    let (path, mut version) = find_version(root, role, id)?;
    let desired = file_stem(name, "");
    if desired.is_empty() || desired.starts_with('.') {
        return Err("版本名不能为空".into());
    }
    // A version name is `<tag><YYMMDD>`, so the date survives a rename; the tree reads it back.
    if !has_date(&desired) {
        return Err("版本名要以 YYMMDD 结尾，例如 进度询问261111".into());
    }
    if desired == version.id {
        return Ok(desired);
    }
    if name_key(&desired) != name_key(&version.id) && used_names(&records_dir(root, role)).contains(&name_key(&desired)) {
        return Err(format!("已经有同名文件：{desired}"));
    }
    version.id = desired.clone();
    version.topic = tag_of(&desired);
    write_version(&records_dir(root, role).join(format!("{desired}.md")), &version)?;
    // A case-only rename on a case-insensitive disk wrote the same file; keep it.
    if name_key(&desired) != name_key(id) {
        super::remove(&path)?;
    }
    Ok(desired)
}

#[tauri::command]
pub(crate) fn rename_social_version(app: AppHandle, role: String, id: String, name: String) -> Result<String, String> {
    let (_guard, root) = super::open(&app)?;
    rename_version(&root, &checked_name(&role)?, &id, &name)
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

    #[test]
    fn role_names_cannot_leave_the_tab_folder() {
        for name in ["../x", "a/b", "a\\b", ".beta-life", "  "] {
            assert!(checked_name(name).is_err(), "{name}");
        }
        assert_eq!(checked_name(" 王老师 ").unwrap(), "王老师");
    }

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
    fn a_context_line_before_the_first_turn_round_trips() {
        let body = parse_body("C：\n大三下，导师催进度。\n\nQ：进展怎么样？\nA：A 已投。\n");
        assert_eq!(body.context, "大三下，导师催进度。");
        assert_eq!(body.preamble, "");
        assert_eq!(body.turns.len(), 1);
        assert_eq!(body.turns[0].question, "进展怎么样？");
        assert_eq!(parse_body(&render_body(&body)), body);
        // Text before `C：` stays preamble, and both survive a round trip.
        let both = parse_body("开头的笔记\n\nC：前提\n\nQ：问\nA：答\n");
        assert_eq!(both.preamble, "开头的笔记");
        assert_eq!(both.context, "前提");
        assert_eq!(parse_body(&render_body(&both)), both);
        // No context line: nothing invented.
        assert_eq!(parse_body(SAMPLE).context, "");
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
    fn renaming_a_version_moves_its_file_and_refuses_a_taken_name() {
        let root = test_root("social-rename");
        let dir = records_dir(&root, "王老师");
        let version = |id: &str| Version { id: id.into(), question: "问".into(), topic: "进度询问".into(), starred: true, status: "open".into(), context: String::new(), turns: parse_body(SAMPLE).turns, evaluation: String::new(), preamble: String::new() };
        write_version(&dir.join("进度询问261111.md"), &version("进度询问261111")).unwrap();
        write_version(&dir.join("重投版261111.md"), &version("重投版261111")).unwrap();
        assert_eq!(rename_version(&root, "王老师", "进度询问261111", "进度询问261111").unwrap(), "进度询问261111");
        assert!(rename_version(&root, "王老师", "进度询问261111", "重投版261111").is_err());
        assert!(rename_version(&root, "王老师", "进度询问261111", "重投版").is_err());
        assert_eq!(rename_version(&root, "王老师", "进度询问261111", " 换题261112 ").unwrap(), "换题261112");
        assert!(!dir.join("进度询问261111.md").exists());
        let moved = find_version(&root, "王老师", "换题261112").unwrap().1;
        assert!(moved.starred);
        assert_eq!(moved.topic, "换题");
        assert_eq!(moved.turns, version("x").turns);
        assert!(rename_version(&root, "王老师", "换题261112", "  ").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_tag_comes_from_the_file_name() {
        assert_eq!(tag_of("进度询问261111"), "进度询问");
        assert_eq!(tag_of("进度询问261111-2"), "进度询问");
        assert_eq!(tag_of("261111"), "");
        assert_eq!(tag_of("261111-2"), "");
        assert_eq!(tag_of("没有日期"), "没有日期");
        assert!(has_date("进度询问261111"));
        assert!(has_date("进度询问261111-2"));
        assert!(!has_date("进度询问"));
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
        // No tag: the bare date, still getting a suffix when the day is taken.
        assert_eq!(version_name("", "261123", &mut used), "261123");
        assert_eq!(version_name("", "261123", &mut used), "261123-2");
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
            context: String::new(),
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
    fn the_question_bank_under_the_role_file_stays_out_of_the_tree() {
        let root = test_root("social-tree");
        let dir = role_dir(&root, "王老师");
        write_md(&dir.join(ROLE), "## 身份与场景\n\n## 可能会问的问题\n- 你的工作和组里别人怎么区分？\n").unwrap();
        let version = Version {
            id: "进度询问261111".into(),
            question: "这学期进展怎么样？".into(),
            topic: "进度询问".into(),
            starred: true,
            status: "done".into(),
            context: String::new(),
            turns: parse_body(SAMPLE).turns,
            evaluation: String::new(),
            preamble: String::new(),
        };
        write_version(&records_dir(&root, "王老师").join("进度询问261111.md"), &version).unwrap();
        let (summary, issues) = role_summary(&root, "王老师").unwrap();
        assert!(issues.is_empty());
        assert_eq!(summary.favorites.len(), 1);
        assert_eq!(summary.questions.len(), 1);
        assert_eq!(summary.questions[0].question, "这学期进展怎么样？");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_blank_version_is_named_by_its_date_and_takes_its_question_from_the_first_turn() {
        let root = test_root("social-blank");
        write_md(&role_dir(&root, "王老师").join(ROLE), &role_template()).unwrap();
        let blank = new_version(&root, "王老师", "", "").unwrap();
        assert_eq!(blank.id, today_code());
        assert!(blank.question.is_empty());
        assert_eq!(blank.turns.len(), 1);
        assert!(blank.turns[0].question.is_empty());
        assert!(blank.turns[0].answer.is_empty());
        let second = new_version(&root, "王老师", "", "").unwrap();
        assert_eq!(second.id, format!("{}-2", today_code()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saving_takes_the_question_from_the_first_turn() {
        let root = test_root("social-save");
        write_md(&role_dir(&root, "王老师").join(ROLE), &role_template()).unwrap();
        let blank = new_version(&root, "王老师", "", "").unwrap();
        let turns = vec![Turn { question: "这学期进展怎么样？".into(), answer: "A 已投".into(), score: None }];
        let saved = save_turns(&root, "王老师", &blank.id, String::new(), turns, "", "open", false).unwrap();
        assert_eq!(saved.question, "这学期进展怎么样？");
        assert_eq!(saved.topic, "");
        let tagged = new_version(&root, "王老师", "", "进度询问").unwrap();
        let turns = vec![Turn { question: "这学期进展怎么样？".into(), answer: "A 已投".into(), score: None }];
        let saved = save_turns(&root, "王老师", &tagged.id, String::new(), turns, "", "open", false).unwrap();
        assert_eq!(saved.topic, "进度询问");
        assert_eq!(find_version(&root, "王老师", &tagged.id).unwrap().1.topic, "进度询问");
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
