//! bebe desk pet window: tray menu, bottom-right anchored resizing, and a remembered position.

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};

pub const PET_LABEL: &str = "pet";
const MAIN_LABEL: &str = "main";
/// Logical gap between bebe and the screen corner on first launch.
const SCREEN_MARGIN: f64 = 24.0;

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
    }
    build_tray(app)
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

/// Fit the window to the pet stage (CSS px) while keeping its bottom-right corner still.
#[tauri::command]
pub fn resize_pet_window(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32);
    if window.outer_size().map_err(|error| error.to_string())? == size {
        return Ok(());
    }
    let anchor = current_anchor(&window).map_err(|error| error.to_string())?;
    window.set_size(size).map_err(|error| error.to_string())?;
    window
        .set_position(top_left_for(anchor, size))
        .map_err(|error| error.to_string())
}

/// Shift the window by CSS px so the cursor lands on the drag sprite's grab point.
#[tauri::command]
pub fn move_pet_window_by(window: WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            position.x + (dx * scale).round() as i32,
            position.y + (dy * scale).round() as i32,
        ))
        .map_err(|error| error.to_string())
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
    fn anchor_round_trips_as_camel_case_json() {
        let anchor = PetAnchor { right: -20, bottom: 900 };
        let json = serde_json::to_string(&anchor).unwrap();
        assert_eq!(json, r#"{"right":-20,"bottom":900}"#);
        assert_eq!(serde_json::from_str::<PetAnchor>(&json).unwrap(), anchor);
    }
}
