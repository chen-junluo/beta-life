//! 回想: `回想/**/<标题>.md` = knowledge note + trailing `## 抽查点` section (one `###` per point,
//! linked to its review history by `%%id:…%%`). Reviews, FSRS scheduler and the next-review index
//! live in `回想/.beta-life/`.

use super::fm::{self, s};
use super::{dedupe_ids, escape_headings, file_stem, has_heading, issue, md_files, place, read_md, remove, split_at_heading, stem, unescape_headings, used_names, write_md, Issue, META, RECALL};
use crate::{KnowledgeIndexEntry, KnowledgeRecord, RecallPoint};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const POINTS_HEADING: &str = "## 抽查点";
const POINT_TYPES: [(&str, &str); 3] = [("framework", "框架"), ("mechanism", "机制"), ("relationship", "关系")];

pub(crate) struct Note {
    pub(crate) path: PathBuf,
    pub(crate) record: KnowledgeRecord,
    pub(crate) points: Vec<RecallPoint>,
    /// The id is in the frontmatter (not derived from the path).
    pub(crate) has_id: bool,
}

pub(crate) fn tab(root: &Path) -> PathBuf {
    root.join(RECALL)
}

pub(crate) fn meta(root: &Path) -> PathBuf {
    tab(root).join(META)
}

pub(crate) fn reviews_path(root: &Path, id: &str) -> PathBuf {
    meta(root).join("reviews").join(format!("{id}.jsonl"))
}

pub(crate) fn scheduler_path(root: &Path, id: &str) -> PathBuf {
    meta(root).join("scheduler").join(format!("{id}.json"))
}

pub(crate) fn index_path(root: &Path) -> PathBuf {
    meta(root).join("index.json")
}

pub(crate) fn read_index(root: &Path) -> Result<Vec<KnowledgeIndexEntry>, String> {
    let path = index_path(root);
    if path.exists() {
        crate::read_json(&path)
    } else {
        Ok(Vec::new())
    }
}

pub(crate) fn write_index(root: &Path, entries: &[KnowledgeIndexEntry]) -> Result<(), String> {
    crate::atomic_write(&index_path(root), &entries.to_vec())
}

fn type_label(point_type: &str) -> &str {
    POINT_TYPES.iter().find(|(key, _)| *key == point_type).map_or(point_type, |(_, label)| label)
}

pub(crate) fn serialize(record: &KnowledgeRecord, points: &[RecallPoint]) -> String {
    let mut fields = vec![
        ("id", s(&record.id)),
        ("title", s(&record.title)),
        ("createdAt", s(&record.created_at)),
        ("updatedAt", s(&record.updated_at)),
        ("tags", s(&record.tags)),
    ];
    if let Some(url) = &record.source_url {
        fields.push(("sourceUrl", s(url)));
    }
    if let Some(note) = &record.source_note {
        fields.push(("sourceNote", s(note)));
    }
    let mut body = record.markdown.trim_end().to_string();
    // A note that itself has a `## 抽查点` line keeps the section, so the note is never split there.
    if !points.is_empty() || has_heading(&body, POINTS_HEADING) {
        body.push_str("\n\n");
        body.push_str(POINTS_HEADING);
        let mut sorted: Vec<&RecallPoint> = points.iter().collect();
        sorted.sort_by_key(|point| point.order);
        for point in sorted {
            let prompt = point.prompt.split_whitespace().collect::<Vec<_>>().join(" ");
            body.push_str(&format!("\n\n### {}：{prompt} %%id:{}%%", type_label(&point.point_type), point.point_id));
            let reference = escape_headings(point.reference.trim());
            if !reference.is_empty() {
                body.push_str("\n\n");
                body.push_str(&reference);
            }
        }
    }
    fm::render(&fields, &body)
}

/// `框架：问题 %%id:…%%`; an unknown label keeps the whole text as the prompt (type framework).
fn parse_point_heading(text: &str) -> (String, String, Option<String>) {
    let mut text = text.trim().to_string();
    let mut id = None;
    if let Some(start) = text.rfind("%%id:") {
        if let Some(length) = text[start + 5..].find("%%") {
            id = Some(text[start + 5..start + 5 + length].trim().to_string()).filter(|id| !id.is_empty());
            text.replace_range(start..start + 5 + length + 2, "");
        }
    }
    let text = text.trim();
    for (key, label) in POINT_TYPES {
        for name in [label, key] {
            for separator in ['：', ':'] {
                if let Some(prompt) = text.strip_prefix(name).and_then(|rest| rest.trim_start().strip_prefix(separator)) {
                    return (key.to_string(), prompt.trim().to_string(), id);
                }
            }
        }
    }
    ("framework".into(), text.to_string(), id)
}

fn parse_points(section: &str, knowledge_id: &str) -> Vec<RecallPoint> {
    let mut points: Vec<(String, String, Option<String>, Vec<&str>)> = Vec::new();
    for (line, fenced) in super::fenced_lines(section) {
        match line.strip_prefix("### ") {
            Some(heading) if !fenced => {
                let (point_type, prompt, id) = parse_point_heading(heading);
                points.push((point_type, prompt, id, Vec::new()));
            }
            _ => {
                if let Some(last) = points.last_mut() {
                    last.3.push(line);
                }
            }
        }
    }
    let mut seen = HashSet::new();
    points
        .into_iter()
        .enumerate()
        .map(|(order, (point_type, prompt, id, lines))| {
            let mut point_id = id.unwrap_or_default();
            if point_id.is_empty() || !seen.insert(point_id.clone()) {
                point_id = format!("p{:016x}", super::hash(format!("{knowledge_id}\u{1f}{order}\u{1f}{prompt}").as_bytes()));
                seen.insert(point_id.clone());
            }
            RecallPoint {
                point_id,
                knowledge_id: knowledge_id.to_string(),
                point_type,
                prompt,
                reference: unescape_headings(&super::trim_blank_lines(&lines.join("\n"))),
                order,
            }
        })
        .collect()
}

pub(crate) fn parse(text: &str, fallback_title: &str) -> Result<(KnowledgeRecord, Option<String>, String), String> {
    let (front, body) = fm::parse(text)?;
    let (markdown, section) = split_at_heading(&body, POINTS_HEADING);
    let created_at = front.text("createdAt").unwrap_or_default();
    let record = KnowledgeRecord {
        id: front.text("id").map(|id| id.trim().to_string()).unwrap_or_default(),
        title: front.text("title").unwrap_or_else(|| fallback_title.to_string()),
        markdown,
        tags: front.get("tags").unwrap_or_default(),
        source_url: front.text("sourceUrl"),
        source_note: front.text("sourceNote"),
        updated_at: front.text("updatedAt").unwrap_or_else(|| created_at.clone()),
        created_at,
        next_review_at: None,
    };
    let has_id = (!record.id.is_empty()).then(|| record.id.clone());
    Ok((record, has_id, section.unwrap_or_default()))
}

/// Every note under `回想/` (subfolders included); unreadable files become issues.
pub(crate) fn scan(root: &Path) -> (Vec<Note>, Vec<Issue>) {
    let mut issues = Vec::new();
    let mut parsed = Vec::new();
    for path in md_files(&tab(root), true) {
        match read_md(&path).and_then(|text| parse(&text, &stem(&path))) {
            Ok((record, id, section)) => parsed.push((path, (record, id, section))),
            Err(error) => issues.push(issue("recall", root, &path, error)),
        }
    }
    dedupe_ids(root, "k", &mut parsed, |(record, _, _)| &mut record.id, &mut HashSet::new());
    let notes = parsed
        .into_iter()
        .map(|(path, (record, original, section))| Note {
            has_id: original.as_deref() == Some(record.id.as_str()),
            points: parse_points(&section, &record.id),
            path,
            record,
        })
        .collect();
    (notes, issues)
}

pub(crate) fn find(root: &Path, id: &str) -> Option<Note> {
    scan(root).0.into_iter().find(|note| note.record.id == id)
}

/// Writes a note in its current folder (or `回想/` when new), renaming the file when the title changed.
pub(crate) fn write(root: &Path, current: Option<&Path>, record: &KnowledgeRecord, points: &[RecallPoint]) -> Result<(), String> {
    let dir = current.and_then(Path::parent).map_or_else(|| tab(root), Path::to_path_buf);
    let mut used = used_names(&dir);
    let (path, old) = place(&dir, current, &file_stem(&record.title, "未命名知识"), &mut used);
    write_md(&path, &serialize(record, points))?;
    if let Some(old) = old {
        remove(&old)?;
    }
    Ok(())
}

/// Saving a note created outside beta-life writes its derived id into the frontmatter, so review
/// history stays attached after the file is renamed.
pub(crate) fn persist_id(root: &Path, id: &str) -> Result<(), String> {
    match find(root, id) {
        Some(note) if !note.has_id => write(root, Some(&note.path), &note.record, &note.points),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> KnowledgeRecord {
        KnowledgeRecord {
            id: "k1".into(),
            title: "推荐算法如何制造“窃听感”".into(),
            markdown: "推荐算法是怎么……\n\n## 协同过滤\n\n1. 相似的人".into(),
            tags: "推荐系统".into(),
            source_url: None,
            source_note: Some("书摘".into()),
            created_at: "2026-10-13T02:14:51.482Z".into(),
            updated_at: "2026-11-06T02:57:57.597Z".into(),
            next_review_at: None,
        }
    }

    fn point(id: &str, point_type: &str, prompt: &str, reference: &str, order: usize) -> RecallPoint {
        RecallPoint { point_id: id.into(), knowledge_id: "k1".into(), point_type: point_type.into(), prompt: prompt.into(), reference: reference.into(), order }
    }

    #[test]
    fn note_and_points_round_trip() {
        let points = vec![
            point("p-1", "framework", "协同过滤怎么推荐？", "相似的人买了什么。\n\n## 不是标题", 0),
            point("p-2", "relationship", "两者关系：是什么", "", 1),
        ];
        let text = serialize(&record(), &points);
        assert!(text.contains("\n## 抽查点\n\n### 框架：协同过滤怎么推荐？ %%id:p-1%%\n\n相似的人买了什么。\n\n\\## 不是标题\n"));
        let (parsed, id, section) = parse(&text, "x").unwrap();
        assert_eq!(id.as_deref(), Some("k1"));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::to_value(record()).unwrap());
        assert_eq!(serde_json::to_value(parse_points(&section, "k1")).unwrap(), serde_json::to_value(&points).unwrap());
    }

    #[test]
    fn points_written_in_obsidian_get_types_and_ids() {
        let points = parse_points("### 机制: 为什么？\n\n参考\n\n### 随便问问", "k1");
        assert_eq!(points.len(), 2);
        assert_eq!((points[0].point_type.as_str(), points[0].prompt.as_str(), points[0].reference.as_str()), ("mechanism", "为什么？", "参考"));
        assert_eq!((points[1].point_type.as_str(), points[1].prompt.as_str()), ("framework", "随便问问"));
        assert!(points[0].point_id.starts_with('p') && points[0].point_id != points[1].point_id);
        assert!(crate::valid_knowledge_id(&points[0].point_id));
    }

    #[test]
    fn a_note_with_its_own_points_heading_is_not_split() {
        let mut note = record();
        note.markdown = "正文\n\n## 抽查点\n\n自己写的".into();
        let (parsed, _, section) = parse(&serialize(&note, &[]), "x").unwrap();
        assert_eq!(parsed.markdown, note.markdown);
        assert!(section.is_empty());
    }

    #[test]
    fn rename_moves_the_file_and_derived_ids_get_persisted() {
        let root = super::super::test_root("recall");
        let dir = tab(&root);
        write(&root, None, &record(), &[]).unwrap();
        let mut renamed = record();
        renamed.title = "协同过滤".into();
        let note = find(&root, "k1").unwrap();
        write(&root, Some(&note.path), &renamed, &note.points).unwrap();
        assert_eq!(md_files(&dir, true), vec![dir.join("协同过滤.md")]);

        std::fs::create_dir_all(dir.join("子文件夹")).unwrap();
        std::fs::write(dir.join("子文件夹/手写.md"), "正文").unwrap();
        let note = scan(&root).0.into_iter().find(|note| note.record.title == "手写").unwrap();
        assert!(!note.has_id && note.record.id.starts_with('k'));
        persist_id(&root, &note.record.id).unwrap();
        let again = find(&root, &note.record.id).unwrap();
        assert!(again.has_id);
        assert_eq!(again.path, dir.join("子文件夹/手写.md"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
