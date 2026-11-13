//! One-time move from the v1 layout (JSON files and id-named md) to the vault layout. The new layout
//! is built in `.beta-life/migrating/` and only moved into place when every tab converted; the old
//! files then move, untouched, to `.beta-life/backup-v1-<time>/`.

use super::{board, copy_tree, forest, memories, recall, subdirs, AI, BOARD, FOREST, MEMORIES, META, RECALL, TIMELINE};
use crate::{
    parse_knowledge, parse_memory_markdown, read_json, validate_ability_forest, validate_board, AbilityForest, AbilityForestMetadata,
    AbilityMapKind, AbilityNode, BoardFile, RecallPoint,
};
use serde_json::json;
use std::{fs, path::Path};

const MARKER: &str = "vault.json";
const OLD: [&str; 9] = [
    "board.json",
    "board.before-import.backup.json",
    "knowledge",
    "memories",
    "ability-forest",
    "research-agenda",
    "ability-forest.json",
    "ai",
    "pet/sessions",
];
const TABS: [&str; 6] = [BOARD, RECALL, FOREST, MEMORIES, AI, TIMELINE];

pub(crate) fn run(root: &Path) -> Result<(), String> {
    let marker = root.join(META).join(MARKER);
    if marker.exists() {
        return Ok(());
    }
    let present: Vec<&str> = OLD.iter().copied().filter(|path| root.join(path).exists()).collect();
    let mut backup = None;
    if !present.is_empty() {
        for tab in TABS {
            let target = root.join(tab);
            // macOS file names ignore case: the old `ai` folder is the new `AI` tab and moves away first.
            let is_old = present.iter().any(|old| old.eq_ignore_ascii_case(tab));
            if !is_old && target.exists() && !is_empty_dir(&target) {
                return Err(format!("「{tab}」文件夹已经存在，无法把旧数据迁移进去"));
            }
        }
        let staging = root.join(META).join("migrating");
        let _ = fs::remove_dir_all(&staging);
        let built = fs::create_dir_all(&staging).map_err(|error| format!("无法创建迁移目录：{error}")).and_then(|()| build(root, &staging));
        forest::clear_registry(&staging);
        if let Err(error) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let directory = root.join(META).join(format!("backup-v1-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        if let Err(error) = swap(root, &staging, &directory, &present) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let _ = fs::remove_dir_all(&staging);
        backup = Some(directory.strip_prefix(root).unwrap_or(&directory).display().to_string());
    }
    crate::atomic_write(&marker, &json!({ "schemaVersion": 2, "migratedAt": chrono::Local::now().to_rfc3339(), "backup": backup }))
}

/// Old files into the backup, then the new tabs into place; any failure moves everything back.
fn swap(root: &Path, staging: &Path, backup: &Path, present: &[&str]) -> Result<(), String> {
    let mut backed_up: Vec<&str> = Vec::new();
    let mut moved_in: Vec<String> = Vec::new();
    let result = (|| {
        for path in present {
            let target = backup.join(path);
            fs::create_dir_all(target.parent().unwrap()).map_err(|error| format!("无法创建备份目录：{error}"))?;
            fs::rename(root.join(path), &target).map_err(|error| format!("无法把 {path} 移到备份目录：{error}"))?;
            backed_up.push(path);
        }
        for tab in subdirs(staging) {
            let target = root.join(&tab);
            if target.exists() {
                fs::remove_dir(&target).map_err(|error| format!("无法替换空文件夹 {tab}：{error}"))?;
            }
            fs::rename(staging.join(&tab), &target).map_err(|error| format!("无法移入 {tab}：{error}"))?;
            moved_in.push(tab);
        }
        Ok(())
    })();
    if result.is_err() {
        for tab in moved_in.iter().rev() {
            let _ = fs::rename(root.join(tab), staging.join(tab));
        }
        for path in backed_up.iter().rev() {
            let _ = fs::rename(backup.join(path), root.join(path));
        }
    }
    result
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

fn build(root: &Path, staging: &Path) -> Result<(), String> {
    let context = |what: &'static str| move |error: String| format!("迁移{what}失败：{error}");

    if root.join("board.json").exists() {
        let file: BoardFile = read_json(&root.join("board.json")).map_err(context("时间板"))?;
        validate_board(&file).map_err(context("时间板"))?;
        board::save(staging, &file).map_err(context("时间板"))?;
    }

    let knowledge = root.join("knowledge");
    for path in super::md_files(&knowledge.join("notes"), false) {
        let record = parse_knowledge(&path).map_err(context("回想"))?;
        let points_path = knowledge.join("points").join(format!("{}.json", record.id));
        let points: Vec<RecallPoint> = if points_path.exists() { read_json(&points_path).map_err(context("回想"))? } else { Vec::new() };
        recall::write(staging, None, &record, &points).map_err(context("回想"))?;
    }
    let recall_meta = recall::meta(staging);
    copy_tree(&knowledge.join("index.json"), &recall_meta.join("index.json"))?;
    copy_tree(&knowledge.join("reviews"), &recall_meta.join("reviews"))?;
    copy_tree(&knowledge.join("scheduler"), &recall_meta.join("scheduler"))?;

    let old_memories = root.join("memories");
    for path in super::md_files(&old_memories.join("nodes"), false) {
        let text = fs::read_to_string(&path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
        let memory = parse_memory_markdown(&super::stem(&path), &text).map_err(context("记忆星云"))?;
        memories::write(staging, None, &memory).map_err(context("记忆星云"))?;
    }
    copy_tree(&old_memories.join("life-stages.json"), &memories::stages_path(staging))?;

    for kind in [AbilityMapKind::Vision, AbilityMapKind::Research] {
        if root.join(kind.dir_name()).join("forest.json").exists() {
            let map = legacy_forest(root, kind).map_err(context("能力森林"))?;
            forest::save(staging, kind, &map).map_err(context("能力森林"))?;
        }
    }

    if root.join("ai").exists() {
        crate::ai::migrate_conversations(&root.join("ai"), staging).map_err(context("AI 对话"))?;
    }
    copy_tree(&root.join("pet").join("sessions"), &staging.join(TIMELINE).join(META).join("sessions"))
}

/// v1 map: `forest.json` + `nodes/<id>.md`, without the repeated `# 节点名` template line.
fn legacy_forest(root: &Path, kind: AbilityMapKind) -> Result<AbilityForest, String> {
    let dir = root.join(kind.dir_name());
    let stored: AbilityForestMetadata = read_json(&dir.join("forest.json"))?;
    let nodes = stored
        .nodes
        .into_iter()
        .map(|node| {
            let markdown = fs::read_to_string(dir.join("nodes").join(format!("{}.md", node.id))).unwrap_or_default();
            AbilityNode {
                markdown: forest::strip_repeated_title(&node.name, &markdown.replace("\r\n", "\n")),
                id: node.id,
                name: node.name,
                level: node.level,
                parent_id: node.parent_id,
                order: node.order,
                color: node.color,
                active: false,
            }
        })
        .collect();
    let map = AbilityForest {
        schema_version: stored.schema_version,
        name: stored.name,
        nodes,
        map_positions: stored.map_positions,
        map_state: stored.map_state,
    };
    validate_ability_forest(&map)?;
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{md_files, test_root};

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn v1_fixture(root: &Path) {
        write(&root.join("settings.json"), "{}");
        write(
            &root.join("board.json"),
            r#"{"schemaVersion":1,"activeBoardId":"default","boards":[{"id":"default","name":"My Life","items":[
              {"id":"h1","title":"听息/静坐","description":"备注","tags":"养生","placement":{"kind":"hour","hour":15},"order":0,"createdAt":"a","updatedAt":"b"}]}]}"#,
        );
        write(&root.join("knowledge/notes/k1.md"), "---\nid: k1\ntitle: 推荐算法\ncreatedAt: a\nupdatedAt: b\ntags: 推荐系统\n---\n\n正文\n");
        write(
            &root.join("knowledge/points/k1.json"),
            r#"[{"pointId":"p1","knowledgeId":"k1","type":"mechanism","prompt":"为什么？","reference":"因为","order":0}]"#,
        );
        write(&root.join("knowledge/reviews/k1.jsonl"), "{}\n");
        write(&root.join("knowledge/index.json"), r#"[{"id":"k1","nextReviewAt":"c"}]"#);
        write(
            &root.join("memories/nodes/memory_1.md"),
            "---\nsong: 南山南\ndate: 2013Q2\nlocation: 韶关\nemotion:\n  type: calm\n  intensity: 3\ncreatedAt: a\nupdatedAt: b\n---\n\n回忆\n",
        );
        write(&root.join("memories/life-stages.json"), "[]");
        write(
            &root.join("research-agenda/forest.json"),
            r##"{"schemaVersion":1,"name":"Research Agenda","nodes":[
              {"id":"d","name":"研究方向","level":0,"parentId":null,"order":0,"color":"#5A9FD4"},
              {"id":"g","name":"研究项目","level":1,"parentId":"d","order":0}]}"##,
        );
        write(&root.join("research-agenda/nodes/d.md"), "# 研究方向\n\n写下核心问题。");
        write(&root.join("research-agenda/nodes/g.md"), "# 别的名字\n\n## 小节");
        write(&root.join("pet/sessions/2026-11-11.jsonl"), "{\"x\":1}\n");
        write(&root.join("pet/window.json"), "{}");
    }

    #[test]
    fn migrates_every_tab_and_keeps_a_backup() {
        let root = test_root("migrate");
        v1_fixture(&root);
        run(&root).unwrap();

        assert!(root.join("settings.json").exists() && root.join("pet/window.json").exists());
        for old in ["board.json", "knowledge", "memories", "research-agenda", "pet/sessions"] {
            assert!(!root.join(old).exists(), "{old} should be moved to the backup");
        }
        let backups = subdirs(&root.join(META));
        let backup = backups.iter().find(|name| name.starts_with("backup-v1-")).expect("backup folder");
        assert!(root.join(META).join(backup).join("knowledge/notes/k1.md").exists());
        assert!(root.join(META).join(backup).join("pet/sessions/2026-11-11.jsonl").exists());

        let loaded = board::load(&root);
        assert_eq!(loaded.boards[0].items[0].title, "听息/静坐");
        assert!(root.join("时间板/My Life/听息／静坐.md").exists());

        let note = recall::find(&root, "k1").unwrap();
        assert_eq!(note.path, root.join("回想/推荐算法.md"));
        assert_eq!(note.points[0].point_id, "p1");
        assert!(recall::reviews_path(&root, "k1").exists());
        assert_eq!(recall::read_index(&root).unwrap()[0].next_review_at.as_deref(), Some("c"));

        let (path, memory) = memories::find(&root, "memory_1").unwrap();
        assert_eq!(path, root.join("记忆星云/2013Q2 南山南.md"));
        assert_eq!(memory.emotion.intensity, 3);

        let map = forest::load(&root, AbilityMapKind::Research).unwrap();
        let notes: Vec<(&str, &str)> = map.nodes.iter().map(|node| (node.name.as_str(), node.markdown.as_str())).collect();
        assert_eq!(notes, vec![("研究方向", "写下核心问题。"), ("研究项目", "# 别的名字\n\n## 小节")]);
        let text = fs::read_to_string(root.join("能力森林/Research Agenda/研究方向.md")).unwrap();
        assert!(text.contains("color: \"#5A9FD4\"") && text.contains("## 研究项目\n\n\\# 别的名字\n\n\\## 小节"));
        assert_eq!(md_files(&root.join(TIMELINE), true).len(), 0);
        assert!(root.join("时间轴/.beta-life/sessions/2026-11-11.jsonl").exists());

        // Runs once.
        run(&root).unwrap();
        assert!(root.join(META).join(MARKER).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_migration_leaves_the_old_files_alone() {
        let root = test_root("migrate-fail");
        v1_fixture(&root);
        write(&root.join("knowledge/notes/bad.md"), "没有头部");
        assert!(run(&root).is_err());
        assert!(root.join("board.json").exists() && root.join("knowledge/notes/k1.md").exists());
        assert!(!root.join(BOARD).exists() && !root.join(META).join(MARKER).exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// `BETA_LIFE_MIGRATE=<copy of app data> cargo test migrate_a_copy -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn migrate_a_copy() {
        let root = std::path::PathBuf::from(std::env::var("BETA_LIFE_MIGRATE").expect("BETA_LIFE_MIGRATE"));
        run(&root).unwrap();
        let board = board::load(&root);
        println!("board: {} boards, {} habits", board.boards.len(), board.boards.iter().map(|board| board.items.len()).sum::<usize>());
        validate_board(&board).unwrap();
        let (notes, issues) = recall::scan(&root);
        println!("recall: {} notes, {} points, issues {issues:?}", notes.len(), notes.iter().map(|note| note.points.len()).sum::<usize>());
        let (all, issues) = memories::scan(&root);
        println!("memories: {} , issues {issues:?}", all.len());
        for kind in [AbilityMapKind::Vision, AbilityMapKind::Research] {
            let map = forest::load(&root, kind).unwrap();
            println!("forest {}: {} nodes", kind.key(), map.nodes.len());
        }
    }
}
