//! 记忆星云: `记忆星云/**/<日期 歌名>.md`; life stages in `记忆星云/.beta-life/life-stages.json`.

use super::fm::{self, raw, s, Val};
use super::{dedupe_ids, file_stem, issue, md_files, place, read_md, remove, stem, used_names, write_md, Issue, MEMORIES, META};
use crate::{Memory, MemoryEmotion};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(crate) fn tab(root: &Path) -> PathBuf {
    root.join(MEMORIES)
}

pub(crate) fn stages_path(root: &Path) -> PathBuf {
    tab(root).join(META).join("life-stages.json")
}

pub(crate) fn serialize(memory: &Memory) -> String {
    let mut fields = vec![("id", s(&memory.id)), ("song", s(&memory.song)), ("date", s(&memory.date))];
    if let Some(stage) = memory.stage.as_deref().filter(|stage| !stage.trim().is_empty()) {
        fields.push(("stage", s(stage)));
    }
    fields.extend([
        ("location", s(&memory.location)),
        (
            "emotion",
            Val::Nested(vec![
                ("type".into(), s(&memory.emotion.emotion_type)),
                ("intensity".into(), raw(memory.emotion.intensity)),
            ]),
        ),
        ("createdAt", s(&memory.created_at)),
        ("updatedAt", s(&memory.updated_at)),
    ]);
    fm::render(&fields, &memory.content)
}

pub(crate) fn parse(text: &str, fallback_song: &str) -> Result<Memory, String> {
    let (front, body) = fm::parse(text)?;
    let emotion = front.map("emotion");
    let emotion_value = |key: &str| emotion.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
    let created_at = front.text("createdAt").unwrap_or_default();
    Ok(Memory {
        id: front.text("id").map(|id| id.trim().to_string()).unwrap_or_default(),
        song: front.text("song").unwrap_or_else(|| fallback_song.to_string()),
        date: front.get("date").unwrap_or_default(),
        stage: front.text("stage"),
        location: front.get("location").unwrap_or_default(),
        emotion: MemoryEmotion {
            emotion_type: emotion_value("type").unwrap_or_default(),
            intensity: emotion_value("intensity").and_then(|value| value.trim().parse::<u8>().ok()).unwrap_or(0).min(10),
        },
        content: body.trim().to_string(),
        updated_at: front.text("updatedAt").unwrap_or_else(|| created_at.clone()),
        created_at,
    })
}

pub(crate) fn scan(root: &Path) -> (Vec<(PathBuf, Memory)>, Vec<Issue>) {
    let mut issues = Vec::new();
    let mut memories = Vec::new();
    for path in md_files(&tab(root), true) {
        match read_md(&path).and_then(|text| parse(&text, &stem(&path))) {
            Ok(memory) => memories.push((path, memory)),
            Err(error) => issues.push(issue("memories", root, &path, error)),
        }
    }
    dedupe_ids(root, "memory_", &mut memories, |memory| &mut memory.id, &mut HashSet::new());
    (memories, issues)
}

pub(crate) fn find(root: &Path, id: &str) -> Option<(PathBuf, Memory)> {
    scan(root).0.into_iter().find(|(_, memory)| memory.id == id)
}

pub(crate) fn file_name(memory: &Memory) -> String {
    file_stem(&format!("{} {}", memory.date.trim(), memory.song.trim()), "未命名记忆")
}

pub(crate) fn write(root: &Path, current: Option<&Path>, memory: &Memory) -> Result<(), String> {
    let dir = current.and_then(Path::parent).map_or_else(|| tab(root), Path::to_path_buf);
    let mut used = used_names(&dir);
    let (path, old) = place(&dir, current, &file_name(memory), &mut used);
    write_md(&path, &serialize(memory))?;
    if let Some(old) = old {
        remove(&old)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Memory {
        Memory {
            id: "memory_1793122466716_ypue6vnpt".into(),
            song: "南山南".into(),
            date: "2013Q2".into(),
            stage: Some("初中".into()),
            location: "韶关支架厂".into(),
            emotion: MemoryEmotion { emotion_type: "melancholic".into(), intensity: 10 },
            content: "- 第一次听，是在韶关\n- 第一次听就觉得好伤心".into(),
            created_at: "2026-10-27T17:32:42.628Z".into(),
            updated_at: "2026-10-28T02:46:26.449Z".into(),
        }
    }

    #[test]
    fn memory_round_trips_with_a_numeric_intensity() {
        let text = serialize(&memory());
        assert!(text.contains("emotion:\n  type: melancholic\n  intensity: 10\n"));
        assert_eq!(serde_json::to_value(parse(&text, "x").unwrap()).unwrap(), serde_json::to_value(memory()).unwrap());
        assert_eq!(file_name(&memory()), "2013Q2 南山南");
    }

    #[test]
    fn reads_the_old_memory_format() {
        let old = "---\nsong: 南山南\ndate: 2013Q2\nstage: 初中\nlocation: 韶关支架厂\nemotion:\n  type: melancholic\n  intensity: 10\ncreatedAt: 2026-10-27T17:32:42.628Z\nupdatedAt: 2026-10-28T02:46:26.449Z\n---\n\n- 第一次听，是在韶关\n- 第一次听就觉得好伤心\n";
        let mut parsed = parse(old, "x").unwrap();
        assert!(parsed.id.is_empty());
        parsed.id = memory().id;
        assert_eq!(serde_json::to_value(parsed).unwrap(), serde_json::to_value(memory()).unwrap());
    }
}
