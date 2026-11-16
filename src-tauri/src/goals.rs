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

const DEFAULT_GOAL_STEP_PROMPT: &str = r#"从列出的目标里挑一个今天最容易动起来的，给一个小步骤：
1. 小而具体，10–30 分钟能做完，做完就算推进了一点（比如「打开论文草稿，列出下一节的三个小标题」）。
2. 参考这个目标节点的笔记和最近日记里相关的内容，接着上次停下的地方往下走；没有线索就从最小的准备动作开始。
3. 一两句话说完，不说教、不追问为什么没做；语言跟目标名称一致。"#;

pub(crate) fn default_goal_step_prompt() -> String {
    DEFAULT_GOAL_STEP_PROMPT.into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Goal {
    map: AbilityMapKind,
    path: Vec<String>,
    name: String,
    /// What goes inside `[[…]]` in the diary.
    link: String,
    /// Local `YYYY-MM-DD` it was marked 在推进; without progress it counts as stale from here.
    since: String,
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

fn progress(root: &Path, maps: &[AbilityMapKind], today: &str) -> Result<GoalProgress, String> {
    let mentions = diary::goal_mentions(root);
    let mut goals = Vec::new();
    let mut entries = Vec::new();
    for &map in maps {
        let targets = forest::goal_targets(root, map);
        let since = forest::goal_since(root, map, today)?;
        for target in targets.iter().filter(|target| target.active) {
            let since = since.get(&target.path).cloned().unwrap_or_else(|| today.to_string());
            goals.push(Goal { map, path: target.path.clone(), name: target.name.clone(), link: target.link.clone(), since });
        }
        for mention in &mentions {
            if let Some(target) = resolve(&targets, &mention.target) {
                entries.push(GoalEntry { map, path: target.path.clone(), date: mention.date.clone(), text: mention.text.clone() });
            }
        }
    }
    Ok(GoalProgress { goals, entries })
}

#[tauri::command]
pub(crate) fn load_goal_progress(app: AppHandle, maps: Vec<AbilityMapKind>) -> Result<GoalProgress, String> {
    let (_guard, root) = vault::open(&app)?;
    progress(&root, &maps, &chrono::Local::now().date_naive().format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AbilityForest;

    const TODAY: &str = "2026-11-14";

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

        let goal = &progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().goals[0];
        assert!(goal.link.ends_with("#论文 最低工资"), "ASCII colon becomes a space: {}", goal.link);
        let file = goal.link.split('#').next().unwrap().to_string();
        let diary = format!(
            "## 261112周四\n\n- 工作\n\n=====【AI总结】=====\n\n- 长期目标\n\t- [[{0}]]：跑通事件研究图\n\t- 今天没看到别的\n\n---\n\n## 261113周五\n\n- 长期目标：\n\t- [[{0}|论文]]：改完稳健性检验\n- 其他\n\t- [[{0}]]：不在长期目标下面\n",
            goal.link
        );
        std::fs::create_dir_all(root.join("日记")).unwrap();
        std::fs::write(root.join("日记/2611 diary.md"), &diary).unwrap();
        let entries = progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().entries;
        let found: Vec<(&str, &str)> = entries.iter().map(|entry| (entry.date.as_str(), entry.text.as_str())).collect();
        assert_eq!(found, [("2026-11-12", "跑通事件研究图"), ("2026-11-13", "改完稳健性检验")]);
        assert!(progress(&root, &[AbilityMapKind::Research], TODAY).unwrap().entries.is_empty(), "other maps are not read");

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
        assert_eq!(progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().entries.len(), 2, "links still resolve after the rename");
        // Saving again with the same names changes nothing.
        assert!(forest::save(&root, AbilityMapKind::Vision, &renamed).unwrap().is_empty());
    }

    #[test]
    fn marked_dates_survive_renames_and_old_goals_start_today() {
        let root = vault::test_root("goal-since");
        let forest = forest_with(&root);
        forest::save(&root, AbilityMapKind::Vision, &forest).unwrap();
        let marked = progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().goals[0].since.clone();
        assert_eq!(marked, chrono::Local::now().date_naive().format("%Y-%m-%d").to_string(), "a newly marked goal starts on the save day");

        // Renamed in beta-life: the date follows the node.
        let mut renamed = forest::load(&root, AbilityMapKind::Vision).unwrap();
        let index = renamed.nodes.iter().position(|node| node.active).unwrap();
        renamed.nodes[index].name = "论文：新题目".into();
        forest::save(&root, AbilityMapKind::Vision, &renamed).unwrap();
        assert_eq!(progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().goals[0].since, marked);

        // map.json from before dates were kept: the goal starts on the first day it is read, once.
        let meta_path = forest::map_meta_path(&root, AbilityMapKind::Vision);
        let mut meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        meta.as_object_mut().unwrap().remove("since");
        std::fs::write(&meta_path, meta.to_string()).unwrap();
        assert_eq!(progress(&root, &[AbilityMapKind::Vision], TODAY).unwrap().goals[0].since, TODAY);
        assert_eq!(progress(&root, &[AbilityMapKind::Vision], "2026-11-20").unwrap().goals[0].since, TODAY, "written back");
        std::fs::remove_dir_all(root).unwrap();
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
