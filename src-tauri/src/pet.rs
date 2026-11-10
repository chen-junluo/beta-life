//! bebe desk pet window: tray menu, a remembered position, native dragging, click-through
//! for the transparent part of its fixed-size window, and when bebe makes way for the AI dock
//! (bebe and the dock are one assistant: never both in front).

use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
};

pub const PET_LABEL: &str = "pet";
const MAIN_LABEL: &str = "main";
/// Logical gap between bebe and the screen corner on first launch.
const SCREEN_MARGIN: f64 = 24.0;
const HIT_TEST_INTERVAL: Duration = Duration::from_millis(50);
const DRAG_POLL_INTERVAL: Duration = Duration::from_millis(30);

/// Logical offset of bebe's center from the pet window's bottom-right corner (see `pet.css`:
/// 10px right edge, 96x128 sprite on the bottom edge).
const SPRITE_CENTER_FROM_CORNER: (f64, f64) = (10.0 + 48.0, 64.0);
/// Pet page: `true` while bebe makes way for the dock.
const PRESENCE_EVENT: &str = "pet://presence";
/// Main page: `true` while the user hid bebe from the tray.
const USER_HIDDEN_EVENT: &str = "pet://user-hidden";
/// Main page: bebe was double-clicked, start a new conversation in the dock.
const SUMMON_DOCK_EVENT: &str = "pet://summon-dock";

/// Set while a native drag runs, so click-through never toggles under the cursor mid-drag.
static DRAGGING: AtomicBool = AtomicBool::new(false);

/// A clickable area (bebe or the bubble) in CSS px relative to the pet window's content.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct HitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
pub struct PetHitRegions(Mutex<Vec<HitRect>>);

/// What the main window reports; Rust alone decides whether bebe makes way.
#[derive(Debug, Default, Clone, Copy)]
struct Presence {
    main_focused: bool,
    /// Shown in any form (composer, expanded, or the AI workbench); false once minimized into bebe.
    dock_visible: bool,
}

#[derive(Default)]
pub struct PetPresence(Mutex<Presence>);

/// bebe is the dock: while beta-life is in front showing the dock, bebe steps aside. A tray hide
/// is a real window hide and wins over this.
fn makes_way(presence: Presence) -> bool {
    presence.main_focused && presence.dock_visible
}

/// A physical screen point in logical px relative to a window whose content starts at `origin`.
fn point_in_window(point: (f64, f64), origin: (f64, f64), scale: f64) -> (f64, f64) {
    ((point.0 - origin.0) / scale, (point.1 - origin.1) / scale)
}

/// Whether a cursor at `cursor` (physical screen px) is over a region of a window whose content
/// starts at `origin` (physical screen px).
fn cursor_hits(regions: &[HitRect], cursor: (f64, f64), origin: (f64, f64), scale: f64) -> bool {
    let (x, y) = ((cursor.0 - origin.0) / scale, (cursor.1 - origin.1) / scale);
    regions
        .iter()
        .any(|rect| x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
}

/// Bottom-right corner of the pet window in physical pixels. Storing the corner instead of the
/// top-left keeps bebe in place whether the window was saved with or without a bubble open.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetAnchor {
    right: i32,
    bottom: i32,
}

fn anchor_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = super::app_data_dir(app)?.join("pet");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 pet 数据目录：{error}"))?;
    Ok(dir.join("window.json"))
}

/// Top-left position that keeps `anchor` fixed for a window of `size`.
fn top_left_for(anchor: PetAnchor, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    PhysicalPosition::new(anchor.right - size.width as i32, anchor.bottom - size.height as i32)
}

fn current_anchor(window: &WebviewWindow) -> tauri::Result<PetAnchor> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(PetAnchor {
        right: position.x + size.width as i32,
        bottom: position.y + size.height as i32,
    })
}

fn anchor_is_on_screen(window: &WebviewWindow, anchor: PetAnchor) -> bool {
    window.available_monitors().unwrap_or_default().iter().any(|monitor| {
        let area = monitor.work_area();
        let (left, top) = (area.position.x, area.position.y);
        let (right, bottom) = (left + area.size.width as i32, top + area.size.height as i32);
        anchor.right > left && anchor.right <= right && anchor.bottom > top && anchor.bottom <= bottom
    })
}

fn default_anchor(window: &WebviewWindow) -> Option<PetAnchor> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let margin = (SCREEN_MARGIN * monitor.scale_factor()).round() as i32;
    Some(PetAnchor {
        right: area.position.x + area.size.width as i32 - margin,
        bottom: area.position.y + area.size.height as i32 - margin,
    })
}

/// Place the pet at its saved corner (or the primary screen's bottom-right) and show it.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let saved = anchor_path(app)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|contents| serde_json::from_str::<PetAnchor>(&contents).ok())
            .filter(|anchor| anchor_is_on_screen(&window, *anchor));
        if let Some(anchor) = saved.or_else(|| default_anchor(&window)) {
            window.set_position(top_left_for(anchor, window.outer_size()?))?;
        }
        window.show()?;
        app.manage(PetHitRegions::default());
        app.manage(PetPresence::default());
        spawn_click_through(app.clone());
    }
    build_tray(app)
}

/// The window stays at bubble size so showing or hiding the bubble never resizes it (resizing
/// flashed a frame). Instead, poll the cursor and only accept mouse events over bebe or the bubble.
fn spawn_click_through(app: AppHandle) {
    thread::spawn(move || {
        let mut ignoring = None;
        loop {
            thread::sleep(HIT_TEST_INTERVAL);
            let Some(window) = app.get_webview_window(PET_LABEL) else { return };
            if DRAGGING.load(Ordering::Relaxed) {
                continue;
            }
            let (Ok(cursor), Ok(origin), Ok(scale)) =
                (window.cursor_position(), window.inner_position(), window.scale_factor())
            else {
                continue;
            };
            let hit = {
                let regions = app.state::<PetHitRegions>();
                let regions = regions.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                cursor_hits(&regions, (cursor.x, cursor.y), (origin.x as f64, origin.y as f64), scale)
            };
            if ignoring != Some(!hit) && window.set_ignore_cursor_events(!hit).is_ok() {
                ignoring = Some(!hit);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn left_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    // kCGEventSourceStateCombinedSessionState = 0, kCGMouseButtonLeft = 0
    unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    // VK_LBUTTON = 0x01; the high bit is set while the button is held.
    unsafe { GetAsyncKeyState(0x01) < 0 }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn left_button_down() -> bool {
    false
}

pub fn save_anchor(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PET_LABEL) else { return };
    let (Ok(anchor), Ok(path)) = (current_anchor(&window), anchor_path(app)) else { return };
    if let Ok(contents) = serde_json::to_string(&anchor) {
        let _ = fs::write(path, contents);
    }
}

fn update_presence(app: &AppHandle, change: impl FnOnce(&mut Presence)) {
    let Some(state) = app.try_state::<PetPresence>() else { return };
    let (before, after) = {
        let mut presence = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = makes_way(*presence);
        change(&mut presence);
        (before, makes_way(*presence))
    };
    if before != after {
        let _ = app.emit_to(PET_LABEL, PRESENCE_EVENT, after);
    }
}

/// Called from the main window's focus events.
pub fn set_main_focused(app: &AppHandle, focused: bool) {
    update_presence(app, |presence| presence.main_focused = focused);
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 beta-life", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-pet", "显示 / 隐藏 bebe", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 beta-life", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("beta-life")
        .tooltip("beta-life")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "toggle-pet" => {
                if let Some(window) = app.get_webview_window(PET_LABEL) {
                    let hide = window.is_visible().unwrap_or(false);
                    let _ = if hide { window.hide() } else { window.show() };
                    let _ = app.emit_to(MAIN_LABEL, USER_HIDDEN_EVENT, hide);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// The main window reports whether the dock is shown. Focus is re-read here too, so a missed
/// focus event (e.g. at launch) cannot leave bebe and the dock in front together.
#[tauri::command]
pub fn set_dock_visible(app: AppHandle, visible: bool) {
    let focused = app.get_webview_window(MAIN_LABEL).and_then(|window| window.is_focused().ok());
    update_presence(&app, |presence| {
        presence.dock_visible = visible;
        if let Some(focused) = focused {
            presence.main_focused = focused;
        }
    });
}

/// Pet page asks on load whether bebe should currently make way.
#[tauri::command]
pub fn pet_makes_way(state: State<'_, PetPresence>) -> bool {
    makes_way(*state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

/// Main page asks on load whether the user hid bebe from the tray.
#[tauri::command]
pub fn pet_hidden_by_user(app: AppHandle) -> bool {
    app.get_webview_window(PET_LABEL)
        .map(|window| !window.is_visible().unwrap_or(true))
        .unwrap_or(true)
}

/// Where bebe's center is, in CSS px of the main window's content, for the dock's fly-away.
#[tauri::command]
pub fn pet_position_in_main(app: AppHandle) -> Option<(f64, f64)> {
    let pet = app.get_webview_window(PET_LABEL)?;
    let main = app.get_webview_window(MAIN_LABEL)?;
    let (position, size, pet_scale) = (pet.inner_position().ok()?, pet.inner_size().ok()?, pet.scale_factor().ok()?);
    let (origin, main_scale) = (main.inner_position().ok()?, main.scale_factor().ok()?);
    let center = (
        position.x as f64 + size.width as f64 - SPRITE_CENTER_FROM_CORNER.0 * pet_scale,
        position.y as f64 + size.height as f64 - SPRITE_CENTER_FROM_CORNER.1 * pet_scale,
    );
    Some(point_in_window(center, (origin.x as f64, origin.y as f64), main_scale))
}

/// Double-clicking bebe brings beta-life forward with a new conversation in the dock.
#[tauri::command]
pub fn summon_dock(app: AppHandle) {
    show_main(&app);
    let _ = app.emit_to(MAIN_LABEL, SUMMON_DOCK_EVENT, ());
}

/// The chat input needs keyboard focus; the pet window is created unfocused.
#[tauri::command]
pub fn focus_pet_window(window: WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_pet_hit_regions(regions: Vec<HitRect>, state: State<'_, PetHitRegions>) {
    *state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = regions;
}

/// Start a native window drag and resolve only when the left button is released. The OS drag
/// call returns immediately on macOS and Windows, so its return cannot mark the end of the drag.
#[tauri::command]
pub async fn drag_pet_window(window: WebviewWindow) -> Result<(), String> {
    DRAGGING.store(true, Ordering::Relaxed);
    let result = match window.start_dragging() {
        Ok(()) => tauri::async_runtime::spawn_blocking(|| {
            while left_button_down() {
                thread::sleep(DRAG_POLL_INTERVAL);
            }
        })
        .await
        .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    DRAGGING.store(false, Ordering::Relaxed);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resizing_keeps_the_bottom_right_corner_fixed() {
        let anchor = PetAnchor { right: 1400, bottom: 860 };
        assert_eq!(top_left_for(anchor, PhysicalSize::new(232, 276)), PhysicalPosition::new(1168, 584));
        assert_eq!(top_left_for(anchor, PhysicalSize::new(560, 600)), PhysicalPosition::new(840, 260));
    }

    #[test]
    fn hit_test_converts_physical_cursor_to_css_regions() {
        let regions = [HitRect { x: 174.0, y: 222.0, width: 96.0, height: 128.0 }];
        let origin = (1000.0, 500.0);
        // Retina: 2 physical px per CSS px.
        assert!(cursor_hits(&regions, (1000.0 + 200.0 * 2.0, 500.0 + 300.0 * 2.0), origin, 2.0));
        assert!(!cursor_hits(&regions, (1000.0 + 20.0 * 2.0, 500.0 + 20.0 * 2.0), origin, 2.0));
        assert!(!cursor_hits(&regions, (1000.0 + 270.0 * 2.0, 500.0 + 300.0 * 2.0), origin, 2.0));
        assert!(!cursor_hits(&[], (1400.0, 1100.0), origin, 2.0));
    }

    #[test]
    fn bebe_makes_way_whenever_the_dock_is_in_front() {
        let presence = |main_focused, dock_visible| Presence { main_focused, dock_visible };
        assert!(makes_way(presence(true, true)));
        assert!(!makes_way(presence(true, false)));
        assert!(!makes_way(presence(false, true)));
        assert!(!makes_way(presence(false, false)));
    }

    #[test]
    fn screen_point_converts_to_main_window_css_px() {
        // Retina main window whose content starts at (200, 100) physical px.
        assert_eq!(point_in_window((1400.0, 900.0), (200.0, 100.0), 2.0), (600.0, 400.0));
        // bebe on another screen to the left gives negative coordinates; the dock clamps them.
        assert_eq!(point_in_window((-300.0, 500.0), (200.0, 100.0), 1.0), (-500.0, 400.0));
    }

    #[test]
    fn anchor_round_trips_as_camel_case_json() {
        let anchor = PetAnchor { right: -20, bottom: 900 };
        let json = serde_json::to_string(&anchor).unwrap();
        assert_eq!(json, r#"{"right":-20,"bottom":900}"#);
        assert_eq!(serde_json::from_str::<PetAnchor>(&json).unwrap(), anchor);
    }
}
