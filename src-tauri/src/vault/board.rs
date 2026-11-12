//! 时间板: `时间板/<看板>/<习惯>.md`; board list in `时间板/.beta-life/boards.json`, habit order in
//! `时间板/<看板>/.beta-life/order.json` (habits missing from it go last).

use super::fm::{self, raw, s};
use super::{claim_name, dedupe_ids, derived_id, file_stem, issue, md_files, name_key, place, read_md, remove, rename_dir, set_issues, split_at_heading, stem, subdirs, has_heading, used_names, write_md, BOARD, META};
use crate::{default_board, period_name, Board, BoardFile, Habit, Obstacle, PeriodId, Placement, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const EXCERPT_HEADING: &str = "## AI 提取依据";
const OBSTACLE_HEADING: &str = "## 阻挠习惯的原因";

/// `- 2026-11-12：起晚了`; a line without a date is kept with an empty date.
fn obstacle_line(obstacle: &Obstacle) -> String {
    let text = obstacle.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if obstacle.date.is_empty() { format!("- {text}") } else { format!("- {}：{text}", obstacle.date) }
}

fn parse_obstacles(section: &str) -> Vec<Obstacle> {
    section
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).unwrap_or(line).trim();
            let dated = line
                .get(..10)
                .filter(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok())
                .and_then(|date| {
                    let rest = &line[10..];
                    rest.strip_prefix('：').or_else(|| rest.strip_prefix(':')).map(|text| (date.to_string(), text.trim().to_string()))
                });
            let (date, text) = dated.unwrap_or_else(|| (String::new(), line.to_string()));
            (!text.is_empty()).then_some(Obstacle { date, text })
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardsMeta {
    schema_version: u8,
    active_board_id: String,
    boards: Vec<BoardEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BoardEntry {
    id: String,
    name: String,
    folder: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OrderEntry {
    id: String,
    order: usize,
}

fn tab(root: &Path) -> PathBuf {
    root.join(BOARD)
}

fn meta_path(root: &Path) -> PathBuf {
    tab(root).join(META).join("boards.json")
}

fn order_path(dir: &Path) -> PathBuf {
    dir.join(META).join("order.json")
}

fn parse_period(value: &str) -> Option<PeriodId> {
    match value.trim() {
        "morning" => Some(PeriodId::Morning),
        "noon" => Some(PeriodId::Noon),
        "evening" => Some(PeriodId::Evening),
        "sleep" => Some(PeriodId::Sleep),
        _ => None,
    }
}

pub(crate) fn serialize_habit(habit: &Habit) -> String {
    let mut fields = vec![("id", s(&habit.id)), ("title", s(&habit.title))];
    match habit.placement {
        Placement::Hour { hour } => fields.push(("hour", raw(hour))),
        Placement::Period { period } => fields.push(("period", raw(period_name(period)))),
    }
    fields.extend([
        ("tags", s(&habit.tags)),
        ("done", raw(habit.done)),
        ("createdAt", s(&habit.created_at)),
        ("updatedAt", s(&habit.updated_at)),
    ]);
    let mut body = habit.description.trim_end().to_string();
    // Like the excerpt below: a note that itself contains the heading keeps an (empty) section after it.
    if !habit.obstacles.is_empty() || has_heading(&body, OBSTACLE_HEADING) {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(OBSTACLE_HEADING);
        if !habit.obstacles.is_empty() {
            body.push_str("\n\n");
            body.push_str(&habit.obstacles.iter().map(obstacle_line).collect::<Vec<_>>().join("\n"));
        }
    }
    let excerpt = habit.source_excerpt.as_deref().map(str::trim).filter(|excerpt| !excerpt.is_empty());
    // A note that itself contains the heading keeps an (empty) section after it, so it is not split.
    if excerpt.is_some() || has_heading(&body, EXCERPT_HEADING) {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(EXCERPT_HEADING);
        if let Some(excerpt) = excerpt {
            body.push_str("\n\n");
            body.push_str(excerpt);
        }
    }
    fm::render(&fields, &body)
}

/// Missing fields fall back so a habit written by hand in Obsidian still loads: title from the file
/// name, `morning` when there is no valid time, timestamps from the file.
pub(crate) fn parse_habit(text: &str, fallback_id: &str, fallback_title: &str, modified: &str) -> Result<Habit, String> {
    let (front, body) = fm::parse(text)?;
    let (rest, excerpt) = split_at_heading(&body, EXCERPT_HEADING);
    let (description, obstacles) = split_at_heading(&rest, OBSTACLE_HEADING);
    let placement = match front.get("hour").and_then(|hour| hour.trim().parse::<u8>().ok()) {
        Some(hour) if hour <= 23 => Placement::Hour { hour },
        _ => Placement::Period {
            period: front.get("period").as_deref().and_then(parse_period).unwrap_or(PeriodId::Morning),
        },
    };
    let created_at = front.text("createdAt").unwrap_or_else(|| modified.to_string());
    Ok(Habit {
        id: front.text("id").map(|id| id.trim().to_string()).unwrap_or_else(|| fallback_id.to_string()),
        title: front.text("title").unwrap_or_else(|| fallback_title.to_string()),
        description,
        tags: front.get("tags").unwrap_or_default(),
        placement,
        order: 0,
        source_excerpt: excerpt.filter(|excerpt| !excerpt.is_empty()),
        updated_at: front.text("updatedAt").unwrap_or_else(|| created_at.clone()),
        created_at,
        done: front.get("done").is_some_and(|done| done.trim().eq_ignore_ascii_case("true")),
        obstacles: obstacles.as_deref().map(parse_obstacles).unwrap_or_default(),
    })
}

fn modified(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Habits of one board folder with their files. A copied file whose id is already taken gets a new id.
fn read_folder(root: &Path, dir: &Path, seen: &mut HashSet<String>, issues: &mut Vec<super::Issue>) -> Vec<(PathBuf, Habit)> {
    let mut habits = Vec::new();
    for path in md_files(dir, false) {
        let parsed = read_md(&path).and_then(|text| parse_habit(&text, "", &stem(&path), &modified(&path)));
        match parsed {
            Ok(habit) => habits.push((path, habit)),
            Err(error) => issues.push(issue("board", root, &path, error)),
        }
    }
    dedupe_ids(root, "h", &mut habits, |habit| &mut habit.id, seen);
    habits
}

fn read_meta(root: &Path) -> Option<BoardsMeta> {
    crate::read_json(&meta_path(root)).ok()
}

/// Boards from the meta file whose folder exists, then folders created outside beta-life.
fn entries(root: &Path, meta: Option<&BoardsMeta>) -> Vec<BoardEntry> {
    let folders = subdirs(&tab(root));
    let mut entries: Vec<BoardEntry> = meta
        .map(|meta| meta.boards.iter().filter(|entry| folders.contains(&entry.folder)).cloned().collect())
        .unwrap_or_default();
    for folder in folders {
        if !entries.iter().any(|entry| entry.folder == folder) {
            entries.push(BoardEntry {
                id: derived_id("b", root, &tab(root).join(&folder)),
                name: folder.clone(),
                folder,
            });
        }
    }
    entries
}

pub(crate) fn load(root: &Path) -> BoardFile {
    let meta = read_meta(root);
    let entries = entries(root, meta.as_ref());
    if entries.is_empty() {
        set_issues("board", Vec::new());
        return default_board();
    }
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    let boards = entries
        .iter()
        .map(|entry| {
            let dir = tab(root).join(&entry.folder);
            let mut items: Vec<Habit> = read_folder(root, &dir, &mut seen, &mut issues).into_iter().map(|(_, habit)| habit).collect();
            apply_order(&dir, &mut items);
            Board { id: entry.id.clone(), name: entry.name.clone(), items }
        })
        .collect();
    set_issues("board", issues);
    let active = meta
        .map(|meta| meta.active_board_id)
        .filter(|id| entries.iter().any(|entry| &entry.id == id))
        .unwrap_or_else(|| entries[0].id.clone());
    BoardFile { schema_version: SCHEMA_VERSION, active_board_id: active, boards }
}

fn apply_order(dir: &Path, items: &mut [Habit]) {
    let stored: Vec<OrderEntry> = crate::read_json(&order_path(dir)).unwrap_or_default();
    let position: HashMap<&str, (usize, usize)> =
        stored.iter().enumerate().map(|(index, entry)| (entry.id.as_str(), (index, entry.order))).collect();
    items.sort_by(|left, right| {
        let key = |habit: &Habit| position.get(habit.id.as_str()).map_or(usize::MAX, |(index, _)| *index);
        key(left).cmp(&key(right)).then_with(|| left.created_at.cmp(&right.created_at))
    });
    let mut next = 0;
    for habit in items.iter_mut() {
        habit.order = match position.get(habit.id.as_str()) {
            Some((_, order)) => *order,
            None => stored.len() + next,
        };
        if !position.contains_key(habit.id.as_str()) {
            next += 1;
        }
    }
}

pub(crate) fn save(root: &Path, board: &BoardFile) -> Result<(), String> {
    let tab = tab(root);
    fs::create_dir_all(&tab).map_err(|error| format!("无法创建时间板目录：{error}"))?;
    let meta = read_meta(root);
    let current = entries(root, meta.as_ref());
    let mut folders: HashSet<String> = subdirs(&tab).iter().map(|name| name_key(name)).collect();
    let mut saved = Vec::new();
    for board in &board.boards {
        let desired = file_stem(&board.name, "看板");
        let folder = match current.iter().find(|entry| entry.id == board.id) {
            Some(entry) if super::fits(&entry.folder, &desired) => entry.folder.clone(),
            Some(entry) => {
                let name = claim_name(&desired, &mut folders);
                rename_dir(&tab.join(&entry.folder), &tab.join(&name))?;
                name
            }
            None => claim_name(&desired, &mut folders),
        };
        save_folder(root, &tab.join(&folder), &board.items)?;
        saved.push(BoardEntry { id: board.id.clone(), name: board.name.clone(), folder });
    }
    for entry in current.iter().filter(|entry| !board.boards.iter().any(|board| board.id == entry.id)) {
        remove_folder(root, &tab.join(&entry.folder))?;
    }
    crate::atomic_write(
        &meta_path(root),
        &BoardsMeta { schema_version: SCHEMA_VERSION, active_board_id: board.active_board_id.clone(), boards: saved },
    )
}

fn save_folder(root: &Path, dir: &Path, items: &[Habit]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("无法创建看板目录：{error}"))?;
    let existing: HashMap<String, PathBuf> =
        read_folder(root, dir, &mut HashSet::new(), &mut Vec::new()).into_iter().map(|(path, habit)| (habit.id, path)).collect();
    let mut used = used_names(dir);
    for habit in items {
        let desired = file_stem(&habit.title, "未命名习惯");
        let (path, old) = place(dir, existing.get(&habit.id).map(PathBuf::as_path), &desired, &mut used);
        write_md(&path, &serialize_habit(habit))?;
        if let Some(old) = old {
            remove(&old)?;
        }
    }
    let kept: HashSet<&str> = items.iter().map(|habit| habit.id.as_str()).collect();
    for (id, path) in &existing {
        if !kept.contains(id.as_str()) {
            remove(path)?;
        }
    }
    let order: Vec<OrderEntry> = items.iter().map(|habit| OrderEntry { id: habit.id.clone(), order: habit.order }).collect();
    crate::atomic_write(&order_path(dir), &order)
}

/// A deleted board: its habit files go, files beta-life cannot read stay.
fn remove_folder(root: &Path, dir: &Path) -> Result<(), String> {
    for (path, _) in read_folder(root, dir, &mut HashSet::new(), &mut Vec::new()) {
        remove(&path)?;
    }
    let _ = fs::remove_dir_all(dir.join(META));
    let _ = fs::remove_dir(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn habit(id: &str, title: &str, placement: Placement, order: usize) -> Habit {
        Habit {
            id: id.into(),
            title: title.into(),
            description: String::new(),
            tags: String::new(),
            placement,
            order,
            source_excerpt: None,
            created_at: "2026-11-01T00:00:00.000Z".into(),
            updated_at: "2026-11-01T00:00:00.000Z".into(),
            done: false,
            obstacles: Vec::new(),
        }
    }

    fn board(items: Vec<Habit>) -> BoardFile {
        BoardFile { schema_version: SCHEMA_VERSION, active_board_id: "default".into(), boards: vec![Board { id: "default".into(), name: "My Life".into(), items }] }
    }

    #[test]
    fn habit_markdown_round_trips() {
        let mut item = habit("a1", "听息/静坐", Placement::Hour { hour: 15 }, 0);
        item.description = "操作：坐在椅子上。\n\n- 听呼吸".into();
        item.tags = "道家修心与养生".into();
        item.source_excerpt = Some("原文：每天静坐".into());
        item.done = true;
        let text = serialize_habit(&item);
        assert!(text.contains("title: 听息/静坐\nhour: 15\n"));
        assert!(text.contains("\n## AI 提取依据\n\n原文：每天静坐\n"));
        let parsed = parse_habit(&text, "x", "x", "").unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::to_value(&item).unwrap());

        item.source_excerpt = None;
        item.description = "备注\n\n## AI 提取依据\n\n自己写的".into();
        let parsed = parse_habit(&serialize_habit(&item), "x", "x", "").unwrap();
        assert_eq!(parsed.description, item.description);
        assert_eq!(parsed.source_excerpt, None);
    }

    #[test]
    fn obstacles_round_trip_between_the_note_and_the_excerpt() {
        let mut item = habit("a1", "晨跑", Placement::Period { period: PeriodId::Morning }, 0);
        item.description = "慢跑 20 分钟".into();
        item.source_excerpt = Some("原文".into());
        item.obstacles = vec![
            Obstacle { date: "2026-11-11".into(), text: "下雨".into() },
            Obstacle { date: "2026-11-12".into(), text: "起晚了，赶组会".into() },
        ];
        let text = serialize_habit(&item);
        assert!(text.ends_with("慢跑 20 分钟\n\n## 阻挠习惯的原因\n\n- 2026-11-11：下雨\n- 2026-11-12：起晚了，赶组会\n\n## AI 提取依据\n\n原文\n"), "{text}");
        let parsed = parse_habit(&text, "x", "x", "").unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::to_value(&item).unwrap());
        assert_eq!(serialize_habit(&parsed), text, "beta-life's own file is byte stable");

        // Hand edits in Obsidian: a line without a date, `*` bullets, an ASCII colon.
        let parsed = parse_habit("---\ntitle: 晨跑\n---\n备注\n\n## 阻挠习惯的原因\n\n* 太累\n- 2026-11-10: 出差\n\n", "x", "x", "").unwrap();
        assert_eq!(parsed.description, "备注");
        assert_eq!(parsed.obstacles, vec![Obstacle { date: String::new(), text: "太累".into() }, Obstacle { date: "2026-11-10".into(), text: "出差".into() }]);

        // A note that itself has the heading and no obstacles keeps its text.
        item.obstacles.clear();
        item.source_excerpt = None;
        item.description = "备注\n\n## 阻挠习惯的原因\n\n自己写的".into();
        let parsed = parse_habit(&serialize_habit(&item), "x", "x", "").unwrap();
        assert_eq!(parsed.description, item.description);
        assert!(parsed.obstacles.is_empty());
    }

    #[test]
    fn hand_written_habits_get_fallbacks() {
        let parsed = parse_habit("早起喝水", "h1", "喝水", "2026-11-11T00:00:00.000Z").unwrap();
        assert_eq!(parsed.id, "h1");
        assert_eq!(parsed.title, "喝水");
        assert_eq!(parsed.description, "早起喝水");
        assert!(matches!(parsed.placement, Placement::Period { period: PeriodId::Morning }));
        assert_eq!(parsed.created_at, "2026-11-11T00:00:00.000Z");
    }

    #[test]
    fn saves_renames_deletes_and_keeps_order() {
        let root = super::super::test_root("board");
        let first = board(vec![
            habit("a", "跑步", Placement::Hour { hour: 7 }, 1),
            habit("b", "跑步", Placement::Hour { hour: 7 }, 0),
            habit("c", "读书/写作", Placement::Period { period: PeriodId::Evening }, 0),
        ]);
        save(&root, &first).unwrap();
        let dir = root.join("时间板/My Life");
        assert!(dir.join("跑步.md").exists() && dir.join("跑步 2.md").exists() && dir.join("读书／写作.md").exists());
        let loaded = load(&root);
        assert_eq!(serde_json::to_value(&loaded).unwrap(), serde_json::to_value(&first).unwrap());

        let mut second = first.clone();
        second.boards[0].items.remove(1);
        second.boards[0].items[1].title = "读书".into();
        second.boards[0].name = "生活".into();
        save(&root, &second).unwrap();
        let dir = root.join("时间板/生活");
        assert!(!root.join("时间板/My Life").exists());
        assert!(dir.join("跑步.md").exists() && !dir.join("跑步 2.md").exists());
        assert!(dir.join("读书.md").exists() && !dir.join("读书／写作.md").exists());
        assert_eq!(serde_json::to_value(load(&root)).unwrap(), serde_json::to_value(&second).unwrap());

        // A habit added in Obsidian: no id, goes last; a copied file gets its own id.
        fs::write(dir.join("新习惯.md"), "---\nhour: 9\n---\n").unwrap();
        fs::write(dir.join("跑步 副本.md"), fs::read(dir.join("跑步.md")).unwrap()).unwrap();
        let loaded = load(&root);
        let items = &loaded.boards[0].items;
        assert_eq!(items.len(), 4);
        assert_eq!(items.iter().map(|item| item.id.clone()).collect::<HashSet<_>>().len(), 4);
        assert_eq!(items.iter().find(|item| item.id == "a").map(|item| item.order), Some(1), "the original keeps its id");
        assert!(items.iter().any(|item| item.title == "新习惯" && matches!(item.placement, Placement::Hour { hour: 9 })));
        crate::validate_board(&loaded).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
