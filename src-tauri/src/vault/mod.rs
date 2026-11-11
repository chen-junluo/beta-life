//! Markdown vault: one folder per tab inside `app_data_dir`, md files are the source of truth.
//! Machine data (order, reviews, map state, indexes) lives in each tab's hidden `.beta-life/`,
//! which Obsidian neither shows nor indexes.

use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard, OnceLock},
};
use tauri::{AppHandle, Emitter};

pub(crate) mod board;
pub(crate) mod diary;
pub(crate) mod fm;
pub(crate) mod forest;
pub(crate) mod location;
pub(crate) mod memories;
pub(crate) mod migrate;
pub(crate) mod recall;
pub(crate) mod watch;

pub(crate) const BOARD: &str = "时间板";
pub(crate) const RECALL: &str = "回想";
pub(crate) const FOREST: &str = "能力森林";
pub(crate) const MEMORIES: &str = "记忆星云";
pub(crate) const DIARY: &str = "日记";
pub(crate) const AI: &str = "AI";
pub(crate) const TIMELINE: &str = "时间轴";
pub(crate) const META: &str = ".beta-life";

/// Tab folders whose md files are watched, with the panel name sent to the frontend.
pub(crate) const WATCHED: [(&str, &str); 6] = [
    (BOARD, "board"),
    (RECALL, "recall"),
    (FOREST, "forest"),
    (MEMORIES, "memories"),
    (DIARY, "diary"),
    (AI, "ai"),
];

/// Serializes vault commands with the watcher, so a scan never sees one of our writes half done.
/// Taken once per command (it is not reentrant).
static LOCK: Mutex<()> = Mutex::new(());
/// Content hash of every md file as beta-life last wrote or saw it; the watcher reports the rest.
static KNOWN: LazyLock<Mutex<HashMap<PathBuf, u64>>> = LazyLock::new(Default::default);
static MIGRATION_ERROR: OnceLock<String> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static ISSUES: LazyLock<Mutex<BTreeMap<String, Vec<Issue>>>> = LazyLock::new(Default::default);

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn lock() -> MutexGuard<'static, ()> {
    guard(&LOCK)
}

pub(crate) fn known() -> MutexGuard<'static, HashMap<PathBuf, u64>> {
    guard(&KNOWN)
}

pub(crate) fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub(crate) fn set_migration_error(error: String) {
    let _ = MIGRATION_ERROR.set(error);
}

/// Locks the vault and returns its root; fails while the old layout could not be migrated.
pub(crate) fn open(app: &AppHandle) -> Result<(MutexGuard<'static, ()>, PathBuf), String> {
    if let Some(error) = MIGRATION_ERROR.get() {
        return Err(format!("数据迁移失败，原数据没有改动：{error}"));
    }
    let root = location::root(app)?;
    let guard = lock();
    if location::switching() {
        return Err("正在切换数据文件夹，beta-life 马上会重启".into());
    }
    Ok((guard, root))
}

/// FNV-1a: stable across Rust versions, unlike `DefaultHasher`, so derived ids survive upgrades.
pub(crate) fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |state, byte| {
        (state ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

/// Id for a file created outside beta-life (no `id` in its frontmatter): stable while it keeps its path,
/// and written into the frontmatter the next time beta-life saves the item.
pub(crate) fn derived_id(prefix: &str, root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    format!("{prefix}{:016x}", hash(relative.to_string_lossy().as_bytes()))
}

/// Copies of a file (Obsidian's "duplicate") repeat its id: the oldest file keeps it, the others and
/// files without an id get ids from their paths. `seen` spans every folder of one panel.
pub(crate) fn dedupe_ids<T>(
    root: &Path,
    prefix: &str,
    items: &mut [(PathBuf, T)],
    id: impl Fn(&mut T) -> &mut String,
    seen: &mut HashSet<String>,
) {
    let born = |path: &Path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()))
            .unwrap_or(std::time::UNIX_EPOCH)
    };
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&index| (born(&items[index].0), items[index].0.clone()));
    for index in order {
        let path = items[index].0.clone();
        let value = id(&mut items[index].1);
        if value.trim().is_empty() || !seen.insert(value.clone()) {
            *value = derived_id(prefix, root, &path);
            seen.insert(value.clone());
        }
    }
}

/// Copies a file or a folder tree; a missing source is skipped.
pub(crate) fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        fs::create_dir_all(to).map_err(|error| format!("无法创建 {}：{error}", to.display()))?;
        let entries = fs::read_dir(from).map_err(|error| format!("无法读取 {}：{error}", from.display()))?;
        for entry in entries.flatten() {
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if from.exists() {
        fs::create_dir_all(to.parent().unwrap()).map_err(|error| format!("无法创建 {}：{error}", to.display()))?;
        fs::copy(from, to).map_err(|error| format!("无法复制 {}：{error}", from.display()))?;
    }
    Ok(())
}

pub(crate) fn read_md(path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取：{error}"))?;
    Ok(text.replace("\r\n", "\n"))
}

/// Atomic write through a hidden temp file; unchanged content is not rewritten, so Obsidian is not
/// told about a change that did not happen.
pub(crate) fn write_md(path: &Path, text: &str) -> Result<(), String> {
    let digest = hash(text.as_bytes());
    if fs::read(path).is_ok_and(|current| current == text.as_bytes()) {
        known().insert(path.to_path_buf(), digest);
        return Ok(());
    }
    let parent = path.parent().ok_or("目标文件没有父目录")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("file");
    let temporary = parent.join(format!(".{name}.tmp"));
    let mut file = fs::File::create(&temporary).map_err(|error| format!("无法创建临时文件：{error}"))?;
    file.write_all(text.as_bytes()).map_err(|error| format!("无法写入临时文件：{error}"))?;
    file.sync_all().map_err(|error| format!("无法同步临时文件：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    known().insert(path.to_path_buf(), digest);
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法删除 {}：{error}", path.display())),
    }
    known().remove(path);
    Ok(())
}

/// Renames a folder and moves the watcher's record of the files inside it.
pub(crate) fn rename_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| format!("无法重命名文件夹 {}：{error}", from.display()))?;
    let mut known = known();
    let moved: Vec<PathBuf> = known.keys().filter(|path| path.starts_with(from)).cloned().collect();
    for old in moved {
        if let (Some(digest), Ok(rest)) = (known.remove(&old), old.strip_prefix(from)) {
            known.insert(to.join(rest), digest);
        }
    }
    Ok(())
}

/// Moves machine data of an item deleted outside beta-life into `<meta>/trash/` instead of deleting it.
pub(crate) fn trash(meta: &Path, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let directory = meta.join("trash");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建回收目录：{error}"))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("file");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    fs::rename(path, directory.join(format!("{stamp}-{name}")))
        .map_err(|error| format!("无法移动 {} 到回收目录：{error}", path.display()))
}

fn hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

/// Visible md files of `dir` (and its visible subfolders when `recursive`), sorted by path.
pub(crate) fn md_files(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_md(dir, recursive, &mut files);
    files.sort();
    files
}

fn collect_md(dir: &Path, recursive: bool, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if hidden(&path) {
            continue;
        }
        if path.is_dir() {
            if recursive {
                collect_md(&path, true, files);
            }
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
            files.push(path);
        }
    }
}

/// Visible subfolder names of `dir`, sorted.
pub(crate) fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir() && !hidden(&entry.path()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    names.sort();
    names
}

pub(crate) fn stem(path: &Path) -> String {
    path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_string()
}

/// File name for a title: characters that are illegal in paths or break Obsidian links become their
/// full-width forms, multi-line titles keep the first line, at most 80 characters.
pub(crate) fn file_stem(title: &str, fallback: &str) -> String {
    let first = title.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    let first = first.strip_prefix("- ").or_else(|| first.strip_prefix("* ")).unwrap_or(first);
    let mut cleaned: String = first
        .trim()
        .chars()
        .map(|character| match character {
            '/' => '／',
            '\\' => '＼',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            '#' => '＃',
            '^' => '＾',
            '[' => '［',
            ']' => '］',
            character if character.is_control() => ' ',
            character => character,
        })
        .collect();
    if cleaned.starts_with('.') {
        cleaned.replace_range(0..1, "．");
    }
    let cleaned: String = cleaned.chars().take(80).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

/// Case-insensitive like the default macOS file system.
pub(crate) fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// Whether an existing file name still belongs to `desired` (itself or a ` 2`, ` 3` duplicate).
pub(crate) fn fits(current: &str, desired: &str) -> bool {
    current == desired
        || current
            .strip_prefix(desired)
            .and_then(|rest| rest.strip_prefix(' '))
            .is_some_and(|number| number.parse::<u32>().is_ok_and(|number| number >= 2))
}

/// `desired`, or `desired 2`, `desired 3`… whichever is not in `used` (keys from `name_key`); records it.
pub(crate) fn claim_name(desired: &str, used: &mut HashSet<String>) -> String {
    let mut candidate = desired.to_string();
    let mut number = 2;
    while used.contains(&name_key(&candidate)) {
        candidate = format!("{desired} {number}");
        number += 1;
    }
    used.insert(name_key(&candidate));
    candidate
}

/// The file an item should be written to: its current file while the name still fits the title,
/// otherwise a new unused name in `dir`. Returns the target and the old file to remove.
pub(crate) fn place(
    dir: &Path,
    current: Option<&Path>,
    desired: &str,
    used: &mut HashSet<String>,
) -> (PathBuf, Option<PathBuf>) {
    if let Some(current) = current {
        if current.parent() == Some(dir) && fits(&stem(current), desired) {
            return (current.to_path_buf(), None);
        }
    }
    let name = claim_name(desired, used);
    (dir.join(format!("{name}.md")), current.map(Path::to_path_buf))
}

pub(crate) fn used_names(dir: &Path) -> HashSet<String> {
    md_files(dir, false).iter().map(|path| name_key(&stem(path))).collect()
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// Lines with a flag telling whether each sits inside a fenced code block (fence lines count as inside).
pub(crate) fn fenced_lines(text: &str) -> Vec<(&str, bool)> {
    let mut inside = false;
    text.split('\n')
        .map(|line| {
            if is_fence(line) {
                inside = !inside;
                (line, true)
            } else {
                (line, inside)
            }
        })
        .collect()
}

fn structural_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|character| *character == '#').count();
    (1..=3).contains(&hashes) && line[hashes..].chars().next().is_none_or(|next| next == ' ')
}

/// `#`, `##`, `###` lines outside code blocks become `\#…`: they would otherwise be read as structure.
pub(crate) fn escape_headings(text: &str) -> String {
    fenced_lines(text)
        .into_iter()
        .map(|(line, fenced)| {
            if !fenced && structural_heading(line) {
                format!("\\{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn unescape_headings(text: &str) -> String {
    fenced_lines(text)
        .into_iter()
        .map(|(line, fenced)| match line.strip_prefix('\\') {
            Some(rest) if !fenced && structural_heading(rest) => rest.to_string(),
            _ => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Splits `body` at the last `heading` line outside code blocks: (before, after) with blank edges trimmed.
pub(crate) fn split_at_heading(body: &str, heading: &str) -> (String, Option<String>) {
    let lines = fenced_lines(body);
    let Some(index) = lines
        .iter()
        .rposition(|(line, fenced)| !fenced && line.trim_end() == heading)
    else {
        return (trim_blank_lines(body), None);
    };
    let join = |part: &[(&str, bool)]| part.iter().map(|(line, _)| *line).collect::<Vec<_>>().join("\n");
    (
        trim_blank_lines(&join(&lines[..index])),
        Some(trim_blank_lines(&join(&lines[index + 1..]))),
    )
}

pub(crate) fn has_heading(body: &str, heading: &str) -> bool {
    fenced_lines(body)
        .iter()
        .any(|(line, fenced)| !fenced && line.trim_end() == heading)
}

/// Drops leading and trailing blank lines and trailing whitespace, keeping the first line's indentation.
pub(crate) fn trim_blank_lines(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let start = lines.iter().position(|line| !line.trim().is_empty());
    let end = lines.iter().rposition(|line| !line.trim().is_empty());
    match (start, end) {
        (Some(start), Some(end)) => lines[start..=end].join("\n").trim_end().to_string(),
        _ => String::new(),
    }
}

/// A file that could not be read; it is skipped and left untouched.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Issue {
    pub(crate) panel: String,
    pub(crate) path: String,
    pub(crate) message: String,
}

pub(crate) fn issue(panel: &str, root: &Path, path: &Path, message: impl Into<String>) -> Issue {
    Issue {
        panel: panel.into(),
        path: path.strip_prefix(root).unwrap_or(path).display().to_string(),
        message: message.into(),
    }
}

/// Replaces the issues found by one loader (`key`) and tells the frontend when the set changed.
pub(crate) fn set_issues(key: &str, issues: Vec<Issue>) {
    let all = {
        let mut map = guard(&ISSUES);
        if map.get(key).map_or(issues.is_empty(), |current| *current == issues) {
            return;
        }
        if issues.is_empty() {
            map.remove(key);
        } else {
            map.insert(key.to_string(), issues);
        }
        map.values().flatten().cloned().collect::<Vec<_>>()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("vault-issues", all);
    }
}

#[tauri::command]
pub(crate) fn vault_issues() -> Vec<Issue> {
    guard(&ISSUES).values().flatten().cloned().collect()
}

#[cfg(test)]
pub(crate) fn test_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "beta-life-vault-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_keep_titles_readable() {
        assert_eq!(file_stem("听息/静坐+AI信息输入习惯", "x"), "听息／静坐+AI信息输入习惯");
        assert_eq!(file_stem("a: b? [c] #d", "x"), "a： b？ ［c］ ＃d");
        assert_eq!(file_stem("- 睡前双脚放松\n- 睡前唱歌", "x"), "睡前双脚放松");
        assert_eq!(file_stem(".hidden", "x"), "．hidden");
        assert_eq!(file_stem("  \n ", "未命名"), "未命名");
        assert_eq!(file_stem(&"长".repeat(100), "x").chars().count(), 80);
    }

    #[test]
    fn duplicate_names_get_numbers_and_still_fit() {
        let mut used = HashSet::from(["跑步".to_string()]);
        assert_eq!(claim_name("跑步", &mut used), "跑步 2");
        assert_eq!(claim_name("跑步", &mut used), "跑步 3");
        assert!(fits("跑步 2", "跑步"));
        assert!(!fits("跑步 1", "跑步"));
        assert!(!fits("跑步机", "跑步"));
    }

    #[test]
    fn headings_are_escaped_outside_code_and_restored() {
        let text = "# 标题\n## 小节\n#### 深层\n```\n# code\n```\n#tag";
        let escaped = escape_headings(text);
        assert_eq!(escaped, "\\# 标题\n\\## 小节\n#### 深层\n```\n# code\n```\n#tag");
        assert_eq!(unescape_headings(&escaped), text);
    }

    #[test]
    fn splits_at_the_last_heading_outside_code() {
        let body = "正文\n\n```\n## 抽查点\n```\n\n## 抽查点\n\n### 题";
        let (before, after) = split_at_heading(body, "## 抽查点");
        assert_eq!(before, "正文\n\n```\n## 抽查点\n```");
        assert_eq!(after.as_deref(), Some("### 题"));
    }
}
