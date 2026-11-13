//! 长期目标 (P7): 能力森林 nodes marked 在推进 are compared against the diary. The diary is the only
//! record: the evening summary writes `- 长期目标` with one `[[领域文件#节点]]：做了什么` per advanced goal,
//! and this module reads those lines back for the forest's badges and timeline.

use crate::{
    vault::{self, diary, forest},
    AbilityMapKind,
};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Goal {
    map: AbilityMapKind,
    path: Vec<String>,
    name: String,
    /// What goes inside `[[…]]` in the diary.
    link: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalEntry {
    map: AbilityMapKind,
    path: Vec<String>,
    /// `YYYY-MM-DD`.
    date: String,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalProgress {
    /// The 在推进 nodes, for the evening summary.
    goals: Vec<Goal>,
    /// Every diary mention that resolves to a node of these maps, oldest first.
    entries: Vec<GoalEntry>,
}

/// The node a link points to: the exact target, else the same file with a matching heading
/// (`file#能力组#能力` and hand-written spellings), 能力 before 能力组.
fn resolve<'a>(targets: &'a [forest::GoalTarget], link: &str) -> Option<&'a forest::GoalTarget> {
    if let Some(target) = targets.iter().find(|target| target.link == link) {
        return Some(target);
    }
    let (file, rest) = link.split_once('#')?;
    let heading = forest::link_heading(rest.rsplit('#').next().unwrap_or(rest));
    let file = vault::name_key(file.trim());
    targets
        .iter()
        .filter(|target| vault::name_key(&target.file) == file && forest::link_heading(&target.name) == heading)
        .max_by_key(|target| target.path.len())
}

fn progress(root: &Path, maps: &[AbilityMapKind]) -> GoalProgress {
    let mentions = diary::goal_mentions(root);
    let mut goals = Vec::new();
    let mut entries = Vec::new();
    for &map in maps {
        let targets = forest::goal_targets(root, map);
        for target in targets.iter().filter(|target| target.active) {
            goals.push(Goal { map, path: target.path.clone(), name: target.name.clone(), link: target.link.clone() });
        }
        for mention in &mentions {
            if let Some(target) = resolve(&targets, &mention.target) {
                entries.push(GoalEntry { map, path: target.path.clone(), date: mention.date.clone(), text: mention.text.clone() });
            }
        }
    }
    GoalProgress { goals, entries }
}

#[tauri::command]
pub(crate) fn load_goal_progress(app: AppHandle, maps: Vec<AbilityMapKind>) -> Result<GoalProgress, String> {
    let (_guard, root) = vault::open(&app)?;
    Ok(progress(&root, &maps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AbilityForest;

    fn forest_with(root: &Path) -> AbilityForest {
        let mut forest = forest::load(root, AbilityMapKind::Vision).unwrap();
        let group = forest.nodes.iter().position(|node| node.level == 1).unwrap();
        forest.nodes[group].name = "论文: 最低工资".into();
        forest.nodes[group].active = true;
        forest
    }

    #[test]
    fn diary_lines_become_progress_and_follow_renames() {
        let root = vault::test_root("goals");
        let forest = forest_with(&root);
        let renames = forest::save(&root, AbilityMapKind::Vision, &forest).unwrap();
        assert!(!renames.is_empty(), "the default group was renamed");
        let reloaded = forest::load(&root, AbilityMapKind::Vision).unwrap();
        let group = reloaded.nodes.iter().find(|node| node.level == 1 && node.name == "论文: 最低工资").unwrap();
        assert!(group.active, "在推进 survives a reload through map.json");

        let goal = &progress(&root, &[AbilityMapKind::Vision]).goals[0];
        assert!(goal.link.ends_with("#论文 最低工资"), "ASCII colon becomes a space: {}", goal.link);
        let file = goal.link.split('#').next().unwrap().to_string();
        let diary = format!(
            "## 261112周四\n\n- 工作\n\n=====【AI总结】=====\n\n- 长期目标\n\t- [[{0}]]：跑通事件研究图\n\t- 今天没看到别的\n\n---\n\n## 261113周五\n\n- 长期目标：\n\t- [[{0}|论文]]：改完稳健性检验\n- 其他\n\t- [[{0}]]：不在长期目标下面\n",
            goal.link
        );
        std::fs::create_dir_all(root.join("日记")).unwrap();
        std::fs::write(root.join("日记/2611 diary.md"), &diary).unwrap();
        let entries = progress(&root, &[AbilityMapKind::Vision]).entries;
        let found: Vec<(&str, &str)> = entries.iter().map(|entry| (entry.date.as_str(), entry.text.as_str())).collect();
        assert_eq!(found, [("2026-11-12", "跑通事件研究图"), ("2026-11-13", "改完稳健性检验")]);
        assert!(progress(&root, &[AbilityMapKind::Research]).entries.is_empty(), "other maps are not read");

        // Renaming the node in beta-life rewrites the diary links, alias kept.
        let mut renamed = reloaded.clone();
        let index = renamed.nodes.iter().position(|node| node.id == group.id).unwrap();
        renamed.nodes[index].name = "论文：最低工资与就业".into();
        let renames = forest::save(&root, AbilityMapKind::Vision, &renamed).unwrap();
        assert_eq!(renames, [(goal.link.clone(), format!("{file}#论文：最低工资与就业"))]);
        assert!(diary::rename_links(&root, &renames).unwrap());
        let text = std::fs::read_to_string(root.join("日记/2611 diary.md")).unwrap();
        assert!(text.contains(&format!("[[{file}#论文：最低工资与就业|论文]]")));
        assert!(!text.contains(&goal.link));
        assert_eq!(progress(&root, &[AbilityMapKind::Vision]).entries.len(), 2, "links still resolve after the rename");
        // Saving again with the same names changes nothing.
        assert!(forest::save(&root, AbilityMapKind::Vision, &renamed).unwrap().is_empty());
    }

    #[test]
    fn hand_written_links_resolve_by_heading() {
        let targets = vec![
            forest::GoalTarget { path: vec!["研究".into(), "论文".into()], name: "论文".into(), file: "研究".into(), link: "研究#论文".into(), active: true },
            forest::GoalTarget { path: vec!["研究".into(), "论文".into(), "回归".into()], name: "回归".into(), file: "研究".into(), link: "研究#回归".into(), active: false },
        ];
        assert_eq!(resolve(&targets, "研究#论文#回归").unwrap().name, "回归");
        assert_eq!(resolve(&targets, "研究#论文").unwrap().name, "论文");
        assert!(resolve(&targets, "别的#论文").is_none());
        assert!(resolve(&targets, "研究").is_none(), "a 领域 is not a goal");
    }
}
