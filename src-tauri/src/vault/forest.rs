//! 能力森林: `能力森林/<地图>/<领域>.md` with the 领域 note, then `## 能力组` and `### 能力`.
//! Files carry names, not ids: node ids are derived from the name path when loading. Map view state
//! and dragged positions (keyed by name path) live in `能力森林/<地图>/.beta-life/map.json`.

use super::fm::{self, raw, s};
use super::{claim_name, escape_headings, file_stem, fits, issue, md_files, name_key, place, read_md, remove, rename_dir, set_issues, stem, subdirs, trim_blank_lines, unescape_headings, used_names, write_md, FOREST, META};
use crate::{validate_ability_forest, AbilityForest, AbilityMapKind, AbilityMapPosition, AbilityMapState, AbilityNode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

/// Domain node id -> its file, per vault root and map, for the ids this process handed out (renames find the old file).
static FILES: LazyLock<Mutex<HashMap<String, HashMap<String, PathBuf>>>> = LazyLock::new(Default::default);

fn files() -> std::sync::MutexGuard<'static, HashMap<String, HashMap<String, PathBuf>>> {
    FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Node id -> the name path it was loaded or last saved under, so a save can tell which nodes were renamed.
static PATHS: LazyLock<Mutex<HashMap<String, HashMap<String, Vec<String>>>>> = LazyLock::new(Default::default);

fn known_paths() -> std::sync::MutexGuard<'static, HashMap<String, HashMap<String, Vec<String>>>> {
    PATHS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Forgets the files of one vault root (the migration's staging folder).
pub(crate) fn clear_registry(root: &Path) {
    let prefix = format!("{}\u{1f}", root.display());
    files().retain(|key, _| !key.starts_with(&prefix));
    known_paths().retain(|key, _| !key.starts_with(&prefix));
}

fn registry_key(root: &Path, kind: AbilityMapKind) -> String {
    format!("{}\u{1f}{}", root.display(), kind.key())
}

impl AbilityMapKind {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Vision => "vision",
            Self::Research => "research",
        }
    }

    fn default_name(self) -> &'static str {
        match self {
            Self::Vision => "Long-term Vision",
            Self::Research => "Research Agenda",
        }
    }
}

const KINDS: [AbilityMapKind; 2] = [AbilityMapKind::Vision, AbilityMapKind::Research];

#[derive(Debug, Default, Serialize, Deserialize)]
struct MapsMeta {
    #[serde(default)]
    vision: Option<String>,
    #[serde(default)]
    research: Option<String>,
}

impl MapsMeta {
    fn folder(&self, kind: AbilityMapKind) -> Option<&String> {
        match kind {
            AbilityMapKind::Vision => self.vision.as_ref(),
            AbilityMapKind::Research => self.research.as_ref(),
        }
    }

    fn set(&mut self, kind: AbilityMapKind, folder: String) {
        match kind {
            AbilityMapKind::Vision => self.vision = Some(folder),
            AbilityMapKind::Research => self.research = Some(folder),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapMeta {
    schema_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// `AbilityMapState` without `selectedId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    map_state: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selected_path: Option<Vec<String>>,
    #[serde(default)]
    positions: Vec<PathPosition>,
    /// Name paths of the 在推进 nodes (P7).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    active: Vec<Vec<String>>,
    /// Local `YYYY-MM-DD` each 在推进 node was marked; a goal with no progress counts from here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    since: Vec<PathSince>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PathSince {
    path: Vec<String>,
    date: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PathPosition {
    path: Vec<String>,
    x: usize,
    y: usize,
}

#[derive(Debug, Default, PartialEq)]
struct Section {
    name: String,
    /// Raw multi-line label (`{px}` per line) when it differs from the plain `name`, kept out of headings.
    label: Option<String>,
    color: Option<String>,
    note: String,
    children: Vec<Section>,
}

fn tab(root: &Path) -> PathBuf {
    root.join(FOREST)
}

fn maps_path(root: &Path) -> PathBuf {
    tab(root).join(META).join("maps.json")
}

fn valid_color(color: &str) -> bool {
    let bytes = color.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// The map's folder: the recorded one, else one named like the map, else (renamed in Obsidian) the
/// only folder no other map claims.
fn folder(root: &Path, kind: AbilityMapKind) -> Option<String> {
    let meta: MapsMeta = crate::read_json(&maps_path(root)).unwrap_or_default();
    let folders = subdirs(&tab(root));
    let claimed = |folder: &String| KINDS.iter().any(|other| other.key() != kind.key() && meta.folder(*other) == Some(folder));
    if let Some(folder) = meta.folder(kind).filter(|folder| folders.contains(folder)) {
        return Some(folder.clone());
    }
    if let Some(folder) = folders.iter().find(|folder| *folder == kind.default_name() && !claimed(folder)) {
        return Some(folder.clone());
    }
    let free: Vec<&String> = folders
        .iter()
        .filter(|folder| !claimed(folder) && !KINDS.iter().any(|other| other.key() != kind.key() && other.default_name() == folder.as_str()))
        .collect();
    (meta.folder(kind).is_some() && free.len() == 1).then(|| free[0].clone())
}

/// Plain text of one label line: a leading `{px}` sets the map font size and is not part of the name.
/// Same rule as the map: `{12}`, `{12.5}`, then the text; `{12}` with nothing after it stays as typed.
fn label_line_text(line: &str) -> &str {
    let line = line.trim();
    let Some(rest) = line.strip_prefix('{') else { return line };
    let Some(end) = rest.find('}') else { return line };
    let number = &rest[..end];
    let mut parts = number.split('.');
    let digits = |part: Option<&str>| part.is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    let valid = digits(parts.next()) && match parts.next() { None => true, part => digits(part) && parts.next().is_none() };
    let text = rest[end + 1..].trim();
    if valid && !text.is_empty() { text } else { line }
}

/// Name as it is stored and linked: every line without its `{px}` prefix, joined by spaces.
fn plain_name(name: &str) -> String {
    name.lines().map(label_line_text).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Name shown outside the map (bebe, goal lists): the label's first line, else the stored name.
fn display_name(section: &Section) -> String {
    section.label.as_deref().and_then(|label| label.lines().map(label_line_text).find(|line| !line.is_empty())).map(str::to_string).unwrap_or_else(|| section.name.clone())
}

/// The raw label, kept only when the stored name alone cannot reproduce it.
fn label_of(name: &str, plain: &str) -> Option<String> {
    let raw = name.trim();
    (raw != plain).then(|| raw.to_string())
}

/// `%%label:"…"%%` inside a heading, JSON-quoted so line breaks survive in a one-line heading.
fn label_marker(label: &str) -> String {
    format!("%%label:{}%%", serde_json::to_string(label).unwrap_or_default())
}

fn heading(name: &str, label: Option<&str>, color: Option<&str>) -> String {
    let mut text = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(label) = label {
        text.push(' ');
        text.push_str(&label_marker(label));
    }
    if let Some(color) = color {
        text.push(' ');
        text.push_str(&format!("%%color:{color}%%"));
    }
    text
}

fn parse_heading(text: &str) -> (String, Option<String>, Option<String>) {
    let mut text = text.trim().to_string();
    let mut color = None;
    if let Some(start) = text.rfind("%%color:") {
        let candidate = text[start + 8..].trim_end_matches('%').trim();
        if text.ends_with("%%") && valid_color(candidate) {
            color = Some(candidate.to_string());
            text = text[..start].trim().to_string();
        }
    }
    let mut label = None;
    if let Some(start) = text.rfind("%%label:") {
        if text.ends_with("%%") {
            if let Ok(parsed) = serde_json::from_str::<String>(text[start + 8..text.len() - 2].trim()) {
                label = Some(parsed.trim().to_string()).filter(|parsed| !parsed.is_empty());
                text = text[..start].trim().to_string();
            }
        }
    }
    (text, label, color)
}

fn serialize_domain(domain: &Section, order: usize) -> String {
    let mut fields = vec![("name", s(&domain.name)), ("order", raw(order))];
    if let Some(label) = &domain.label {
        fields.push(("label", s(label)));
    }
    if let Some(color) = &domain.color {
        fields.push(("color", s(color)));
    }
    let mut parts = Vec::new();
    let push_note = |parts: &mut Vec<String>, note: &str| {
        let note = escape_headings(note.trim_end());
        if !note.trim().is_empty() {
            parts.push(note);
        }
    };
    push_note(&mut parts, &domain.note);
    for group in &domain.children {
        parts.push(format!("## {}", heading(&group.name, group.label.as_deref(), group.color.as_deref())));
        push_note(&mut parts, &group.note);
        for ability in &group.children {
            parts.push(format!("### {}", heading(&ability.name, ability.label.as_deref(), ability.color.as_deref())));
            push_note(&mut parts, &ability.note);
        }
    }
    fm::render(&fields, &parts.join("\n\n"))
}

/// A `###` before any `##` stays part of the 领域 note.
fn parse_domain(text: &str, fallback_name: &str) -> Result<(Section, Option<f64>), String> {
    let (front, body) = fm::parse(text)?;
    let mut domain = Section {
        name: front.text("name").map(|name| name.trim().to_string()).unwrap_or_else(|| fallback_name.to_string()),
        label: front.text("label").map(|label| label.trim().to_string()).filter(|label| !label.is_empty()),
        color: front.text("color").map(|color| color.trim().to_string()).filter(|color| valid_color(color)),
        ..Section::default()
    };
    let mut notes: Vec<Vec<&str>> = vec![Vec::new()];
    // Path of the section each note belongs to: (group index, ability index).
    let mut targets: Vec<(Option<usize>, Option<usize>)> = vec![(None, None)];
    for (line, fenced) in super::fenced_lines(&body) {
        if !fenced {
            if let Some(text) = line.strip_prefix("## ") {
                let (name, label, color) = parse_heading(text);
                domain.children.push(Section { name, label, color, ..Section::default() });
                targets.push((Some(domain.children.len() - 1), None));
                notes.push(Vec::new());
                continue;
            }
            if let (Some(text), Some(index)) = (line.strip_prefix("### "), domain.children.len().checked_sub(1)) {
                let (name, label, color) = parse_heading(text);
                let group = &mut domain.children[index];
                group.children.push(Section { name, label, color, ..Section::default() });
                targets.push((Some(index), Some(group.children.len() - 1)));
                notes.push(Vec::new());
                continue;
            }
        }
        notes.last_mut().unwrap().push(line);
    }
    for ((group, ability), lines) in targets.into_iter().zip(notes) {
        let note = unescape_headings(&trim_blank_lines(&lines.join("\n")));
        let section = match (group, ability) {
            (None, _) => &mut domain,
            (Some(group), None) => &mut domain.children[group],
            (Some(group), Some(ability)) => &mut domain.children[group].children[ability],
        };
        section.note = note;
    }
    let order = front.get("order").and_then(|order| order.trim().parse::<f64>().ok());
    Ok((domain, order))
}

/// Name path of every node; repeated sibling names get `#2`, `#3` so paths stay unique.
fn name_paths(forest: &AbilityForest) -> HashMap<String, Vec<String>> {
    let mut paths = HashMap::new();
    fn walk(forest: &AbilityForest, parent: Option<&str>, prefix: &[String], paths: &mut HashMap<String, Vec<String>>) {
        let mut siblings: Vec<&AbilityNode> = forest.nodes.iter().filter(|node| node.parent_id.as_deref() == parent).collect();
        siblings.sort_by_key(|node| node.order);
        let mut counts: HashMap<String, usize> = HashMap::new();
        for node in siblings {
            let plain = plain_name(&node.name);
            let count = counts.entry(plain.clone()).or_insert(0);
            *count += 1;
            let segment = if *count == 1 { plain } else { format!("{plain}#{count}") };
            let mut path = prefix.to_vec();
            path.push(segment);
            walk(forest, Some(&node.id), &path, paths);
            paths.insert(node.id.clone(), path);
        }
    }
    walk(forest, None, &[], &mut paths);
    paths
}

fn node_id(kind: AbilityMapKind, path: &[String]) -> String {
    format!("n{:016x}", super::hash(format!("{}\u{1f}{}", kind.key(), path.join("\u{1f}")).as_bytes()))
}

pub(crate) fn load(root: &Path, kind: AbilityMapKind) -> Result<AbilityForest, String> {
    let Some(folder) = folder(root, kind) else {
        // First run: seed the built-in map, then read it back so ids come from names like every later load.
        let forest: AbilityForest = serde_json::from_str(kind.default_json()).map_err(|error| format!("内置能力森林数据无效：{error}"))?;
        save(root, kind, &forest)?;
        return load(root, kind);
    };
    let dir = tab(root).join(&folder);
    let (mut domains, issues) = read_domains(root, &dir);
    set_issues(&format!("forest/{}", kind.key()), issues);
    if domains.is_empty() {
        // Every 领域 file was deleted: one empty 领域, written on the next save.
        domains.push((PathBuf::new(), Section { name: "新能力领域".into(), ..Section::default() }, None));
    }

    let mut forest = AbilityForest { schema_version: 1, name: None, nodes: Vec::new(), map_positions: None, map_state: None };
    let mut registry = HashMap::new();
    for (order, (path, domain, _)) in domains.iter().enumerate() {
        let id = push_node(&mut forest, kind, None, &[], order, domain, 0);
        if !path.as_os_str().is_empty() {
            registry.insert(id, path.clone());
        }
    }
    files().insert(registry_key(root, kind), registry);

    let meta: Option<MapMeta> = crate::read_json(&dir.join(META).join("map.json")).ok();
    let paths = name_paths(&forest);
    if let Some(meta) = meta {
        let ids: HashMap<Vec<String>, String> = paths.iter().map(|(id, path)| (path.clone(), id.clone())).collect();
        let active: HashSet<&String> = meta.active.iter().filter_map(|path| ids.get(path)).collect();
        for node in forest.nodes.iter_mut() {
            node.active = node.level > 0 && active.contains(&node.id);
        }
        forest.name = meta.name;
        let positions: HashMap<String, AbilityMapPosition> = meta
            .positions
            .into_iter()
            .filter_map(|position| ids.get(&position.path).map(|id| (id.clone(), AbilityMapPosition { x: position.x, y: position.y })))
            .collect();
        forest.map_positions = (!positions.is_empty()).then_some(positions);
        forest.map_state = meta.map_state.and_then(|mut state| {
            let selected = meta.selected_path.as_ref().and_then(|path| ids.get(path));
            state["selectedId"] = selected.map_or(Value::Null, |id| Value::String(id.clone()));
            serde_json::from_value::<AbilityMapState>(state).ok()
        });
    }
    if validate_ability_forest(&forest).is_err() {
        // Positions or state edited by hand into an invalid layout: fall back to the generated map.
        forest.map_positions = None;
        forest.map_state = None;
    }
    validate_ability_forest(&forest)?;
    known_paths().insert(registry_key(root, kind), paths);
    Ok(forest)
}

/// The 领域 files of a map folder, in map order, with the files that could not be read.
fn read_domains(root: &Path, dir: &Path) -> (Vec<(PathBuf, Section, Option<f64>)>, Vec<super::Issue>) {
    let mut issues = Vec::new();
    let mut domains = Vec::new();
    for path in md_files(dir, false) {
        match read_md(&path).and_then(|text| parse_domain(&text, &stem(&path))) {
            Ok((domain, order)) => domains.push((path, domain, order)),
            Err(error) => issues.push(issue("forest", root, &path, error)),
        }
    }
    domains.sort_by(|left, right| {
        left.2.unwrap_or(f64::INFINITY).total_cmp(&right.2.unwrap_or(f64::INFINITY)).then_with(|| left.0.cmp(&right.0))
    });
    (domains, issues)
}

/// Heading text as an Obsidian link writes it: characters links cannot hold become spaces.
pub(crate) fn link_heading(name: &str) -> String {
    name.replace("%%", " ")
        .replace(['#', '|', '^', ':', '[', ']'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `领域文件#节点标题` (the 领域 itself: just the file), the target inside `[[…]]`.
fn link_target(file: &str, name: Option<&str>) -> String {
    match name {
        Some(name) => format!("{file}#{}", link_heading(name)),
        None => file.to_string(),
    }
}

/// A path segment without the `#2` that tells repeated sibling names apart.
fn segment_name(segment: &str) -> &str {
    match segment.rsplit_once('#') {
        Some((name, number)) if number.parse::<u32>().is_ok_and(|number| number >= 2) => name,
        _ => segment,
    }
}

/// A 能力组 or 能力 as the diary links to it (P7).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GoalTarget {
    pub(crate) path: Vec<String>,
    pub(crate) name: String,
    pub(crate) file: String,
    pub(crate) link: String,
    pub(crate) active: bool,
}

/// Every 中 / 小节点 of a map as it is on disk, without touching the save registries.
pub(crate) fn goal_targets(root: &Path, kind: AbilityMapKind) -> Vec<GoalTarget> {
    let Some(folder) = folder(root, kind) else { return Vec::new() };
    let dir = tab(root).join(&folder);
    let meta: Option<MapMeta> = crate::read_json(&dir.join(META).join("map.json")).ok();
    let active: HashSet<Vec<String>> = meta.map(|meta| meta.active.into_iter().collect()).unwrap_or_default();
    let mut targets = Vec::new();
    let numbered = |sections: &[Section]| -> Vec<String> {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        sections
            .iter()
            .map(|section| {
                let count = seen.entry(section.name.as_str()).or_default();
                *count += 1;
                if *count == 1 { section.name.clone() } else { format!("{}#{count}", section.name) }
            })
            .collect()
    };
    let (domains, _) = read_domains(root, &dir);
    let domain_sections: Vec<Section> = domains.iter().map(|(_, domain, _)| Section { name: domain.name.clone(), ..Section::default() }).collect();
    for ((path, domain, _), domain_segment) in domains.iter().zip(numbered(&domain_sections)) {
        let file = stem(path).to_string();
        let mut push = |segments: Vec<String>, section: &Section| {
            let active = active.contains(&segments);
            targets.push(GoalTarget { link: link_target(&file, Some(&section.name)), path: segments, name: display_name(section), file: file.clone(), active });
        };
        for (group, group_segment) in domain.children.iter().zip(numbered(&domain.children)) {
            push(vec![domain_segment.clone(), group_segment.clone()], group);
            for (ability, ability_segment) in group.children.iter().zip(numbered(&group.children)) {
                push(vec![domain_segment.clone(), group_segment.clone(), ability_segment], ability);
            }
        }
    }
    targets
}

/// The date each 在推进 node of a map was marked. Goals marked before dates were kept get `today`,
/// written back once so they count from the first day this was seen.
pub(crate) fn goal_since(root: &Path, kind: AbilityMapKind, today: &str) -> Result<HashMap<Vec<String>, String>, String> {
    let Some(folder) = folder(root, kind) else { return Ok(HashMap::new()) };
    let path = tab(root).join(&folder).join(META).join("map.json");
    let Ok(mut meta) = crate::read_json::<MapMeta>(&path) else { return Ok(HashMap::new()) };
    let mut since: HashMap<Vec<String>, String> = meta.since.iter().map(|entry| (entry.path.clone(), entry.date.clone())).collect();
    let missing: Vec<Vec<String>> = meta.active.iter().filter(|path| !since.contains_key(*path)).cloned().collect();
    if !missing.is_empty() {
        for path in missing {
            since.insert(path.clone(), today.to_string());
            meta.since.push(PathSince { path, date: today.to_string() });
        }
        meta.since.sort_by(|left, right| left.path.cmp(&right.path));
        crate::atomic_write(&path, &meta)?;
    }
    Ok(since)
}

#[cfg(test)]
pub(crate) fn map_meta_path(root: &Path, kind: AbilityMapKind) -> PathBuf {
    tab(root).join(folder(root, kind).unwrap()).join(META).join("map.json")
}

fn push_node(forest: &mut AbilityForest, kind: AbilityMapKind, parent: Option<&str>, prefix: &[String], order: usize, section: &Section, level: u8) -> String {
    let stored = section.label.clone().filter(|label| plain_name(label) == section.name).unwrap_or_else(|| section.name.clone());
    let same_name_before = forest
        .nodes
        .iter()
        .filter(|node| node.parent_id.as_deref() == parent && plain_name(&node.name) == section.name)
        .count();
    let mut path = prefix.to_vec();
    path.push(if same_name_before == 0 { section.name.clone() } else { format!("{}#{}", section.name, same_name_before + 1) });
    let id = node_id(kind, &path);
    forest.nodes.push(AbilityNode {
        id: id.clone(),
        name: stored,
        level,
        parent_id: parent.map(str::to_string),
        order,
        color: section.color.clone(),
        markdown: section.note.clone(),
        active: false,
    });
    for (index, child) in section.children.iter().enumerate().filter(|_| level < 2) {
        push_node(forest, kind, Some(&id), &path, index, child, level + 1);
    }
    id
}

fn sections(forest: &AbilityForest, parent: Option<&str>) -> Vec<(String, Section)> {
    let mut nodes: Vec<&AbilityNode> = forest.nodes.iter().filter(|node| node.parent_id.as_deref() == parent).collect();
    nodes.sort_by_key(|node| node.order);
    nodes
        .into_iter()
        .map(|node| {
            let plain = plain_name(&node.name);
            let section = Section {
                name: plain.clone(),
                label: label_of(&node.name, &plain),
                color: node.color.clone(),
                note: node.markdown.clone(),
                children: sections(forest, Some(&node.id)).into_iter().map(|(_, child)| child).collect(),
            };
            (node.id.clone(), section)
        })
        .collect()
}

/// Caller validates. 领域 files are matched to nodes through the ids `load` handed out, so a renamed
/// 领域 renames its file; a 领域 removed in beta-life deletes its file. Returns the diary link targets
/// that changed (renamed nodes and 领域), old -> new.
pub(crate) fn save(root: &Path, kind: AbilityMapKind, forest: &AbilityForest) -> Result<Vec<(String, String)>, String> {
    let tab = tab(root);
    fs::create_dir_all(&tab).map_err(|error| format!("无法创建能力森林目录：{error}"))?;
    let mut maps: MapsMeta = crate::read_json(&maps_path(root)).unwrap_or_default();
    let desired = file_stem(forest.name.as_deref().unwrap_or(kind.default_name()), kind.default_name());
    let current = folder(root, kind);
    let mut registry = files().remove(&registry_key(root, kind)).unwrap_or_default();
    let old_paths = known_paths().remove(&registry_key(root, kind)).unwrap_or_default();
    let old_files: HashMap<String, String> = registry.iter().map(|(id, path)| (id.clone(), stem(path).to_string())).collect();
    let folder = match current {
        Some(folder) if fits(&folder, &desired) => folder,
        Some(folder) => {
            let mut used: HashSet<String> = subdirs(&tab).iter().map(|name| name_key(name)).collect();
            let name = claim_name(&desired, &mut used);
            rename_dir(&tab.join(&folder), &tab.join(&name))?;
            for path in registry.values_mut() {
                if let Some(file) = path.file_name() {
                    *path = tab.join(&name).join(file);
                }
            }
            name
        }
        None => {
            let mut used: HashSet<String> = subdirs(&tab).iter().map(|name| name_key(name)).collect();
            claim_name(&desired, &mut used)
        }
    };
    let dir = tab.join(&folder);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建地图目录：{error}"))?;
    if maps.folder(kind) != Some(&folder) {
        maps.set(kind, folder);
        crate::atomic_write(&maps_path(root), &maps)?;
    }

    // 领域 without a known file (registry lost, e.g. after a failed save) take an unclaimed file with
    // the same name, so a save never writes a second copy next to it.
    let claimed: HashSet<PathBuf> = registry.values().cloned().collect();
    let mut unclaimed: Vec<(PathBuf, String)> = md_files(&dir, false)
        .into_iter()
        .filter(|path| !claimed.contains(path))
        .filter_map(|path| {
            let name = read_md(&path).ok().and_then(|text| parse_domain(&text, &stem(&path)).ok())?.0.name;
            Some((path, name))
        })
        .collect();
    let mut used = used_names(&dir);
    let mut saved = HashMap::new();
    for (order, (id, domain)) in sections(forest, None).into_iter().enumerate() {
        if !registry.contains_key(&id) {
            if let Some(index) = unclaimed.iter().position(|(_, name)| *name == domain.name) {
                let (path, _) = unclaimed.remove(index);
                registry.insert(id.clone(), path);
            }
        }
        let (path, old) = place(&dir, registry.get(&id).map(PathBuf::as_path), &file_stem(&domain.name, "能力领域"), &mut used);
        write_md(&path, &serialize_domain(&domain, order))?;
        if let Some(old) = old {
            remove(&old)?;
        }
        saved.insert(id, path);
    }
    let kept: HashSet<&PathBuf> = saved.values().collect();
    for path in registry.values().filter(|path| !kept.contains(path) && path.parent() == Some(dir.as_path())) {
        remove(path)?;
    }
    let paths = name_paths(forest);
    let renames = renamed_links(forest, &paths, &old_paths, &old_files, &saved);
    files().insert(registry_key(root, kind), saved);

    known_paths().insert(registry_key(root, kind), paths.clone());
    let map_state = forest.map_state.as_ref().and_then(|state| serde_json::to_value(state).ok()).map(|mut state| {
        if let Some(object) = state.as_object_mut() {
            object.remove("selectedId");
        }
        state
    });
    let mut positions: Vec<PathPosition> = forest
        .map_positions
        .iter()
        .flatten()
        .filter_map(|(id, position)| paths.get(id).map(|path| PathPosition { path: path.clone(), x: position.x, y: position.y }))
        .collect();
    positions.sort_by(|left, right| left.path.cmp(&right.path));
    let meta_path = dir.join(META).join("map.json");
    let old_since: HashMap<Vec<String>, String> = crate::read_json::<MapMeta>(&meta_path)
        .map(|meta| meta.since.into_iter().map(|entry| (entry.path, entry.date)).collect())
        .unwrap_or_default();
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    let meta = MapMeta {
        schema_version: 1,
        name: forest.name.clone(),
        map_state,
        selected_path: forest.map_state.as_ref().and_then(|state| state.selected_id.as_ref()).and_then(|id| paths.get(id)).cloned(),
        positions,
        active: {
            let mut active: Vec<Vec<String>> = forest
                .nodes
                .iter()
                .filter(|node| node.active && node.level > 0)
                .filter_map(|node| paths.get(&node.id).cloned())
                .collect();
            active.sort();
            active
        },
        // A renamed goal keeps its date through its old path; a newly marked one starts today.
        since: {
            let mut since: Vec<PathSince> = forest
                .nodes
                .iter()
                .filter(|node| node.active && node.level > 0)
                .filter_map(|node| {
                    let path = paths.get(&node.id)?;
                    let date = old_paths.get(&node.id).and_then(|old| old_since.get(old)).or_else(|| old_since.get(path)).cloned().unwrap_or_else(|| today.clone());
                    Some(PathSince { path: path.clone(), date })
                })
                .collect();
            since.sort_by(|left, right| left.path.cmp(&right.path));
            since
        },
    };
    crate::atomic_write(&meta_path, &meta)?;
    Ok(renames)
}

/// Link targets whose 领域 file or heading changed since the node was loaded or last saved.
fn renamed_links(
    forest: &AbilityForest,
    paths: &HashMap<String, Vec<String>>,
    old_paths: &HashMap<String, Vec<String>>,
    old_files: &HashMap<String, String>,
    saved: &HashMap<String, PathBuf>,
) -> Vec<(String, String)> {
    let old_domains: HashMap<&String, &String> = old_paths
        .iter()
        .filter(|(_, path)| path.len() == 1)
        .filter_map(|(id, path)| old_files.get(id).map(|file| (&path[0], file)))
        .collect();
    let new_domains: HashMap<&String, String> = paths
        .iter()
        .filter(|(_, path)| path.len() == 1)
        .filter_map(|(id, path)| saved.get(id).map(|file| (&path[0], stem(file).to_string())))
        .collect();
    let mut renames = Vec::new();
    for node in &forest.nodes {
        let (Some(old), Some(new)) = (old_paths.get(&node.id), paths.get(&node.id)) else { continue };
        let (Some(old_file), Some(new_file)) = (old_domains.get(&old[0]), new_domains.get(&new[0])) else { continue };
        let heading = |path: &Vec<String>| (path.len() > 1).then(|| segment_name(path.last().unwrap()).to_string());
        let before = link_target(old_file, heading(old).as_deref());
        let after = link_target(new_file, heading(new).as_deref());
        if before != after && !renames.iter().any(|(old, _)| *old == before) {
            renames.push((before, after));
        }
    }
    renames
}

/// Migration helper: the template's `# 节点名` first line repeats what the heading already says.
pub(crate) fn strip_repeated_title(name: &str, markdown: &str) -> String {
    let mut lines = markdown.split('\n');
    match lines.next() {
        Some(first) if first.trim_end() == format!("# {}", name.trim()) || (first.trim() == "#" && name.trim().is_empty()) => {
            trim_blank_lines(&lines.collect::<Vec<_>>().join("\n"))
        }
        _ => markdown.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_forest(kind: AbilityMapKind) -> AbilityForest {
        serde_json::from_str(kind.default_json()).unwrap()
    }

    /// Same tree with ids replaced by name paths, for comparing forests across loads.
    fn shape(forest: &AbilityForest) -> Vec<(Vec<String>, u8, usize, Option<String>, String)> {
        let paths = name_paths(forest);
        let mut nodes: Vec<_> = forest
            .nodes
            .iter()
            .map(|node| (paths[&node.id].clone(), node.level, node.order, node.color.clone(), node.markdown.trim().to_string()))
            .collect();
        nodes.sort();
        nodes
    }

    #[test]
    fn domain_markdown_round_trips_with_escaped_headings() {
        let domain = Section {
            name: "AI native 学者/实践者".into(),
            label: None,
            color: Some("#7FB77E".into()),
            note: "领域笔记\n\n# 不是结构\n#### 可以".into(),
            children: vec![Section {
                name: "研究成果".into(),
                label: None,
                color: Some("#5A9FD4".into()),
                note: String::new(),
                children: vec![Section { name: "当前任务".into(), label: None, color: None, note: "```\n## 代码\n```".into(), children: vec![] }],
            }],
        };
        let text = serialize_domain(&domain, 2);
        assert!(text.contains("color: \"#7FB77E\"\n"));
        assert!(text.contains("\\# 不是结构\n#### 可以\n\n## 研究成果 %%color:#5A9FD4%%\n\n### 当前任务\n\n```\n## 代码\n```\n"));
        let (parsed, order) = parse_domain(&text, "x").unwrap();
        assert_eq!(parsed, domain);
        assert_eq!(order, Some(2.0));
    }

    #[test]
    fn multiline_labels_round_trip_and_link_by_plain_name() {
        let root = super::super::test_root("forest-labels");
        let mut forest = load(&root, AbilityMapKind::Vision).unwrap();
        let group = forest.nodes.iter().position(|node| node.level == 1).unwrap();
        let old = forest.nodes[group].name.clone();

        // Only font sizes added: the plain name is unchanged, so no diary link moves.
        forest.nodes[group].name = format!("{{12}} {old}");
        assert!(save(&root, AbilityMapKind::Vision, &forest).unwrap().is_empty(), "a font size alone is not a rename");
        assert_eq!(load(&root, AbilityMapKind::Vision).unwrap().nodes[group].name, format!("{{12}} {old}"));

        // A second line joins the plain heading, and links follow it.
        forest.nodes[group].name = format!("{{12}} {old}\n{{8}} 论文");
        let renames = save(&root, AbilityMapKind::Vision, &forest).unwrap();
        assert_eq!(renames.len(), 1);
        assert!(renames[0].1.ends_with(&format!("#{old} 论文")), "link is the plain heading, got {}", renames[0].1);
        let reloaded = load(&root, AbilityMapKind::Vision).unwrap();
        assert_eq!(reloaded.nodes[group].name, format!("{{12}} {old}\n{{8}} 论文"));
        let target = goal_targets(&root, AbilityMapKind::Vision).into_iter().find(|target| target.link.ends_with(&format!("#{old} 论文"))).unwrap();
        assert_eq!(target.name, old, "bebe shows only the first line");
        let dir = tab(&root).join(folder(&root, AbilityMapKind::Vision).unwrap());
        let text = md_files(&dir, false).into_iter().filter_map(|path| read_md(&path).ok()).find(|text| text.contains(&format!("## {old} 论文"))).unwrap();
        assert!(text.contains(&format!("## {old} 论文 %%label:\"{{12}} {old}\\n{{8}} 论文\"%%")), "heading keeps the plain name and the label");

        // A 领域 keeps its label in frontmatter.
        let domain = forest.nodes.iter().position(|node| node.level == 0).unwrap();
        let domain_old = forest.nodes[domain].name.clone();
        forest.nodes[domain].name = format!("{{16}} {domain_old}");
        assert!(save(&root, AbilityMapKind::Vision, &forest).unwrap().is_empty());
        assert_eq!(load(&root, AbilityMapKind::Vision).unwrap().nodes[domain].name, format!("{{16}} {domain_old}"));
    }

    #[test]
    fn seeds_saves_and_reloads_both_maps_with_duplicate_names() {
        let root = super::super::test_root("forest");
        let vision = load(&root, AbilityMapKind::Vision).unwrap();
        assert_eq!(shape(&vision), shape(&default_forest(AbilityMapKind::Vision)));
        assert!(root.join("能力森林/Long-term Vision").is_dir());
        let research = load(&root, AbilityMapKind::Research).unwrap();
        assert_eq!(shape(&research), shape(&default_forest(AbilityMapKind::Research)));

        // Two 领域 with the same name, a dragged position and a selection survive a reload.
        let mut edited = vision.clone();
        let first = edited.nodes.iter().find(|node| node.level == 0).unwrap().clone();
        let order = edited.nodes.iter().filter(|node| node.level == 0).count();
        let copy = AbilityNode { id: "fresh".into(), order, markdown: "第二个".into(), color: None, ..first.clone() };
        edited.nodes.push(copy);
        edited.map_positions = Some(HashMap::from([("fresh".to_string(), AbilityMapPosition { x: 40, y: 40 })]));
        edited.map_state = Some(serde_json::from_value(serde_json::json!({
            "seed": 7, "zoom": 1.0, "pan": {"x": 0.0, "y": 0.0}, "visibleLevels": 2,
            "options": {"baseRadius": 25.0, "clusterSpread": 9.0, "largeNodeRadius": 8.0, "mediumNodeRadius": 14.0},
            "selectedId": "fresh"
        })).unwrap());
        validate_ability_forest(&edited).unwrap();
        save(&root, AbilityMapKind::Vision, &edited).unwrap();
        let reloaded = load(&root, AbilityMapKind::Vision).unwrap();
        assert_eq!(shape(&reloaded), shape(&edited));
        let fresh = reloaded.nodes.iter().find(|node| node.markdown == "第二个").unwrap();
        assert_eq!(reloaded.map_positions.as_ref().unwrap()[&fresh.id].x, 40);
        assert_eq!(reloaded.map_state.as_ref().unwrap().selected_id.as_deref(), Some(fresh.id.as_str()));

        // Renaming a 领域 and the map renames their files; deleting a 领域 deletes its file.
        let mut renamed = reloaded.clone();
        renamed.name = Some("愿景".into());
        let target = renamed.nodes.iter_mut().find(|node| node.id == first_id(&reloaded)).unwrap();
        target.name = "改过的名字".into();
        let removed = fresh.id.clone();
        renamed.nodes.retain(|node| node.id != removed);
        renamed.map_positions = None;
        renamed.map_state.as_mut().unwrap().selected_id = None;
        save(&root, AbilityMapKind::Vision, &renamed).unwrap();
        let dir = root.join("能力森林/愿景");
        let names: Vec<String> = md_files(&dir, false).iter().map(|path| stem(path)).collect();
        assert!(names.contains(&"改过的名字".to_string()));
        assert_eq!(names.len(), renamed.nodes.iter().filter(|node| node.level == 0).count());
        assert_eq!(shape(&load(&root, AbilityMapKind::Vision).unwrap()), shape(&renamed));
        assert_eq!(shape(&load(&root, AbilityMapKind::Research).unwrap()), shape(&research));
        fs::remove_dir_all(root).unwrap();
    }

    fn first_id(forest: &AbilityForest) -> String {
        forest.nodes.iter().filter(|node| node.level == 0).min_by_key(|node| node.order).unwrap().id.clone()
    }

    #[test]
    fn strips_only_the_repeated_template_title() {
        assert_eq!(strip_repeated_title("研究方向", "# 研究方向\n\n写下问题。"), "写下问题。");
        assert_eq!(strip_repeated_title("新能力领域", "# 沟通协作\n\n内容"), "# 沟通协作\n\n内容");
        assert_eq!(strip_repeated_title("", "# \n\n内容"), "内容");
    }
}
