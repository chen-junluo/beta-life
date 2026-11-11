//! Polls the md files of every tab once a second and tells the frontend which panels changed outside
//! beta-life. A file whose content hash matches what beta-life last wrote is not a change.

use super::{hash, known, lock, md_files, WATCHED};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter};

const INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
struct VaultChange {
    panels: Vec<&'static str>,
}

type Stamps = HashMap<PathBuf, (Option<SystemTime>, u64)>;

pub(crate) fn start(app: AppHandle, root: PathBuf) {
    thread::spawn(move || {
        let mut stamps = Stamps::new();
        scan(&root, &mut stamps, true);
        loop {
            thread::sleep(INTERVAL);
            let panels = {
                let _guard = lock();
                scan(&root, &mut stamps, false)
            };
            if !panels.is_empty() {
                let _ = app.emit("vault-changed", VaultChange { panels: panels.into_iter().collect() });
            }
        }
    });
}

fn panel_of(root: &Path, path: &Path) -> Option<&'static str> {
    WATCHED.iter().find(|(dir, _)| path.starts_with(root.join(dir))).map(|(_, panel)| *panel)
}

/// Compares the md files with the previous scan; `baseline` only records what is there.
fn scan(root: &Path, stamps: &mut Stamps, baseline: bool) -> BTreeSet<&'static str> {
    let mut current = Stamps::new();
    for (dir, _) in WATCHED {
        for path in md_files(&root.join(dir), true) {
            if let Ok(metadata) = fs::metadata(&path) {
                current.insert(path, (metadata.modified().ok(), metadata.len()));
            }
        }
    }
    let mut changed = BTreeSet::new();
    let mut known = known();
    for (path, stamp) in &current {
        if stamps.get(path) == Some(stamp) {
            continue;
        }
        let Ok(bytes) = fs::read(path) else { continue };
        let digest = hash(&bytes);
        if known.insert(path.clone(), digest) != Some(digest) && !baseline {
            changed.extend(panel_of(root, path));
        }
    }
    for path in stamps.keys().filter(|path| !current.contains_key(*path)) {
        // beta-life's own deletes already dropped the path from `known`.
        if known.remove(path).is_some() {
            changed.extend(panel_of(root, path));
        }
    }
    *stamps = current;
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{remove, test_root, write_md};

    #[test]
    fn reports_outside_edits_but_not_our_own_writes() {
        let root = test_root("watch");
        let note = root.join("回想/a.md");
        write_md(&note, "一").unwrap();
        let mut stamps = Stamps::new();
        assert!(scan(&root, &mut stamps, true).is_empty());

        write_md(&note, "二").unwrap();
        write_md(&root.join("时间板/My Life/b.md"), "习惯").unwrap();
        assert!(scan(&root, &mut stamps, false).is_empty());

        fs::write(&note, "外部修改").unwrap();
        fs::create_dir_all(root.join("记忆星云")).unwrap();
        fs::write(root.join("记忆星云/新.md"), "外部新建").unwrap();
        assert_eq!(scan(&root, &mut stamps, false), BTreeSet::from(["memories", "recall"]));

        remove(&root.join("时间板/My Life/b.md")).unwrap();
        assert!(scan(&root, &mut stamps, false).is_empty());
        fs::remove_file(&note).unwrap();
        assert_eq!(scan(&root, &mut stamps, false), BTreeSet::from(["recall"]));
        fs::remove_dir_all(root).unwrap();
    }
}
