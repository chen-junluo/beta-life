//! Where the vault lives. `app_data_dir/data-location.json` (local, never synced) points at the
//! folder chosen in Settings; without it the vault is `app_data_dir` itself. Everything in the vault,
//! `.beta-life/` and `settings.json` included, can be synced; machine-specific files stay local.

use super::{copy_tree, lock, META};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const LOCATION_FILE: &str = "data-location.json";
/// Stay in `app_data_dir` when the data moves: window position, the pointer itself, the Windows key.
const LOCAL: [&str; 4] = ["pet", LOCATION_FILE, "api-key.dpapi", ".DS_Store"];

static ROOT: OnceLock<PathBuf> = OnceLock::new();
/// Set while the data moves: commands fail instead of writing into the old folder before the restart.
static SWITCHING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Location {
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataFolder {
    path: String,
    is_default: bool,
}

#[derive(Debug, PartialEq)]
enum Kind {
    Current,
    Empty,
    Vault,
    Other,
}

pub(crate) fn switching() -> bool {
    SWITCHING.load(Ordering::SeqCst)
}

/// The vault root, resolved once per run (a change restarts the app).
pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = ROOT.get() {
        return Ok(root.clone());
    }
    let root = resolve(&crate::app_data_dir(app)?)?;
    Ok(ROOT.get_or_init(|| root).clone())
}

fn resolve(local: &Path) -> Result<PathBuf, String> {
    let pointer = local.join(LOCATION_FILE);
    if !pointer.exists() {
        return Ok(local.to_path_buf());
    }
    let location: Location = crate::read_json(&pointer)?;
    if !location.path.is_dir() {
        return Err(format!(
            "找不到数据文件夹 {}。如果它在坚果云里，等同步完成后重启 beta-life；要改回默认位置，删除 {}",
            location.path.display(),
            pointer.display()
        ));
    }
    Ok(location.path)
}

pub(crate) fn settings_path(root: &Path) -> PathBuf {
    root.join(META).join("settings.json")
}

/// v1 kept `settings.json` in `app_data_dir`; it now lives in the vault so it syncs with the data.
pub(crate) fn adopt_local_settings(local: &Path, root: &Path) -> Result<(), String> {
    let old = local.join("settings.json");
    let new = settings_path(root);
    if !old.exists() || new.exists() {
        return Ok(());
    }
    fs::create_dir_all(new.parent().unwrap()).map_err(|error| format!("无法创建设置目录：{error}"))?;
    if fs::rename(&old, &new).is_err() {
        fs::copy(&old, &new).map_err(|error| format!("无法移动设置：{error}"))?;
        fs::remove_file(&old).map_err(|error| format!("无法移动设置：{error}"))?;
    }
    Ok(())
}

fn entries(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| !LOCAL.contains(&name.as_str()))
        .collect();
    names.sort();
    names
}

fn classify(target: &Path, current: &Path) -> Kind {
    if target == current {
        Kind::Current
    } else if target.join(META).join("vault.json").exists() {
        Kind::Vault
    } else if entries(target).is_empty() {
        Kind::Empty
    } else {
        Kind::Other
    }
}

/// Moves every vault entry from `from` into `to` (rename, or copy then delete across disks).
/// Any failure puts back what already moved.
fn move_vault(from: &Path, to: &Path) -> Result<(), String> {
    let names = entries(from);
    let mut renamed = Vec::new();
    let mut copied = Vec::new();
    let result = (|| {
        for name in &names {
            let (source, target) = (from.join(name), to.join(name));
            if fs::rename(&source, &target).is_ok() {
                renamed.push(name);
            } else {
                copy_tree(&source, &target)?;
                copied.push(name);
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        for name in renamed {
            let _ = fs::rename(to.join(name), from.join(name));
        }
        for name in copied {
            let _ = remove_any(&to.join(name));
        }
        return Err(error);
    }
    for name in copied {
        remove_any(&from.join(name))?;
    }
    Ok(())
}

fn remove_any(path: &Path) -> Result<(), String> {
    let result = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
    result.map_err(|error| format!("无法删除 {}：{error}", path.display()))
}

fn write_pointer(local: &Path, target: &Path) -> Result<(), String> {
    let pointer = local.join(LOCATION_FILE);
    if target == local {
        return match fs::remove_file(&pointer) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("无法恢复默认位置：{error}")),
            _ => Ok(()),
        };
    }
    crate::atomic_write(&pointer, &Location { path: target.to_path_buf() })
}

/// Switches to `target`: an empty folder receives the current data, a beta-life folder (synced from
/// another computer) is used as it is. Returns an error for any other folder.
fn switch(local: &Path, current: &Path, target: &Path, kind: &Kind) -> Result<(), String> {
    match kind {
        Kind::Empty => move_vault(current, target)?,
        Kind::Vault => {
            // A vault without settings (made before they moved into it) starts with this computer's.
            let settings = settings_path(target);
            if !settings.exists() && settings_path(current).exists() {
                fs::copy(settings_path(current), &settings).map_err(|error| format!("无法复制设置：{error}"))?;
            }
        }
        Kind::Current | Kind::Other => return Ok(()),
    }
    write_pointer(local, target)
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("无法访问 {}：{error}", path.display()))
}

#[tauri::command]
pub(crate) fn data_folder(app: AppHandle) -> Result<DataFolder, String> {
    let root = root(&app)?;
    Ok(DataFolder { is_default: root == crate::app_data_dir(&app)?, path: root.display().to_string() })
}

/// Picks a folder, confirms, moves or adopts the data, then restarts. `Ok(())` when cancelled.
/// Async so the blocking dialogs run off the main thread.
#[tauri::command]
pub(crate) async fn change_data_folder(app: AppHandle) -> Result<(), String> {
    let local = canonical(&crate::app_data_dir(&app)?)?;
    let current = canonical(&root(&app)?)?;
    let picked = app
        .dialog()
        .file()
        .set_title("选择数据文件夹")
        .set_directory(current.parent().unwrap_or(&current))
        .blocking_pick_folder();
    let Some(picked) = picked else { return Ok(()) };
    let target = canonical(&picked.into_path().map_err(|error| error.to_string())?)?;
    if target != current && (target.starts_with(&current) || current.starts_with(&target)) {
        return Err("不能选当前数据文件夹的子文件夹或上层文件夹".into());
    }
    let kind = classify(&target, &current);
    let (title, message, ok) = match kind {
        Kind::Current => return Err("这已经是当前的数据文件夹".into()),
        Kind::Other => return Err(format!("{} 里已经有其他文件。请选一个空文件夹，或者已有的 beta-life 数据文件夹", target.display())),
        Kind::Empty => (
            "把数据移到这个文件夹？",
            format!("beta-life 会把 {} 里的全部数据（包括 .beta-life 和设置）移到 {}，然后重启。窗口位置留在本机。", current.display(), target.display()),
            "移动并重启",
        ),
        Kind::Vault => (
            "改用这个文件夹里的数据？",
            format!("{} 已经是 beta-life 数据文件夹。beta-life 会改用里面的数据并重启；当前文件夹 {} 里的数据保持原样，不会合并。", target.display(), current.display()),
            "切换并重启",
        ),
    };
    let confirmed = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "取消".into()))
        .blocking_show();
    if !confirmed {
        return Ok(());
    }
    {
        let _guard = lock();
        SWITCHING.store(true, Ordering::SeqCst);
        if let Err(error) = switch(&local, &current, &target, &kind) {
            SWITCHING.store(false, Ordering::SeqCst);
            return Err(error);
        }
    }
    crate::pet::save_anchor(&app);
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::test_root;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn moves_the_vault_and_keeps_local_files() {
        let local = test_root("location-local");
        let target = test_root("location-target");
        write(&local.join("时间板/My Life/跑步.md"), "习惯");
        write(&local.join(".beta-life/vault.json"), "{}");
        write(&local.join(".beta-life/settings.json"), "{}");
        write(&local.join(".obsidian/app.json"), "{}");
        write(&local.join("pet/window.json"), "{}");
        assert_eq!(classify(&target, &local), Kind::Empty);
        switch(&local, &local, &target, &Kind::Empty).unwrap();
        assert!(target.join("时间板/My Life/跑步.md").exists());
        assert!(target.join(".beta-life/settings.json").exists() && target.join(".obsidian/app.json").exists());
        assert_eq!(entries(&local), Vec::<String>::new());
        assert!(local.join("pet/window.json").exists());
        assert_eq!(resolve(&local).unwrap(), target);

        // Moving back to the default folder removes the pointer.
        assert_eq!(classify(&local, &target), Kind::Empty);
        switch(&local, &target, &local, &Kind::Empty).unwrap();
        assert!(local.join("时间板/My Life/跑步.md").exists());
        assert_eq!(resolve(&local).unwrap(), local);
        fs::remove_dir_all(local).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn adopts_a_synced_vault_and_rejects_other_folders() {
        let local = test_root("location-adopt");
        let synced = test_root("location-synced");
        let other = test_root("location-other");
        write(&local.join(".beta-life/settings.json"), "本机");
        write(&synced.join(".beta-life/vault.json"), "{}");
        write(&other.join("笔记.md"), "别的");
        assert_eq!(classify(&other, &local), Kind::Other);
        assert_eq!(classify(&synced, &local), Kind::Vault);
        switch(&local, &local, &synced, &Kind::Vault).unwrap();
        assert_eq!(fs::read_to_string(settings_path(&synced)).unwrap(), "本机");
        assert!(settings_path(&local).exists(), "the current data stays where it was");
        assert_eq!(resolve(&local).unwrap(), synced);
        for dir in [local, synced, other] {
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_missing_folder_is_an_error_not_a_new_vault() {
        let local = test_root("location-missing");
        crate::atomic_write(&local.join(LOCATION_FILE), &Location { path: local.join("不存在") }).unwrap();
        assert!(resolve(&local).unwrap_err().contains("找不到数据文件夹"));
        fs::remove_dir_all(local).unwrap();
    }

    #[test]
    fn moves_v1_settings_into_the_vault() {
        let local = test_root("location-settings");
        write(&local.join("settings.json"), "旧");
        adopt_local_settings(&local, &local).unwrap();
        assert!(!local.join("settings.json").exists());
        assert_eq!(fs::read_to_string(settings_path(&local)).unwrap(), "旧");
        fs::remove_dir_all(local).unwrap();
    }
}
