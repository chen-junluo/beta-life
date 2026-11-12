//! Activity categories (P3b): every recorded session is focus, neutral or slack, decided by the
//! user's rules (app, browser domain, window-title keyword). Unknown activity stays unclassified
//! until the user picks a category; nothing is guessed.
//!
//! Compared with ActivityWatch's categories (regexes over app + title, a tree, an ever-growing
//! "Uncategorized"), rules here are exact app ids and domain suffixes the user picks with one
//! click, and the unclassified ones are surfaced to be asked about. Title keywords are the only
//! pattern rule and win over the rest, e.g. a bilibili lecture counted as focus.
//!
//! Rules live in `时间轴/.beta-life/categories.json` (synced with the data folder); the file is
//! created with common presets the first time it is read.

use super::{activity, pet, vault};
use chrono::{Duration, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

/// Emitted to every window after the rules change.
const RULES_CHANGED_EVENT: &str = "activity://rules-changed";
const RULES_FILE: &str = "categories.json";
/// Away or asleep longer than this ends a slack streak.
pub(crate) const STREAK_GAP_MS: i64 = 60_000;
/// A glance at another app shorter than this does not end a slack streak.
pub(crate) const STREAK_BLIP_MS: i64 = 30_000;

/// Serializes read-modify-write of the rules file (main window, Settings and bebe all write it).
static RULES_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Category {
    Focus,
    Neutral,
    Slack,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRule {
    /// Bundle id, or the app name when the app has none.
    key: String,
    name: String,
    category: Category,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DomainRule {
    /// Also covers its subdomains.
    domain: String,
    category: Category,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeywordRule {
    /// Matched case-insensitively anywhere in the window title.
    keyword: String,
    category: Category,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rules {
    #[serde(default)]
    apps: Vec<AppRule>,
    #[serde(default)]
    domains: Vec<DomainRule>,
    /// Checked in order, before domains and apps.
    #[serde(default)]
    keywords: Vec<KeywordRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TargetKind {
    App,
    Domain,
}

/// What classifying a session by hand sets a rule for: its domain for web pages, else its app.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    kind: TargetKind,
    key: String,
    label: String,
}

impl Target {
    pub(crate) fn label(&self) -> &str {
        &self.label
    }
}

const PRESET_APPS: [(&str, &str, Category); 31] = [
    ("com.dylanchen.beta-life", "beta-life", Category::Focus),
    ("com.microsoft.VSCode", "Visual Studio Code", Category::Focus),
    ("com.todesktop.230313mzl4w4u92", "Cursor", Category::Focus),
    ("com.apple.Terminal", "终端", Category::Focus),
    ("com.googlecode.iterm2", "iTerm2", Category::Focus),
    ("md.obsidian", "Obsidian", Category::Focus),
    ("org.zotero.zotero", "Zotero", Category::Focus),
    ("com.rstudio.desktop", "RStudio", Category::Focus),
    ("org.R-project.R", "R", Category::Focus),
    ("com.stata.stata18", "Stata", Category::Focus),
    ("com.microsoft.Word", "Microsoft Word", Category::Focus),
    ("com.microsoft.Excel", "Microsoft Excel", Category::Focus),
    ("com.microsoft.Powerpoint", "Microsoft PowerPoint", Category::Focus),
    ("com.apple.iWork.Pages", "Pages", Category::Focus),
    ("com.apple.iWork.Numbers", "Numbers", Category::Focus),
    ("com.openai.codex", "Codex", Category::Focus),
    ("com.apple.finder", "访达", Category::Neutral),
    ("com.apple.systempreferences", "系统设置", Category::Neutral),
    ("com.microsoft.edgemac", "Microsoft Edge", Category::Neutral),
    ("com.google.Chrome", "Google Chrome", Category::Neutral),
    ("com.apple.Safari", "Safari", Category::Neutral),
    ("com.tencent.xinWeChat", "微信", Category::Neutral),
    ("com.apple.mail", "邮件", Category::Neutral),
    ("com.netease.macmail", "网易邮箱大师", Category::Neutral),
    ("com.tencent.meeting", "腾讯会议", Category::Neutral),
    ("us.zoom.xos", "zoom.us", Category::Neutral),
    ("com.openai.chat", "ChatGPT", Category::Neutral),
    ("com.linguee.DeepLCopyTranslator", "DeepL", Category::Neutral),
    ("com.netease.163music", "网易云音乐", Category::Neutral),
    ("com.tencent.QQMusicMac", "QQ音乐", Category::Neutral),
    ("com.valvesoftware.steam", "Steam", Category::Slack),
];

const PRESET_DOMAINS: [(&str, Category); 30] = [
    ("bilibili.com", Category::Slack),
    ("xiaohongshu.com", Category::Slack),
    ("douyin.com", Category::Slack),
    ("weibo.com", Category::Slack),
    ("zhihu.com", Category::Slack),
    ("douban.com", Category::Slack),
    ("youtube.com", Category::Slack),
    ("x.com", Category::Slack),
    ("twitter.com", Category::Slack),
    ("reddit.com", Category::Slack),
    ("instagram.com", Category::Slack),
    ("tiktok.com", Category::Slack),
    ("netflix.com", Category::Slack),
    ("iqiyi.com", Category::Slack),
    ("youku.com", Category::Slack),
    ("v.qq.com", Category::Slack),
    ("hupu.com", Category::Slack),
    ("twitch.tv", Category::Slack),
    ("huya.com", Category::Slack),
    ("douyu.com", Category::Slack),
    ("github.com", Category::Focus),
    ("overleaf.com", Category::Focus),
    ("scholar.google.com", Category::Focus),
    ("arxiv.org", Category::Focus),
    ("ssrn.com", Category::Focus),
    ("nber.org", Category::Focus),
    ("jstor.org", Category::Focus),
    ("sciencedirect.com", Category::Focus),
    ("cnki.net", Category::Focus),
    ("stackoverflow.com", Category::Focus),
];

fn presets() -> Rules {
    Rules {
        apps: PRESET_APPS.iter().map(|&(key, name, category)| AppRule { key: key.into(), name: name.into(), category }).collect(),
        domains: PRESET_DOMAINS.iter().map(|&(domain, category)| DomainRule { domain: domain.into(), category }).collect(),
        keywords: Vec::new(),
    }
}

/// The site a domain belongs to: `m.bilibili.com` → `bilibili.com`, `news.bbc.co.uk` → `bbc.co.uk`.
fn base_domain(domain: &str) -> String {
    let labels: Vec<&str> = domain.split('.').collect();
    let n = labels.len();
    if n <= 2 || domain.parse::<IpAddr>().is_ok() {
        return domain.to_string();
    }
    let country_second_level = labels[n - 1].len() == 2 && ["com", "net", "org", "gov", "edu", "co", "ac"].contains(&labels[n - 2]);
    labels[n - if country_second_level { 3 } else { 2 }..].join(".")
}

/// A domain typed or pasted by the user: `https://www.Bilibili.com/video/x` → `bilibili.com`.
fn normalize_domain(input: &str) -> Option<String> {
    let text = input.trim().to_ascii_lowercase();
    let rest = text.split_once("://").map_or(text.as_str(), |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.split(':').next()?.trim_end_matches('.');
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty() && !host.contains(char::is_whitespace)).then(|| host.to_string())
}

impl Rules {
    fn keyword(&self, title: &str) -> Option<Category> {
        let title = title.to_lowercase();
        self.keywords.iter().find(|rule| title.contains(&rule.keyword.to_lowercase())).map(|rule| rule.category)
    }

    /// The most specific rule covering `domain`.
    fn domain_rule(&self, domain: &str) -> Option<&DomainRule> {
        self.domains
            .iter()
            .filter(|rule| domain == rule.domain || domain.strip_suffix(&rule.domain).is_some_and(|rest| rest.ends_with('.')))
            .max_by_key(|rule| rule.domain.len())
    }

    /// The rule target of a session and its category from that target alone (no keywords).
    pub(crate) fn target(&self, session: &activity::Session) -> (Target, Option<Category>) {
        if let Some(domain) = session.domain.as_deref() {
            return match self.domain_rule(domain) {
                Some(rule) => (Target { kind: TargetKind::Domain, key: rule.domain.clone(), label: rule.domain.clone() }, Some(rule.category)),
                None => {
                    let site = base_domain(domain);
                    (Target { kind: TargetKind::Domain, key: site.clone(), label: site }, None)
                }
            };
        }
        let key = session.bundle_id.clone().unwrap_or_else(|| session.app.clone());
        let category = self.apps.iter().find(|rule| rule.key == key).map(|rule| rule.category);
        (Target { kind: TargetKind::App, key, label: session.app.clone() }, category)
    }

    /// Keyword first, then the domain for web pages (a page without a domain rule stays
    /// unclassified even if its browser has one), then the app.
    pub(crate) fn classify(&self, session: &activity::Session) -> Option<Category> {
        self.keyword(&session.title).or_else(|| self.target(session).1)
    }

    /// Sets or (with `None`) removes the rule for one target.
    fn set(&mut self, kind: TargetKind, key: &str, name: &str, category: Option<Category>) {
        match kind {
            TargetKind::App => {
                self.apps.retain(|rule| rule.key != key);
                if let Some(category) = category {
                    self.apps.push(AppRule { key: key.into(), name: name.into(), category });
                }
            }
            TargetKind::Domain => {
                self.domains.retain(|rule| rule.domain != key);
                if let Some(category) = category {
                    self.domains.push(DomainRule { domain: key.into(), category });
                }
            }
        }
    }

    /// Trims, drops empty entries and keeps the last rule for a repeated key.
    fn normalized(self) -> Rules {
        fn dedupe<T>(items: Vec<T>, key: impl Fn(&T) -> String) -> Vec<T> {
            let mut seen = std::collections::HashSet::new();
            let mut kept: Vec<T> = items.into_iter().rev().filter(|item| seen.insert(key(item))).collect();
            kept.reverse();
            kept
        }
        let apps = self
            .apps
            .into_iter()
            .map(|rule| AppRule { key: rule.key.trim().into(), name: rule.name.trim().into(), category: rule.category })
            .filter(|rule| !rule.key.is_empty())
            .map(|rule| AppRule { name: if rule.name.is_empty() { rule.key.clone() } else { rule.name }, ..rule })
            .collect();
        let domains = self
            .domains
            .into_iter()
            .filter_map(|rule| normalize_domain(&rule.domain).map(|domain| DomainRule { domain, category: rule.category }))
            .collect();
        let keywords = self
            .keywords
            .into_iter()
            .map(|rule| KeywordRule { keyword: rule.keyword.trim().into(), category: rule.category })
            .filter(|rule| !rule.keyword.is_empty())
            .collect();
        Rules {
            apps: dedupe(apps, |rule: &AppRule| rule.key.clone()),
            domains: dedupe(domains, |rule: &DomainRule| rule.domain.clone()),
            keywords: dedupe(keywords, |rule: &KeywordRule| rule.keyword.to_lowercase()),
        }
    }
}

fn rules_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault::location::root(app)?.join(vault::TIMELINE).join(vault::META).join(RULES_FILE))
}

fn write_rules(path: &Path, rules: &Rules) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建分类规则目录：{error}"))?;
    }
    let text = serde_json::to_string_pretty(rules).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("无法保存分类规则：{error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("无法保存分类规则：{error}"))
}

/// Reads the rules; a missing file starts from the presets. A broken file is reported, never overwritten.
fn read_rules(path: &Path) -> Result<Rules, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("分类规则文件无法读取（{}）：{error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let rules = presets();
            write_rules(path, &rules)?;
            Ok(rules)
        }
        Err(error) => Err(format!("分类规则文件无法读取：{error}")),
    }
}

pub(crate) fn load(app: &AppHandle) -> Result<Rules, String> {
    let _guard = RULES_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read_rules(&rules_path(app)?)
}

fn update(app: &AppHandle, change: impl FnOnce(&mut Rules)) -> Result<Rules, String> {
    let rules = {
        let _guard = RULES_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = rules_path(app)?;
        let mut rules = read_rules(&path)?;
        change(&mut rules);
        let rules = rules.normalized();
        write_rules(&path, &rules)?;
        rules
    };
    let _ = app.emit(RULES_CHANGED_EVENT, ());
    Ok(rules)
}

// ---------- One day, classified ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassifiedSession {
    #[serde(flatten)]
    session: activity::Session,
    /// `None` while unclassified.
    category: Option<Category>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetState {
    #[serde(flatten)]
    target: Target,
    category: Option<Category>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityDay {
    sessions: Vec<ClassifiedSession>,
    /// By app name: the rule the app row edits (for browsers it covers pages without a domain).
    apps: BTreeMap<String, TargetState>,
    /// By recorded domain: the rule its row edits (an existing parent-domain rule, else the site).
    domains: BTreeMap<String, TargetState>,
}

fn classify_day(rules: &Rules, sessions: Vec<activity::Session>) -> ActivityDay {
    let mut apps = BTreeMap::new();
    let mut domains = BTreeMap::new();
    for session in &sessions {
        let (target, category) = rules.target(session);
        match session.domain.clone() {
            Some(domain) => {
                domains.entry(domain).or_insert(TargetState { target, category });
            }
            None => {
                apps.entry(session.app.clone()).or_insert(TargetState { target, category });
            }
        }
        // A browser row also needs its app rule when every page had a domain.
        if !apps.contains_key(&session.app) {
            let app_only = activity::Session { domain: None, ..session.clone() };
            let (target, category) = rules.target(&app_only);
            apps.insert(session.app.clone(), TargetState { target, category });
        }
    }
    let sessions = sessions.into_iter().map(|session| ClassifiedSession { category: rules.classify(&session), session }).collect();
    ActivityDay { sessions, apps, domains }
}

/// Sessions of one local day (`YYYY-MM-DD`) with their categories and the rule behind each row.
#[tauri::command]
pub(crate) fn load_activity_day(app: AppHandle, state: State<'_, activity::ActivityState>, date: String) -> Result<ActivityDay, String> {
    let day = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())?;
    let sessions = activity::day_sessions(&app, &state, day)?;
    Ok(classify_day(&load(&app)?, sessions))
}

#[tauri::command]
pub(crate) fn load_activity_rules(app: AppHandle) -> Result<Rules, String> {
    load(&app)
}

/// Settings replaces the whole rule set.
#[tauri::command]
pub(crate) fn save_activity_rules(app: AppHandle, rules: Rules) -> Result<Rules, String> {
    update(&app, |current| *current = rules)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetRuleRequest {
    kind: TargetKind,
    key: String,
    /// App name shown in Settings; ignored for domains.
    #[serde(default)]
    name: String,
    /// `None` makes the target unclassified again.
    category: Option<Category>,
}

/// One click in the timeline or in bebe's bubble.
#[tauri::command]
pub(crate) fn set_activity_rule(app: AppHandle, request: SetRuleRequest) -> Result<(), String> {
    let key = match request.kind {
        TargetKind::App => request.key.trim().to_string(),
        TargetKind::Domain => normalize_domain(&request.key).ok_or("域名不能为空")?,
    };
    if key.is_empty() {
        return Err("应用不能为空".into());
    }
    update(&app, |rules| rules.set(request.kind, &key, &request.name, request.category)).map(|_| ())
}

// ---------- bebe's pulse ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PulseRequest {
    /// Length of the recent window the slack share is measured over.
    window_ms: i64,
    /// Unclassified targets used at least this long today are offered to be asked about.
    ask_after_ms: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Current {
    label: String,
    category: Option<Category>,
    /// The rule to change from bebe's bubble; `None` when a title keyword decided the category.
    target: Option<Target>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    #[serde(flatten)]
    pub(crate) target: Target,
    pub(crate) today_ms: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pulse {
    /// The main window is focused: bebe holds its bubbles until the user leaves.
    in_beta_life: bool,
    /// What is in front now; `None` while away.
    current: Option<Current>,
    /// Slack time inside the recent window.
    recent_slack_ms: i64,
    /// Start of the slack streak that is still going on, if any.
    slack_since: Option<i64>,
    /// Unclassified targets used long enough today, longest first.
    candidates: Vec<Candidate>,
}

/// Time since `from` on each unclassified rule target, longest first.
pub(crate) fn unclassified_usage(rules: &Rules, classified: &[(&activity::Session, Option<Category>)], from: i64) -> Vec<Candidate> {
    let mut usage: HashMap<Target, i64> = HashMap::new();
    for (session, category) in classified {
        let spent = session.end - session.start.max(from);
        if category.is_none() && spent > 0 {
            *usage.entry(rules.target(session).0).or_default() += spent;
        }
    }
    let mut candidates: Vec<Candidate> = usage.into_iter().map(|(target, today_ms)| Candidate { target, today_ms }).collect();
    candidates.sort_by(|a, b| b.today_ms.cmp(&a.today_ms).then_with(|| a.target.key.cmp(&b.target.key)));
    candidates
}

pub(crate) fn session_label(session: &activity::Session) -> String {
    session.domain.clone().unwrap_or_else(|| session.app.clone())
}

/// `sessions` are sorted by start and include the open one; `today` starts at local midnight.
fn pulse_from(rules: &Rules, sessions: &[activity::Session], open: Option<&activity::Session>, now: i64, today: i64, request: &PulseRequest) -> Pulse {
    let classified: Vec<(&activity::Session, Option<Category>)> = sessions.iter().map(|session| (session, rules.classify(session))).collect();

    let from = now - request.window_ms;
    let recent_slack_ms = classified
        .iter()
        .filter(|(_, category)| *category == Some(Category::Slack))
        .map(|(session, _)| (session.end.min(now) - session.start.max(from)).max(0))
        .sum();

    let mut slack_since = None;
    let mut edge = now;
    for (session, category) in classified.iter().rev() {
        if edge - session.end > STREAK_GAP_MS {
            break;
        }
        if *category == Some(Category::Slack) {
            slack_since = Some(session.start);
        } else if slack_since.is_none() || session.end - session.start >= STREAK_BLIP_MS {
            break;
        }
        edge = session.start;
    }

    let mut candidates = unclassified_usage(rules, &classified, today);
    candidates.retain(|candidate| candidate.today_ms >= request.ask_after_ms);

    let current = open.map(|session| {
        let keyword = rules.keyword(&session.title);
        let (target, by_target) = rules.target(session);
        Current { label: session_label(session), category: keyword.or(by_target), target: keyword.is_none().then_some(target) }
    });
    Pulse { in_beta_life: false, current, recent_slack_ms, slack_since, candidates }
}

pub(crate) fn local_midnight(day: NaiveDate) -> i64 {
    day.and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .map(|time| time.timestamp_millis())
        .unwrap_or_default()
}

/// What bebe needs every tick to decide on slack reminders and on asking about new apps.
#[tauri::command]
pub(crate) fn activity_pulse(app: AppHandle, state: State<'_, activity::ActivityState>, request: PulseRequest) -> Result<Pulse, String> {
    let now = Local::now();
    let today = now.date_naive();
    let today_start = local_midnight(today);
    let now = now.timestamp_millis();
    let mut sessions = activity::day_sessions(&app, &state, today)?;
    if now - request.window_ms < today_start {
        let mut yesterday = activity::day_sessions(&app, &state, today - Duration::days(1))?;
        yesterday.append(&mut sessions);
        sessions = yesterday;
    }
    let open = activity::open_session(&state);
    let mut pulse = pulse_from(&load(&app)?, &sessions, open.as_ref(), now, today_start, &request);
    pulse.in_beta_life = pet::main_focused(&app);
    Ok(pulse)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(start: i64, end: i64, app: &str, bundle: Option<&str>, title: &str, domain: Option<&str>) -> activity::Session {
        activity::Session {
            start,
            end,
            app: app.into(),
            bundle_id: bundle.map(Into::into),
            title: title.into(),
            domain: domain.map(Into::into),
        }
    }

    fn rules() -> Rules {
        let mut rules = presets();
        rules.keywords.push(KeywordRule { keyword: "课程".into(), category: Category::Focus });
        rules
    }

    const MIN: i64 = 60_000;

    #[test]
    fn keywords_win_then_domains_by_suffix_then_apps() {
        let rules = rules();
        let edge = Some("com.microsoft.edgemac");
        assert_eq!(rules.classify(&session(0, 1, "Microsoft Edge", edge, "搞笑合集", Some("m.bilibili.com"))), Some(Category::Slack));
        assert_eq!(rules.classify(&session(0, 1, "Microsoft Edge", edge, "计量经济学课程 第3讲", Some("bilibili.com"))), Some(Category::Focus));
        // A page without a domain rule is unclassified even though Edge itself is neutral.
        assert_eq!(rules.classify(&session(0, 1, "Microsoft Edge", edge, "x", Some("news.example.co.uk"))), None);
        assert_eq!(rules.target(&session(0, 1, "Microsoft Edge", edge, "x", Some("news.example.co.uk"))).0.key, "example.co.uk");
        assert_eq!(rules.classify(&session(0, 1, "Microsoft Edge", edge, "新标签页", None)), Some(Category::Neutral));
        // `x.com` must not swallow `box.com`.
        assert_eq!(rules.classify(&session(0, 1, "Chrome", None, "", Some("box.com"))), None);
        assert_eq!(rules.classify(&session(0, 1, "Code", Some("com.microsoft.VSCode"), "ai.rs", None)), Some(Category::Focus));
        assert_eq!(rules.classify(&session(0, 1, "Unknown", None, "", None)), None);
    }

    #[test]
    fn the_most_specific_domain_rule_wins() {
        let mut rules = rules();
        rules.set(TargetKind::Domain, "live.bilibili.com", "", Some(Category::Neutral));
        assert_eq!(rules.classify(&session(0, 1, "Edge", None, "", Some("live.bilibili.com"))), Some(Category::Neutral));
        assert_eq!(rules.classify(&session(0, 1, "Edge", None, "", Some("www.bilibili.com"))), Some(Category::Slack));
    }

    #[test]
    fn domains_typed_by_the_user_are_normalized_and_rules_deduplicated() {
        assert_eq!(normalize_domain(" https://www.Bilibili.com/video/BV1?x=1 "), Some("bilibili.com".into()));
        assert_eq!(normalize_domain("localhost:1420"), Some("localhost".into()));
        assert_eq!(normalize_domain("  "), None);
        let rules = Rules {
            apps: vec![AppRule { key: " a ".into(), name: "".into(), category: Category::Focus }],
            domains: vec![
                DomainRule { domain: "zhihu.com".into(), category: Category::Slack },
                DomainRule { domain: "https://zhihu.com".into(), category: Category::Focus },
            ],
            keywords: vec![KeywordRule { keyword: " ".into(), category: Category::Focus }],
        }
        .normalized();
        assert_eq!(rules.apps, vec![AppRule { key: "a".into(), name: "a".into(), category: Category::Focus }]);
        assert_eq!(rules.domains, vec![DomainRule { domain: "zhihu.com".into(), category: Category::Focus }]);
        assert!(rules.keywords.is_empty());
    }

    #[test]
    fn a_missing_rules_file_starts_from_presets_and_a_broken_one_is_kept() {
        let dir = vault::test_root("categories");
        let path = dir.join(RULES_FILE);
        assert_eq!(read_rules(&path).unwrap(), presets());
        assert!(path.exists());
        fs::write(&path, "{ broken").unwrap();
        assert!(read_rules(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ broken");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn day_rows_know_which_rule_they_edit() {
        let rules = rules();
        let edge = Some("com.microsoft.edgemac");
        let day = classify_day(
            &rules,
            vec![session(0, MIN, "Microsoft Edge", edge, "a", Some("m.bilibili.com")), session(MIN, 2 * MIN, "Microsoft Edge", edge, "b", Some("news.ycombinator.com"))],
        );
        assert_eq!(day.domains["m.bilibili.com"].target.key, "bilibili.com");
        assert_eq!(day.domains["m.bilibili.com"].category, Some(Category::Slack));
        assert_eq!(day.domains["news.ycombinator.com"].target.key, "ycombinator.com");
        assert_eq!(day.domains["news.ycombinator.com"].category, None);
        assert_eq!(day.apps["Microsoft Edge"].target.key, "com.microsoft.edgemac");
        assert_eq!(day.apps["Microsoft Edge"].category, Some(Category::Neutral));
        assert_eq!(day.sessions[1].category, None);
    }

    fn request() -> PulseRequest {
        PulseRequest { window_ms: 10 * MIN, ask_after_ms: 3 * MIN }
    }

    #[test]
    fn a_slack_streak_survives_short_glances_but_not_real_work_or_being_away() {
        let rules = rules();
        let now = 100 * MIN;
        let bili = |start, end| session(start, end, "Edge", None, "", Some("bilibili.com"));
        let wechat = |start, end| session(start, end, "微信", Some("com.tencent.xinWeChat"), "", None);
        let code = |start, end| session(start, end, "Code", Some("com.microsoft.VSCode"), "", None);

        // 2 min of work, then slack with a 10-second WeChat glance in the middle.
        let sessions = [code(88 * MIN, 90 * MIN), bili(90 * MIN, 95 * MIN), wechat(95 * MIN, 95 * MIN + 10_000), bili(95 * MIN + 10_000, now - 2_000)];
        let pulse = pulse_from(&rules, &sessions, sessions.last(), now, 0, &request());
        assert_eq!(pulse.slack_since, Some(90 * MIN));
        assert_eq!(pulse.recent_slack_ms, 10 * MIN - 12_000);
        assert_eq!(pulse.current.as_ref().unwrap().category, Some(Category::Slack));

        // A longer stop at WeChat ends the streak.
        let sessions = [bili(80 * MIN, 90 * MIN), wechat(90 * MIN, 91 * MIN), bili(91 * MIN, now)];
        assert_eq!(pulse_from(&rules, &sessions, sessions.last(), now, 0, &request()).slack_since, Some(91 * MIN));

        // Back to work now: no streak.
        let sessions = [bili(80 * MIN, 99 * MIN), code(99 * MIN, now)];
        assert_eq!(pulse_from(&rules, &sessions, sessions.last(), now, 0, &request()).slack_since, None);

        // Away for two minutes (nothing open): no streak.
        let sessions = [bili(80 * MIN, 98 * MIN)];
        let pulse = pulse_from(&rules, &sessions, None, now, 0, &request());
        assert_eq!(pulse.slack_since, None);
        assert!(pulse.current.is_none());
    }

    #[test]
    fn unclassified_targets_used_long_enough_today_become_candidates() {
        let rules = rules();
        let today = 1_000 * MIN;
        let now = today + 60 * MIN;
        let sessions = [
            // Mostly yesterday: only the part after midnight counts.
            session(today - 10 * MIN, today + MIN, "Edge", None, "", Some("news.ycombinator.com")),
            session(today + 2 * MIN, today + 4 * MIN, "Edge", None, "", Some("ycombinator.com")),
            session(today + 10 * MIN, today + 12 * MIN, "Notion", Some("notion.id"), "", None),
            session(today + 20 * MIN, today + 50 * MIN, "Code", Some("com.microsoft.VSCode"), "", None),
            // A keyword classifies it, so it is not asked about.
            session(today + 50 * MIN, today + 59 * MIN, "Notion", Some("notion.id"), "课程笔记", None),
        ];
        let pulse = pulse_from(&rules, &sessions, None, now, today, &request());
        assert_eq!(
            pulse.candidates,
            vec![Candidate { target: Target { kind: TargetKind::Domain, key: "ycombinator.com".into(), label: "ycombinator.com".into() }, today_ms: 3 * MIN }]
        );
    }

    #[test]
    fn the_current_target_is_withheld_when_a_keyword_decided() {
        let rules = rules();
        let open = session(0, MIN, "Edge", None, "统计课程", Some("bilibili.com"));
        let pulse = pulse_from(&rules, std::slice::from_ref(&open), Some(&open), MIN, 0, &request());
        assert_eq!(pulse.current, Some(Current { label: "bilibili.com".into(), category: Some(Category::Focus), target: None }));
    }

    #[test]
    fn base_domains_keep_country_second_levels() {
        assert_eq!(base_domain("m.bilibili.com"), "bilibili.com");
        assert_eq!(base_domain("news.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(base_domain("a.b.example.com.cn"), "example.com.cn");
        assert_eq!(base_domain("localhost"), "localhost");
        assert_eq!(base_domain("192.168.1.10"), "192.168.1.10");
    }
}
