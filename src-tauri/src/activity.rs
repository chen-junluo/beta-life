//! Activity capture (P3a): the app and window in front, the domain of the Edge / Chrome tab in
//! front, and when the user is away.
//!
//! The design follows ActivityWatch (`aw-watcher-window`, `aw-watcher-afk`, `aw-server-rust`
//! heartbeats), with our own changes for its known macOS problems: window titles come from the
//! Accessibility API in-process (no polled osascript), sleep / lock / idle cut the open session
//! instead of being bridged into it, and private browser windows are never recorded.
//!
//! Storage: closed segments are appended to `pet/sessions/YYYY-MM-DD.jsonl` (local days, split at
//! midnight); the open one is mirrored to `pet/sessions/open.json` so a crash loses one sample.
//! Reading merges segments of the same activity separated by less than `MERGE_GAP_MS`.

use super::vault;
use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

/// How often the frontmost app, title and idle time are read.
#[cfg(target_os = "macos")]
const SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// No input for this long counts as away; the session then ends at the last input.
#[cfg(target_os = "macos")]
const AWAY_AFTER_SECS: f64 = 300.0;
/// A longer gap between two samples means the Mac slept or the app stalled: cut, never bridge.
const SLEEP_GAP_MS: i64 = 20_000;
/// When reading, segments of the same activity closer than this become one session.
const MERGE_GAP_MS: i64 = 30_000;
const MIN_SESSION_MS: i64 = 1_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Session {
    /// Unix milliseconds.
    start: i64,
    end: i64,
    app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bundle_id: Option<String>,
    /// Empty when Accessibility is not granted or the browser check could not run.
    #[serde(default)]
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
}

impl Session {
    fn same_activity(&self, other: &Session) -> bool {
        self.app == other.app && self.bundle_id == other.bundle_id && self.title == other.title && self.domain == other.domain
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Activity {
    app: String,
    bundle_id: Option<String>,
    title: String,
    domain: Option<String>,
}

impl Activity {
    fn session(self, at: i64) -> Session {
        Session { start: at, end: at, app: self.app, bundle_id: self.bundle_id, title: self.title, domain: self.domain }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Sample {
    Active(Activity),
    /// Idle, locked, or the login window is in front; away since `since` (Unix ms).
    Away { since: i64 },
    /// Nothing may be recorded now: a private browser window, or its check has not finished.
    Hidden,
}

/// Turns samples into sessions, like ActivityWatch heartbeats with a pulsetime of one sample.
#[derive(Debug, Default)]
pub(crate) struct Tracker {
    open: Option<Session>,
    last_sample: Option<i64>,
}

impl Tracker {
    /// Feeds one sample and returns the sessions it closed (shorter than a second are dropped).
    pub(crate) fn observe(&mut self, now: i64, sample: Sample) -> Vec<Session> {
        let mut closed = Vec::new();
        if let Some(last) = self.last_sample {
            if now < last || now - last > SLEEP_GAP_MS {
                // Slept or the clock jumped: the open session ended at the last sample we saw.
                closed.extend(self.open.take());
            }
        }
        self.last_sample = Some(now);
        match sample {
            Sample::Active(activity) => {
                let next = activity.session(now);
                match self.open.as_mut() {
                    Some(open) if open.same_activity(&next) => open.end = now,
                    _ => {
                        if let Some(mut open) = self.open.take() {
                            open.end = now;
                            closed.push(open);
                        }
                        self.open = Some(next);
                    }
                }
            }
            Sample::Away { since } => {
                if let Some(mut open) = self.open.take() {
                    open.end = since.clamp(open.start, now);
                    closed.push(open);
                }
            }
            Sample::Hidden => {
                if let Some(mut open) = self.open.take() {
                    open.end = now;
                    closed.push(open);
                }
            }
        }
        closed.retain(|session| session.end - session.start >= MIN_SESSION_MS);
        closed
    }

    pub(crate) fn open(&self) -> Option<&Session> {
        self.open.as_ref()
    }
}

fn local_day<Tz: TimeZone>(ms: i64, tz: &Tz) -> Option<NaiveDate> {
    tz.timestamp_millis_opt(ms).single().map(|time| time.date_naive())
}

/// Splits a session at local midnights so every part belongs to one day file.
fn split_by_day<Tz: TimeZone>(session: Session, tz: &Tz) -> Vec<(NaiveDate, Session)> {
    let mut parts = Vec::new();
    let mut rest = session;
    while let Some(day) = local_day(rest.start, tz) {
        let midnight = day
            .succ_opt()
            .and_then(|next| next.and_hms_opt(0, 0, 0))
            .and_then(|naive| tz.from_local_datetime(&naive).earliest())
            .map(|time| time.timestamp_millis())
            .filter(|&ms| ms > rest.start);
        match midnight {
            Some(midnight) if rest.end > midnight => {
                parts.push((day, Session { end: midnight, ..rest.clone() }));
                rest.start = midnight;
            }
            _ => {
                parts.push((day, rest));
                break;
            }
        }
    }
    parts
}

/// Sorted by start; neighbours of the same activity closer than `MERGE_GAP_MS` are joined.
fn merge_sessions(mut sessions: Vec<Session>) -> Vec<Session> {
    sessions.sort_by_key(|session| session.start);
    let mut merged: Vec<Session> = Vec::with_capacity(sessions.len());
    for session in sessions {
        match merged.last_mut() {
            Some(last) if last.same_activity(&session) && session.start - last.end < MERGE_GAP_MS => {
                last.end = last.end.max(session.end);
            }
            _ => merged.push(session),
        }
    }
    merged
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = vault::location::root(app)?.join(vault::TIMELINE).join(vault::META).join("sessions");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建活动记录目录：{error}"))?;
    Ok(directory)
}

fn day_path(dir: &Path, day: NaiveDate) -> PathBuf {
    dir.join(format!("{}.jsonl", day.format("%Y-%m-%d")))
}

fn append_sessions(dir: &Path, sessions: Vec<Session>) -> Result<(), String> {
    let mut by_day: BTreeMap<NaiveDate, String> = BTreeMap::new();
    for (day, part) in sessions.into_iter().flat_map(|session| split_by_day(session, &Local)) {
        let line = serde_json::to_string(&part).map_err(|error| error.to_string())?;
        let text = by_day.entry(day).or_default();
        text.push_str(&line);
        text.push('\n');
    }
    for (day, text) in by_day {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(day_path(dir, day))
            .map_err(|error| format!("无法写入活动记录：{error}"))?;
        file.write_all(text.as_bytes()).map_err(|error| format!("无法写入活动记录：{error}"))?;
    }
    Ok(())
}

/// Reads one day; a torn last line (crash mid-write) is skipped rather than failing the day.
fn read_day(dir: &Path, day: NaiveDate) -> Vec<Session> {
    fs::read_to_string(day_path(dir, day))
        .map(|text| text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
        .unwrap_or_default()
}

fn open_path(dir: &Path) -> PathBuf {
    dir.join("open.json")
}

/// The open session of the previous run (crash or quit) is closed as it was last mirrored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn recover_open(dir: &Path) {
    let path = open_path(dir);
    let Ok(bytes) = fs::read(&path) else { return };
    if let Ok(session) = serde_json::from_slice::<Session>(&bytes) {
        if session.end - session.start >= MIN_SESSION_MS {
            if let Err(error) = append_sessions(dir, vec![session]) {
                eprintln!("activity: {error}");
            }
        }
    }
    let _ = fs::remove_file(path);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mirror_open(dir: &Path, open: Option<&Session>) {
    let path = open_path(dir);
    match open {
        Some(session) => {
            if let Ok(bytes) = serde_json::to_vec(session) {
                let temporary = path.with_extension("json.tmp");
                if fs::write(&temporary, bytes).is_ok() {
                    let _ = fs::rename(temporary, path);
                }
            }
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

// ---------- Browsers ----------

const BROWSERS: [(&str, &str); 2] = [("com.microsoft.edgemac", "Microsoft Edge"), ("com.google.Chrome", "Google Chrome")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BrowserAccess {
    Unknown,
    Granted,
    Denied,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Lookup {
    Private,
    /// The front tab's domain; `None` for pages without one (new tab, `edge://`, `file://`).
    Page(Option<String>),
    /// The browser could not be asked (Automation denied, timeout); private windows cannot be told apart.
    Failed { denied: bool },
}

/// Host of an http(s) URL without `www.`; other schemes have no domain.
fn domain_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = if host.starts_with('[') { host.split(']').next()?.trim_start_matches('[') } else { host.split(':').next()? };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

/// Asks the browser for its front window's mode and active tab URL. The bundle id must be a
/// literal in the script: AppleScript resolves Chromium terms such as `active tab` at compile
/// time, so `tell application id <variable>` does not compile and no Apple Event is ever sent.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn browser_script(bundle: &str) -> String {
    format!(
        r#"tell application id "{bundle}"
  if (count of windows) is 0 then return "none"
  set w to window 1
  set m to "normal"
  try
    set m to (mode of w) as text
  end try
  return m & linefeed & (URL of active tab of w)
end tell"#
    )
}

/// Reply of `browser_script`: "none", or the window mode and the active tab's URL on two lines.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_browser_reply(reply: &str) -> Lookup {
    let reply = reply.trim();
    if reply == "none" {
        return Lookup::Page(None);
    }
    let mut lines = reply.lines();
    let mode = lines.next().unwrap_or_default().trim();
    if mode != "normal" {
        return Lookup::Private;
    }
    Lookup::Page(lines.next().and_then(|url| domain_of(url.trim())))
}

/// Window titles that announce a private window (a second guard besides the browser's own mode).
fn looks_private(title: &str) -> bool {
    ["InPrivate", "Incognito", "无痕", "隐身"].iter().any(|marker| title.contains(marker))
}

#[derive(Default)]
pub struct ActivityState {
    open: Mutex<Option<Session>>,
    browsers: Mutex<BTreeMap<&'static str, BrowserAccess>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
    };
    use objc2_app_kit::NSWorkspace;
    use std::ptr;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }

    /// Name, bundle id and pid of the frontmost app. Needs no permission.
    pub fn frontmost() -> Option<(String, Option<String>, i32)> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let bundle = app.bundleIdentifier().map(|id| id.to_string());
        let name = app.localizedName().map(|name| name.to_string()).or_else(|| bundle.clone()).unwrap_or_else(|| "未知应用".into());
        Some((name, bundle, app.processIdentifier()))
    }

    fn copy_attribute(element: &CFType, name: &'static str) -> Option<CFType> {
        let attribute = CFString::from_static_string(name);
        let mut value: CFTypeRef = ptr::null();
        let status = unsafe { AXUIElementCopyAttributeValue(element.as_CFTypeRef(), attribute.as_concrete_TypeRef(), &mut value) };
        (status == 0 && !value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }

    /// Title of the app's focused window; `None` without Accessibility or when it has no window.
    pub fn window_title(pid: i32) -> Option<String> {
        let element = unsafe { AXUIElementCreateApplication(pid) };
        if element.is_null() {
            return None;
        }
        let app = unsafe { CFType::wrap_under_create_rule(element) };
        // A hung app must not stall sampling (the default timeout is 6s).
        unsafe { AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 0.5) };
        let window = copy_attribute(&app, "AXFocusedWindow")?;
        copy_attribute(&window, "AXTitle")?.downcast_into::<CFString>().map(|title| title.to_string())
    }

    /// Seconds since the last keyboard, mouse or trackpad input. Needs no permission.
    pub fn idle_seconds() -> f64 {
        // kCGEventSourceStateHIDSystemState = 1, kCGAnyInputEventType = ~0
        unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) }
    }

    /// The screen is locked or this user's session is not on the console (fast user switching).
    pub fn screen_unavailable() -> bool {
        let raw = unsafe { CGSessionCopyCurrentDictionary() };
        if raw.is_null() {
            return true;
        }
        let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
        let flag = |key: &'static str| session.find(CFString::from_static_string(key)).and_then(|value| value.downcast::<CFBoolean>()).map(bool::from);
        flag("CGSSessionScreenIsLocked").unwrap_or(false) || !flag("kCGSSessionOnConsoleKey").unwrap_or(true)
    }

    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Shows the system prompt and adds beta-life to the Accessibility list (unchecked).
    pub fn prompt_accessibility() -> bool {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
    }
}

#[cfg(target_os = "macos")]
mod sampler {
    use super::*;
    use std::{
        process::{Command, Stdio},
        sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    /// Apps that mean nobody is working: the lock / login window and the screen saver.
    const AWAY_BUNDLES: [&str; 2] = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"];
    /// Wait this long for the answer before skipping the sample; the lookup keeps running.
    const LOOKUP_WAIT: Duration = Duration::from_millis(1500);
    /// An unanswered Automation prompt keeps osascript waiting; give up eventually.
    const LOOKUP_LIMIT: Duration = Duration::from_secs(120);
    const UNTITLED_REFRESH_MS: i64 = 30_000;

    fn now_ms() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis() as i64).unwrap_or_default()
    }

    fn ask_browser(bundle: &str) -> Lookup {
        let child = Command::new("/usr/bin/osascript")
            .args(["-e", &browser_script(bundle)])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let Ok(mut child) = child else { return Lookup::Failed { denied: false } };
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < LOOKUP_LIMIT => thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Lookup::Failed { denied: false };
                }
            }
        }
        match child.wait_with_output() {
            Ok(output) if output.status.success() => parse_browser_reply(&String::from_utf8_lossy(&output.stdout)),
            // -1743: the user has not allowed beta-life to control this browser.
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let denied = stderr.contains("-1743");
                if !denied {
                    eprintln!("activity: {bundle} lookup failed: {}", stderr.trim());
                }
                Lookup::Failed { denied }
            }
            Err(_) => Lookup::Failed { denied: false },
        }
    }

    struct Pending {
        bundle: String,
        title: String,
        reply: Receiver<Lookup>,
    }

    /// Browser lookups: at most one osascript at a time, results reused per window title.
    #[derive(Default)]
    struct BrowserProbe {
        last: Option<(String, String, i64, Lookup)>,
        pending: Option<Pending>,
    }

    impl BrowserProbe {
        fn check(&mut self, bundle: &str, title: &str, now: i64, state: &ActivityState) -> Option<Lookup> {
            if let Some(pending) = &self.pending {
                match pending.reply.try_recv() {
                    Ok(lookup) => {
                        let Pending { bundle, title, .. } = self.pending.take().unwrap();
                        self.finish(bundle, title, now, lookup, state);
                    }
                    Err(TryRecvError::Empty) => return None,
                    Err(TryRecvError::Disconnected) => self.pending = None,
                }
            }
            if let Some((last_bundle, last_title, at, lookup)) = &self.last {
                if last_bundle == bundle && last_title == title && (!title.is_empty() || now - at < UNTITLED_REFRESH_MS) {
                    return Some(lookup.clone());
                }
            }
            let (send, reply) = mpsc::channel();
            let target = bundle.to_string();
            thread::spawn(move || {
                let _ = send.send(ask_browser(&target));
            });
            match reply.recv_timeout(LOOKUP_WAIT) {
                Ok(lookup) => {
                    self.finish(bundle.to_string(), title.to_string(), now, lookup.clone(), state);
                    Some(lookup)
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.pending = Some(Pending { bundle: bundle.to_string(), title: title.to_string(), reply });
                    None
                }
                Err(RecvTimeoutError::Disconnected) => Some(Lookup::Failed { denied: false }),
            }
        }

        fn finish(&mut self, bundle: String, title: String, now: i64, lookup: Lookup, state: &ActivityState) {
            if let Some(&(id, _)) = BROWSERS.iter().find(|(id, _)| *id == bundle) {
                let access = match lookup {
                    Lookup::Failed { denied: true } => Some(BrowserAccess::Denied),
                    Lookup::Failed { denied: false } => None,
                    _ => Some(BrowserAccess::Granted),
                };
                if let Some(access) = access {
                    lock(&state.browsers).insert(id, access);
                }
            }
            self.last = Some((bundle, title, now, lookup));
        }
    }

    fn sample(now: i64, probe: &mut BrowserProbe, state: &ActivityState) -> Sample {
        if mac::screen_unavailable() {
            return Sample::Away { since: now };
        }
        let idle = mac::idle_seconds();
        if idle >= AWAY_AFTER_SECS {
            return Sample::Away { since: now - (idle * 1000.0) as i64 };
        }
        let Some((app, bundle_id, pid)) = mac::frontmost() else { return Sample::Away { since: now } };
        if bundle_id.as_deref().is_some_and(|id| AWAY_BUNDLES.contains(&id)) {
            return Sample::Away { since: now };
        }
        let mut title = mac::window_title(pid).unwrap_or_default();
        let mut domain = None;
        if let Some(bundle) = bundle_id.as_deref().filter(|id| BROWSERS.iter().any(|(browser, _)| browser == id)) {
            if looks_private(&title) {
                return Sample::Hidden;
            }
            match probe.check(bundle, &title, now, state) {
                None | Some(Lookup::Private) => return Sample::Hidden,
                Some(Lookup::Page(found)) => domain = found,
                // Without an answer a private window cannot be told apart: keep the time, drop the title.
                Some(Lookup::Failed { .. }) => title.clear(),
            }
        }
        Sample::Active(Activity { app, bundle_id, title, domain })
    }

    pub fn spawn(app: AppHandle) {
        thread::spawn(move || {
            let dir = match sessions_dir(&app) {
                Ok(dir) => dir,
                Err(error) => return eprintln!("activity: {error}"),
            };
            recover_open(&dir);
            let state = app.state::<ActivityState>();
            let mut tracker = Tracker::default();
            let mut probe = BrowserProbe::default();
            loop {
                let now = now_ms();
                let sample = objc2::rc::autoreleasepool(|_| sample(now, &mut probe, &state));
                let closed = tracker.observe(now, sample);
                if !closed.is_empty() {
                    if let Err(error) = append_sessions(&dir, closed) {
                        eprintln!("activity: {error}");
                    }
                }
                mirror_open(&dir, tracker.open());
                *lock(&state.open) = tracker.open().cloned();
                thread::sleep(SAMPLE_INTERVAL);
            }
        });
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(ActivityState::default());
    #[cfg(target_os = "macos")]
    sampler::spawn(app.clone());
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatus {
    name: &'static str,
    access: BrowserAccess,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityStatus {
    /// Capture runs on macOS only for now.
    supported: bool,
    /// Window titles need Accessibility; without it only app names are recorded.
    accessibility: bool,
    browsers: Vec<BrowserStatus>,
}

#[tauri::command]
pub(crate) fn activity_status(state: State<'_, ActivityState>) -> ActivityStatus {
    let known = lock(&state.browsers);
    let browsers = BROWSERS
        .iter()
        .map(|(id, name)| BrowserStatus { name, access: known.get(id).copied().unwrap_or(BrowserAccess::Unknown) })
        .collect();
    #[cfg(target_os = "macos")]
    return ActivityStatus { supported: true, accessibility: mac::accessibility_trusted(), browsers };
    #[cfg(not(target_os = "macos"))]
    ActivityStatus { supported: false, accessibility: false, browsers }
}

/// Asks for Accessibility once (the system prompt adds beta-life to the list), then opens the pane.
#[tauri::command]
pub(crate) fn request_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if mac::prompt_accessibility() {
            return Ok(true);
        }
        open_privacy_pane("Privacy_Accessibility")?;
        Ok(false)
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前系统暂不支持活动记录".into())
}

#[tauri::command]
pub(crate) fn open_automation_settings() -> Result<(), String> {
    open_privacy_pane("Privacy_Automation")
}

fn open_privacy_pane(pane: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开系统设置：{error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err("当前系统暂不支持活动记录".into())
    }
}

/// Sessions of one local day (`YYYY-MM-DD`), merged, including the part of the open session.
#[tauri::command]
pub(crate) fn load_activity_day(app: AppHandle, state: State<'_, ActivityState>, date: String) -> Result<Vec<Session>, String> {
    let day = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())?;
    let mut sessions = read_day(&sessions_dir(&app)?, day);
    if let Some(open) = lock(&state.open).clone() {
        sessions.extend(split_by_day(open, &Local).into_iter().filter(|(part_day, _)| *part_day == day).map(|(_, part)| part));
    }
    sessions.retain(|session| session.end - session.start >= MIN_SESSION_MS);
    Ok(merge_sessions(sessions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn active(app: &str, title: &str) -> Sample {
        Sample::Active(Activity { app: app.into(), bundle_id: None, title: title.into(), domain: None })
    }

    fn session(start: i64, end: i64, app: &str, title: &str) -> Session {
        Session { start, end, app: app.into(), bundle_id: None, title: title.into(), domain: None }
    }

    #[test]
    fn samples_extend_one_session_and_a_switch_closes_it_at_the_switch() {
        let mut tracker = Tracker::default();
        assert!(tracker.observe(0, active("Code", "ai.rs")).is_empty());
        assert!(tracker.observe(5_000, active("Code", "ai.rs")).is_empty());
        let closed = tracker.observe(10_000, active("Edge", "GitHub"));
        assert_eq!(closed, vec![session(0, 10_000, "Code", "ai.rs")]);
        assert_eq!(tracker.open(), Some(&session(10_000, 10_000, "Edge", "GitHub")));
    }

    #[test]
    fn idle_ends_the_session_at_the_last_input_and_sleep_gaps_are_not_bridged() {
        let mut tracker = Tracker::default();
        for at in (0..=60_000).step_by(5_000) {
            tracker.observe(at, active("Code", "x"));
        }
        assert_eq!(tracker.observe(65_000, Sample::Away { since: 20_000 }), vec![session(0, 20_000, "Code", "x")]);
        assert!(tracker.open().is_none());

        tracker.observe(100_000, active("Code", "x"));
        tracker.observe(105_000, active("Code", "x"));
        // The lid was closed for an hour: the session ends at the last sample, a new one starts.
        assert_eq!(tracker.observe(3_705_000, active("Code", "x")), vec![session(100_000, 105_000, "Code", "x")]);
        assert_eq!(tracker.open().map(|open| open.start), Some(3_705_000));
    }

    #[test]
    fn hidden_samples_close_without_opening_and_tiny_segments_are_dropped() {
        let mut tracker = Tracker::default();
        tracker.observe(0, active("Edge", "news"));
        tracker.observe(5_000, active("Edge", "news"));
        assert_eq!(tracker.observe(10_000, Sample::Hidden), vec![session(0, 10_000, "Edge", "news")]);
        assert!(tracker.open().is_none());
        tracker.observe(15_000, active("Edge", "a"));
        assert!(tracker.observe(15_400, Sample::Hidden).is_empty());
    }

    #[test]
    fn sessions_split_at_local_midnight() {
        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let start = tz.with_ymd_and_hms(2026, 11, 10, 23, 50, 0).unwrap().timestamp_millis();
        let midnight = tz.with_ymd_and_hms(2026, 11, 11, 0, 0, 0).unwrap().timestamp_millis();
        let parts = split_by_day(session(start, midnight + 600_000, "Code", ""), &tz);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0.to_string(), "2026-11-10");
        assert_eq!((parts[0].1.start, parts[0].1.end), (start, midnight));
        assert_eq!(parts[1].0.to_string(), "2026-11-11");
        assert_eq!((parts[1].1.start, parts[1].1.end), (midnight, midnight + 600_000));
    }

    #[test]
    fn reading_merges_short_gaps_of_the_same_activity_only() {
        let merged = merge_sessions(vec![
            session(40_000, 60_000, "Code", "x"),
            session(0, 20_000, "Code", "x"),
            session(60_000, 70_000, "Edge", "y"),
            session(200_000, 210_000, "Edge", "y"),
        ]);
        assert_eq!(merged, vec![session(0, 60_000, "Code", "x"), session(60_000, 70_000, "Edge", "y"), session(200_000, 210_000, "Edge", "y")]);
    }

    #[test]
    fn day_files_round_trip_and_skip_a_torn_line() {
        let dir = std::env::temp_dir().join(format!("bl-activity-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let at = Local.with_ymd_and_hms(2026, 11, 10, 9, 0, 0).unwrap().timestamp_millis();
        append_sessions(&dir, vec![session(at, at + 60_000, "Code", "x")]).unwrap();
        let path = day_path(&dir, NaiveDate::from_ymd_opt(2026, 11, 10).unwrap());
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"start\":1,").unwrap();
        assert_eq!(read_day(&dir, NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()), vec![session(at, at + 60_000, "Code", "x")]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn browser_replies_become_domains_and_private_windows_are_recognised() {
        assert_eq!(parse_browser_reply("normal\nhttps://www.GitHub.com/chen-junluo?tab=1\n"), Lookup::Page(Some("github.com".into())));
        assert_eq!(parse_browser_reply("normal\nedge://newtab/"), Lookup::Page(None));
        assert_eq!(parse_browser_reply("incognito\nhttps://example.com"), Lookup::Private);
        assert_eq!(parse_browser_reply("none"), Lookup::Page(None));
        assert_eq!(domain_of("http://user:pw@localhost:1420/x"), Some("localhost".into()));
        assert_eq!(domain_of("https://[::1]:8080/"), Some("::1".into()));
        assert!(looks_private("新标签页 - InPrivate"));
        // Only fixed bundle ids from BROWSERS reach the script, as a literal.
        assert!(browser_script("com.microsoft.edgemac").starts_with("tell application id \"com.microsoft.edgemac\""));
        assert!(!looks_private("Pull requests · GitHub"));
    }

    /// Compiles the real script for every supported browser (needs them installed; no Apple Events are sent).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn browser_scripts_compile() {
        for (bundle, _) in BROWSERS {
            let out = std::env::temp_dir().join(format!("bl-browser-{}.scpt", std::process::id()));
            let status = std::process::Command::new("/usr/bin/osacompile").args(["-o", out.to_str().unwrap(), "-e", &browser_script(bundle)]).status().unwrap();
            let _ = fs::remove_file(out);
            assert!(status.success(), "{bundle} script does not compile");
        }
    }
}
