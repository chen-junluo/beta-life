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

/// Forgets the files of one vault root (the migration's staging folder).
pub(crate) fn clear_registry(root: &Path) {
    let prefix = format!("{}\u{1f}", root.display());
    files().retain(|key, _| !key.starts_with(&prefix));
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

fn heading(name: &str, color: Option<&str>) -> String {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    match color {
        Some(color) => format!("{name} %%color:{color}%%"),
        None => name,
    }
}

fn parse_heading(text: &str) -> (String, Option<String>) {
    let text = text.trim();
    if let Some(start) = text.rfind("%%color:") {
        let color = text[start + 8..].trim_end_matches('%').trim();
        if text.ends_with("%%") && valid_color(color) {
            return (text[..start].trim().to_string(), Some(color.to_string()));
        }
    }
    (text.to_string(), None)
}

fn serialize_domain(domain: &Section, order: usize) -> String {
    let mut fields = vec![("name", s(&domain.name)), ("order", raw(order))];
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
        parts.push(format!("## {}", heading(&group.name, group.color.as_deref())));
        push_note(&mut parts, &group.note);
        for ability in &group.children {
            parts.push(format!("### {}", heading(&ability.name, ability.color.as_deref())));
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
        color: front.text("color").map(|color| color.trim().to_string()).filter(|color| valid_color(color)),
        ..Section::default()
    };
    let mut notes: Vec<Vec<&str>> = vec![Vec::new()];
    // Path of the section each note belongs to: (group index, ability index).
    let mut targets: Vec<(Option<usize>, Option<usize>)> = vec![(None, None)];
    for (line, fenced) in super::fenced_lines(&body) {
        if !fenced {
            if let Some(text) = line.strip_prefix("## ") {
                let (name, color) = parse_heading(text);
                domain.children.push(Section { name, color, ..Section::default() });
                targets.push((Some(domain.children.len() - 1), None));
                notes.push(Vec::new());
                continue;
            }
            if let (Some(text), Some(index)) = (line.strip_prefix("### "), domain.children.len().checked_sub(1)) {
                let (name, color) = parse_heading(text);
                let group = &mut domain.children[index];
                group.children.push(Section { name, color, ..Section::default() });
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
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for node in siblings {
            let count = counts.entry(node.name.trim()).or_insert(0);
            *count += 1;
            let segment = if *count == 1 { node.name.trim().to_string() } else { format!("{}#{count}", node.name.trim()) };
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
    let mut issues = Vec::new();
    let mut domains = Vec::new();
    for path in md_files(&dir, false) {
        match read_md(&path).and_then(|text| parse_domain(&text, &stem(&path))) {
            Ok((domain, order)) => domains.push((path, domain, order)),
            Err(error) => issues.push(issue("forest", root, &path, error)),
        }
    }
    set_issues(&format!("forest/{}", kind.key()), issues);
    domains.sort_by(|left, right| {
        left.2.unwrap_or(f64::INFINITY).total_cmp(&right.2.unwrap_or(f64::INFINITY)).then_with(|| left.0.cmp(&right.0))
    });
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
    if let Some(meta) = meta {
        let ids: HashMap<Vec<String>, String> = name_paths(&forest).into_iter().map(|(id, path)| (path, id)).collect();
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
    Ok(forest)
}

fn push_node(forest: &mut AbilityForest, kind: AbilityMapKind, parent: Option<&str>, prefix: &[String], order: usize, section: &Section, level: u8) -> String {
    let same_name_before = forest
        .nodes
        .iter()
        .filter(|node| node.parent_id.as_deref() == parent && node.name == section.name)
        .count();
    let mut path = prefix.to_vec();
    path.push(if same_name_before == 0 { section.name.clone() } else { format!("{}#{}", section.name, same_name_before + 1) });
    let id = node_id(kind, &path);
    forest.nodes.push(AbilityNode {
        id: id.clone(),
        name: section.name.clone(),
        level,
        parent_id: parent.map(str::to_string),
        order,
        color: section.color.clone(),
        markdown: section.note.clone(),
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
            let section = Section {
                name: node.name.trim().to_string(),
                color: node.color.clone(),
                note: node.markdown.clone(),
                children: sections(forest, Some(&node.id)).into_iter().map(|(_, child)| child).collect(),
            };
            (node.id.clone(), section)
        })
        .collect()
}

/// Caller validates. 领域 files are matched to nodes through the ids `load` handed out, so a renamed
/// 领域 renames its file; a 领域 removed in beta-life deletes its file.
pub(crate) fn save(root: &Path, kind: AbilityMapKind, forest: &AbilityForest) -> Result<(), String> {
    let tab = tab(root);
    fs::create_dir_all(&tab).map_err(|error| format!("无法创建能力森林目录：{error}"))?;
    let mut maps: MapsMeta = crate::read_json(&maps_path(root)).unwrap_or_default();
    let desired = file_stem(forest.name.as_deref().unwrap_or(kind.default_name()), kind.default_name());
    let current = folder(root, kind);
    let mut registry = files().remove(&registry_key(root, kind)).unwrap_or_default();
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
    files().insert(registry_key(root, kind), saved);

    let paths = name_paths(forest);
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
    let meta = MapMeta {
        schema_version: 1,
        name: forest.name.clone(),
        map_state,
        selected_path: forest.map_state.as_ref().and_then(|state| state.selected_id.as_ref()).and_then(|id| paths.get(id)).cloned(),
        positions,
    };
    crate::atomic_write(&dir.join(META).join("map.json"), &meta)
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
            color: Some("#7FB77E".into()),
            note: "领域笔记\n\n# 不是结构\n#### 可以".into(),
            children: vec![Section {
                name: "研究成果".into(),
                color: Some("#5A9FD4".into()),
                note: String::new(),
                children: vec![Section { name: "当前任务".into(), color: None, note: "```\n## 代码\n```".into(), children: vec![] }],
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
