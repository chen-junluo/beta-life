//! bebe's preferences (P5). The numbers live in `AppSettings.pet`; the words the user asked bebe to
//! remember live in `bebe/偏好.md` in the data folder (synced, editable in Obsidian); the short-lived
//! plan (pause, one-off reminders) stays on this Mac. All three go into the assistant's system prompt.

use super::{app_data_dir, atomic_write, read_json, vault, AppSettings, PeriodId};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::PathBuf};
use tauri::{AppHandle, Emitter};

const FOLDER: &str = "bebe";
const FILE: &str = "偏好.md";
const STYLE: &str = "说话风格";
const ABOUT: &str = "我说过的";
const MAX_ITEMS: usize = 100;
const MAX_ITEM_CHARS: usize = 500;
const MAX_REMINDERS: usize = 50;
/// Emitted to every window after the plan changed.
const PLAN_EVENT: &str = "pet://plan";

// ---------- settings ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    const ALL: [Weekday; 7] = [Self::Mon, Self::Tue, Self::Wed, Self::Thu, Self::Fri, Self::Sat, Self::Sun];

    fn label(self) -> &'static str {
        ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][self as usize]
    }
}

/// Days and a local `HH:MM` range; `end` before `start` runs past midnight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuietHours {
    days: Vec<Weekday>,
    start: String,
    end: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PetSettings {
    /// Slack reminder: slack fills more than `slack_share_percent` of the last `slack_window_minutes`…
    slack_window_minutes: u16,
    slack_share_percent: u8,
    /// …and the current slack streak is at least this long.
    slack_streak_minutes: u16,
    slack_cooldown_minutes: u16,
    /// 「X 分钟后再说」 on a slack reminder.
    slack_snooze_minutes: u16,
    /// The evening summary shows this long before the sleep period starts.
    summary_lead_minutes: u16,
    /// 「稍后提醒」 on a habit reminder.
    habit_snooze_minutes: u16,
    /// No slack reminders, questions or habit reminders inside these.
    quiet_hours: Vec<QuietHours>,
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            slack_window_minutes: 10,
            slack_share_percent: 60,
            slack_streak_minutes: 5,
            slack_cooldown_minutes: 30,
            slack_snooze_minutes: 10,
            summary_lead_minutes: 30,
            habit_snooze_minutes: 15,
            quiet_hours: Vec::new(),
        }
    }
}

/// `HH:MM` → minutes after midnight.
fn clock_minutes(clock: &str) -> Option<u16> {
    let (hours, minutes) = clock.split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    let (hours, minutes) = (hours.parse::<u16>().ok()?, minutes.parse::<u16>().ok()?);
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

pub(crate) fn validate(settings: &PetSettings) -> Result<(), String> {
    let ranges: [(&str, u16, u16, u16); 7] = [
        ("摸鱼统计窗口", settings.slack_window_minutes, 3, 60),
        ("摸鱼占比", settings.slack_share_percent.into(), 10, 100),
        ("连续摸鱼时长", settings.slack_streak_minutes, 1, 120),
        ("两次摸鱼提醒的间隔", settings.slack_cooldown_minutes, 1, 240),
        ("摸鱼提醒「再说」", settings.slack_snooze_minutes, 1, 240),
        ("晚间总结提前量", settings.summary_lead_minutes, 5, 180),
        ("习惯「稍后提醒」", settings.habit_snooze_minutes, 1, 240),
    ];
    for (name, value, min, max) in ranges {
        if !(min..=max).contains(&value) {
            let unit = if name == "摸鱼占比" { "%" } else { " 分钟" };
            return Err(format!("{name}应在 {min}–{max}{unit} 之间"));
        }
    }
    if settings.quiet_hours.len() > 20 {
        return Err("安静时段最多 20 段".into());
    }
    for quiet in &settings.quiet_hours {
        let days: HashSet<_> = quiet.days.iter().collect();
        if quiet.days.is_empty() || days.len() != quiet.days.len() {
            return Err("每段安静时段至少选一天，且不能重复".into());
        }
        match (clock_minutes(&quiet.start), clock_minutes(&quiet.end)) {
            (Some(start), Some(end)) if start != end => {}
            (Some(_), Some(_)) => return Err("安静时段的开始和结束不能相同".into()),
            _ => return Err("安静时段的时间格式应为 HH:MM".into()),
        }
    }
    Ok(())
}

fn quiet_text(quiet: &QuietHours) -> String {
    let days = Weekday::ALL
        .iter()
        .filter(|day| quiet.days.contains(day))
        .map(|day| day.label())
        .collect::<Vec<_>>()
        .join("、");
    format!("{days} {}–{}", quiet.start, quiet.end)
}

// ---------- profile md ----------

/// What the user asked bebe to remember, one bullet per item.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    /// How bebe (and the assistant) talks; added to every conversation.
    style: Vec<String>,
    /// Things about the user and their life.
    about: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Style,
    About,
    Other,
}

fn section_of(line: &str) -> Option<Section> {
    let name = line.strip_prefix("## ")?.trim();
    Some(match name {
        STYLE => Section::Style,
        ABOUT => Section::About,
        _ => Section::Other,
    })
}

fn bullet(line: &str) -> Option<&str> {
    line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).or((line == "-").then_some(""))
}

/// Continuation of a bullet: an indented non-empty line.
fn continues(line: &str) -> bool {
    line.starts_with([' ', '\t']) && !line.trim().is_empty()
}

fn parse(text: &str) -> Profile {
    let mut profile = Profile::default();
    let mut section = Section::Other;
    let mut open = false;
    for line in text.lines() {
        if let Some(next) = section_of(line) {
            section = next;
            open = false;
            continue;
        }
        let list = match section {
            Section::Style => &mut profile.style,
            Section::About => &mut profile.about,
            Section::Other => continue,
        };
        if let Some(item) = bullet(line) {
            list.push(item.trim_end().to_string());
            open = true;
        } else if open && continues(line) {
            if let Some(last) = list.last_mut() {
                last.push('\n');
                last.push_str(line.trim_end());
            }
        } else {
            open = false;
        }
    }
    for list in [&mut profile.style, &mut profile.about] {
        list.retain(|item| !item.trim().is_empty());
    }
    profile
}

fn items_text(items: &[String]) -> String {
    items.iter().map(|item| format!("- {item}\n")).collect()
}

/// Writes the two lists into `current`: their bullets are replaced, every other line (the title,
/// other sections, text that is not a bullet) stays as it was. Missing sections are appended.
fn render(current: &str, profile: &Profile) -> String {
    let mut out = String::new();
    let mut section = Section::Other;
    let mut open = false;
    let (mut has_style, mut has_about) = (false, false);
    for line in current.lines() {
        if let Some(next) = section_of(line) {
            section = next;
            open = false;
            out.push_str(line);
            out.push('\n');
            match next {
                Section::Style if !has_style => {
                    has_style = true;
                    out.push_str(&items_text(&profile.style));
                }
                Section::About if !has_about => {
                    has_about = true;
                    out.push_str(&items_text(&profile.about));
                }
                _ => {}
            }
            continue;
        }
        if section != Section::Other {
            if bullet(line).is_some() {
                open = true;
                continue;
            }
            if open && continues(line) {
                continue;
            }
            open = false;
        }
        out.push_str(line);
        out.push('\n');
    }
    if out.trim().is_empty() {
        out = "# bebe 偏好\n".into();
    }
    for (present, name, items) in [(has_style, STYLE, &profile.style), (has_about, ABOUT, &profile.about)] {
        if present {
            continue;
        }
        if !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str(&format!("## {name}\n{}", items_text(items)));
    }
    out
}

fn clean_items(items: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let items: Vec<String> = items
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty() && seen.insert(item.clone()))
        .collect();
    if items.len() > MAX_ITEMS {
        return Err(format!("每一类偏好最多 {MAX_ITEMS} 条"));
    }
    if items.iter().any(|item| item.chars().count() > MAX_ITEM_CHARS) {
        return Err(format!("每条偏好最多 {MAX_ITEM_CHARS} 个字"));
    }
    Ok(items)
}

fn profile_path(root: &std::path::Path) -> PathBuf {
    root.join(FOLDER).join(FILE)
}

fn read_text(path: &std::path::Path) -> Result<String, String> {
    if path.exists() {
        vault::read_md(path)
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub(crate) fn load_pet_profile(app: AppHandle) -> Result<Profile, String> {
    let (_guard, root) = vault::open(&app)?;
    read_text(&profile_path(&root)).map(|text| parse(&text))
}

/// Settings and confirmed AI changes replace both lists; the rest of the file is kept.
#[tauri::command]
pub(crate) fn save_pet_profile(app: AppHandle, profile: Profile) -> Result<Profile, String> {
    let profile = Profile { style: clean_items(&profile.style)?, about: clean_items(&profile.about)? };
    let (_guard, root) = vault::open(&app)?;
    let path = profile_path(&root);
    let current = read_text(&path)?;
    let next = render(&current, &profile);
    if next != current {
        vault::write_md(&path, &next)?;
    }
    Ok(profile)
}

// ---------- plan (this Mac only) ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OneOffReminder {
    id: String,
    /// Unix milliseconds.
    at: i64,
    text: String,
}

/// Short-lived and instant (no diff card): undone from the chat.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetPlan {
    /// No slack reminders, questions or habit reminders before this (Unix milliseconds).
    #[serde(default)]
    snooze_until: Option<i64>,
    #[serde(default)]
    reminders: Vec<OneOffReminder>,
}

fn plan_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("pet").join("plan.json"))
}

fn read_plan(app: &AppHandle) -> Result<PetPlan, String> {
    let path = plan_path(app)?;
    if path.exists() {
        read_json(&path)
    } else {
        Ok(PetPlan::default())
    }
}

#[tauri::command]
pub(crate) fn load_pet_plan(app: AppHandle) -> Result<PetPlan, String> {
    read_plan(&app)
}

#[tauri::command]
pub(crate) fn save_pet_plan(app: AppHandle, plan: PetPlan) -> Result<(), String> {
    if plan.reminders.len() > MAX_REMINDERS {
        return Err(format!("一次性提醒最多 {MAX_REMINDERS} 个"));
    }
    if plan.reminders.iter().any(|reminder| reminder.id.is_empty() || reminder.text.trim().is_empty() || reminder.text.chars().count() > 200) {
        return Err("提醒内容不能为空，最多 200 个字".into());
    }
    atomic_write(&plan_path(&app)?, &plan)?;
    app.emit(PLAN_EVENT, &plan).map_err(|error| format!("无法通知 bebe：{error}"))
}

// ---------- system prompt ----------

fn local_time(ms: i64, format: &str) -> String {
    Local.timestamp_millis_opt(ms).single().map(|time| time.format(format).to_string()).unwrap_or_default()
}

fn list(items: &[String]) -> String {
    if items.is_empty() {
        return "- (none)".into();
    }
    items.iter().map(|item| format!("- {}", item.replace('\n', "\n  "))).collect::<Vec<_>>().join("\n")
}

/// What the assistant knows about bebe: its settings, the plan and the remembered preferences.
fn prompt_section(settings: &AppSettings, profile: &Profile, plan: &PetPlan, now_ms: i64) -> String {
    let pet = &settings.pet;
    let sleep = settings.periods.iter().find(|period| period.id == PeriodId::Sleep).map(|period| period.start_hour).unwrap_or(23);
    let summary_at = (u32::from(sleep) * 60 + 1440 - u32::from(pet.summary_lead_minutes)) % 1440;
    let quiet = if pet.quiet_hours.is_empty() {
        "none".to_string()
    } else {
        pet.quiet_hours.iter().map(quiet_text).collect::<Vec<_>>().join("; ")
    };
    let paused = match plan.snooze_until {
        Some(until) if until > now_ms => format!("paused until {}", local_time(until, "%m-%d %H:%M")),
        _ => "not paused".into(),
    };
    let reminders = if plan.reminders.is_empty() {
        "- (none)".to_string()
    } else {
        plan.reminders
            .iter()
            .map(|reminder| format!("- id `{}`: {} {}", reminder.id, local_time(reminder.at, "%m-%d %H:%M"), reminder.text))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        r#"bebe (the desk pet) settings, changed with set_bebe_settings: a slack reminder when slack fills more than {share}% of the last {window} min and the current slack streak is at least {streak} min, at most one every {cooldown} min; its 「再说」 button waits {snooze} min. The evening summary shows {lead} min before the sleep period, at {summary_hour:02}:{summary_minute:02}. A habit reminder's 「稍后提醒」 waits {habit} min.
Quiet hours (no slack reminders, questions or habit reminders): {quiet}.
Right now bebe is {paused}.
One-off reminders:
{reminders}

What the user asked to remember (remember_preference / forget_preference):
Speaking style, follow it in every reply:
{style}
About the user:
{about}"#,
        share = pet.slack_share_percent,
        window = pet.slack_window_minutes,
        streak = pet.slack_streak_minutes,
        cooldown = pet.slack_cooldown_minutes,
        snooze = pet.slack_snooze_minutes,
        lead = pet.summary_lead_minutes,
        summary_hour = summary_at / 60,
        summary_minute = summary_at % 60,
        habit = pet.habit_snooze_minutes,
        style = list(&profile.style),
        about = list(&profile.about),
    )
}

/// A broken profile or plan file must not block the chat; it shows as empty instead.
pub(crate) fn prompt_for(app: &AppHandle, settings: &AppSettings) -> String {
    let profile = vault::open(app)
        .and_then(|(_guard, root)| read_text(&profile_path(&root)))
        .map(|text| parse(&text))
        .unwrap_or_default();
    let plan = read_plan(app).unwrap_or_default();
    prompt_section(settings, &profile, &plan, Local::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# bebe 偏好\n\n## 说话风格\n- 少用感叹号\n- 叫我小陈\n\n## 我说过的\n- 周三下午要上课\n\t- 14:00–16:00\n\n## 我自己的笔记\n- 不归 bebe 管\n";

    #[test]
    fn profile_round_trips_byte_for_byte() {
        let profile = parse(SAMPLE);
        assert_eq!(profile.style, vec!["少用感叹号", "叫我小陈"]);
        assert_eq!(profile.about, vec!["周三下午要上课\n\t- 14:00–16:00"]);
        assert_eq!(render(SAMPLE, &profile), SAMPLE);
    }

    #[test]
    fn rendering_keeps_other_sections_and_text() {
        let text = "前言\n\n## 说话风格\n说明文字\n- 旧的\n\n## 我自己的笔记\n- 保留\n";
        let next = render(text, &Profile { style: vec!["新的".into()], about: vec!["上课".into()] });
        assert_eq!(next, "前言\n\n## 说话风格\n- 新的\n说明文字\n\n## 我自己的笔记\n- 保留\n\n## 我说过的\n- 上课\n");
        assert_eq!(parse(&next).style, vec!["新的"]);
    }

    #[test]
    fn a_new_profile_gets_a_title_and_both_sections() {
        let text = render("", &Profile { style: vec!["温柔一点".into()], about: vec![] });
        assert_eq!(text, "# bebe 偏好\n\n## 说话风格\n- 温柔一点\n\n## 我说过的\n");
        assert_eq!(parse(&text), Profile { style: vec!["温柔一点".into()], about: vec![] });
    }

    #[test]
    fn items_are_trimmed_deduplicated_and_limited() {
        assert_eq!(clean_items(&[" a ".into(), "a".into(), "".into(), "b".into()]).unwrap(), vec!["a", "b"]);
        assert!(clean_items(&["字".repeat(MAX_ITEM_CHARS + 1)]).is_err());
    }

    #[test]
    fn settings_are_checked() {
        assert!(validate(&PetSettings::default()).is_ok());
        assert!(validate(&PetSettings { slack_window_minutes: 2, ..PetSettings::default() }).is_err());
        assert!(validate(&PetSettings { summary_lead_minutes: 0, ..PetSettings::default() }).is_err());
        let quiet = |days: Vec<Weekday>, start: &str, end: &str| PetSettings {
            quiet_hours: vec![QuietHours { days, start: start.into(), end: end.into() }],
            ..PetSettings::default()
        };
        assert!(validate(&quiet(vec![Weekday::Wed], "14:00", "16:00")).is_ok());
        assert!(validate(&quiet(vec![Weekday::Fri, Weekday::Sat], "23:00", "01:30")).is_ok());
        assert!(validate(&quiet(vec![], "14:00", "16:00")).is_err());
        assert!(validate(&quiet(vec![Weekday::Wed, Weekday::Wed], "14:00", "16:00")).is_err());
        assert!(validate(&quiet(vec![Weekday::Wed], "14:00", "14:00")).is_err());
        assert!(validate(&quiet(vec![Weekday::Wed], "9:00", "16:00")).is_err());
        assert!(validate(&quiet(vec![Weekday::Wed], "24:00", "16:00")).is_err());
    }

    #[test]
    fn old_settings_without_pet_get_the_defaults() {
        let pet: PetSettings = serde_json::from_str(r#"{"slackWindowMinutes": 15}"#).unwrap();
        assert_eq!(pet.slack_window_minutes, 15);
        assert_eq!(pet.slack_cooldown_minutes, 30);
    }

    #[test]
    fn the_prompt_shows_settings_plan_and_preferences() {
        let mut settings = super::super::default_settings();
        settings.pet.quiet_hours = vec![QuietHours { days: vec![Weekday::Fri, Weekday::Mon], start: "14:00".into(), end: "16:00".into() }];
        let now = Local.with_ymd_and_hms(2026, 11, 12, 15, 0, 0).unwrap().timestamp_millis();
        let plan = PetPlan {
            snooze_until: Some(now + 30 * 60_000),
            reminders: vec![OneOffReminder { id: "r1".into(), at: now + 20 * 60_000, text: "喝水".into() }],
        };
        let profile = Profile { style: vec!["少用感叹号".into()], about: vec![] };
        let text = prompt_section(&settings, &profile, &plan, now);
        assert!(text.contains("more than 60% of the last 10 min"));
        // Sleep starts at 23:00 by default.
        assert!(text.contains("at 22:30"));
        assert!(text.contains("周一、周五 14:00–16:00"));
        assert!(text.contains("paused until 11-12 15:30"));
        assert!(text.contains("- id `r1`: 11-12 15:20 喝水"));
        assert!(text.contains("- 少用感叹号"));
        let expired = PetPlan { snooze_until: Some(now - 1), reminders: vec![] };
        assert!(prompt_section(&settings, &profile, &expired, now).contains("not paused"));
    }
}
