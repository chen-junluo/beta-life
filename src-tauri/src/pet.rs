//! bebe desk pet window: tray menu, a remembered position, native dragging, and click-through
//! for the transparent part of its fixed-size window.

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
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
};

pub const PET_LABEL: &str = "pet";
const MAIN_LABEL: &str = "main";
/// Logical gap between bebe and the screen corner on first launch.
const SCREEN_MARGIN: f64 = 24.0;
const HIT_TEST_INTERVAL: Duration = Duration::from_millis(50);
const DRAG_POLL_INTERVAL: Duration = Duration::from_millis(30);

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
                    let _ = if window.is_visible().unwrap_or(false) { window.hide() } else { window.show() };
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
    fn anchor_round_trips_as_camel_case_json() {
        let anchor = PetAnchor { right: -20, bottom: 900 };
        let json = serde_json::to_string(&anchor).unwrap();
        assert_eq!(json, r#"{"right":-20,"bottom":900}"#);
        assert_eq!(serde_json::from_str::<PetAnchor>(&json).unwrap(), anchor);
    }
}
