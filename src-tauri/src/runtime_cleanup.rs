//! Reclaim only host-owned runtime trees, after recovery and while maintenance
//! is idle. A process-lifetime store lock also excludes another desktop writer.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};

pub const CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORD: u64 = 64 * 1024;

fn invalid(code: &'static str) -> io::Error {
    io::Error::other(code)
}
fn linked(info: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    info.file_type().is_symlink()
}
pub(crate) fn plain_directory(path: &Path) -> io::Result<()> {
    let info = fs::symlink_metadata(path)?;
    if linked(&info) || !info.is_dir() {
        return Err(invalid("runtime-cleanup-linked-directory"));
    }
    Ok(())
}
pub(crate) fn validate_root(root: &Path) -> io::Result<()> {
    if !root.is_absolute()
        || root
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid("runtime-cleanup-root-invalid"));
    }
    for path in root.ancestors().filter(|p| p.is_absolute()) {
        plain_directory(path)?;
    }
    Ok(())
}
fn read_json(path: &Path, limit: u64) -> io::Result<serde_json::Value> {
    let info = fs::symlink_metadata(path)?;
    if linked(&info) || !info.is_file() || info.len() > limit {
        return Err(invalid("runtime-cleanup-record-invalid"));
    }
    let mut data = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(invalid("runtime-cleanup-record-invalid"));
    }
    serde_json::from_slice(&data).map_err(io::Error::other)
}
fn optional_json(path: &Path, limit: u64) -> io::Result<Option<serde_json::Value>> {
    match read_json(path, limit) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub struct StoreLock {
    _file: File,
}
impl StoreLock {
    pub fn acquire(root: &Path) -> io::Result<Self> {
        validate_root(root)?;
        let path = root.join("store.lock");
        if let Ok(info) = fs::symlink_metadata(&path) {
            if linked(&info) || !info.is_file() {
                return Err(invalid("runtime-store-lock-invalid"));
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x00200000);
        }
        let file = options.open(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            extern "C" {
                fn flock(
                    fd: std::os::raw::c_int,
                    operation: std::os::raw::c_int,
                ) -> std::os::raw::c_int;
            }
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if linked(&file.metadata()?) {
            return Err(invalid("runtime-store-lock-invalid"));
        }
        Ok(Self { _file: file })
    }
}
#[derive(Default)]
pub struct RuntimeMaintenance {
    store: Mutex<Option<(PathBuf, StoreLock)>>,
    scheduled: AtomicBool,
    requested: AtomicBool,
}
pub fn acquire(app: &AppHandle) -> Result<(), String> {
    let root = crate::runtime_store::directory(app)?;
    let service = app.state::<RuntimeMaintenance>();
    let mut store = service
        .store
        .lock()
        .map_err(|_| "runtime-store-lock-state")?;
    if let Some((owned, _)) = store.as_ref() {
        return if owned == &root {
            Ok(())
        } else {
            Err("runtime-store-lock-root-changed".into())
        };
    }
    if let Some(parent) = root.parent() {
        for path in parent.ancestors().filter(|p| p.is_absolute() && p.exists()) {
            plain_directory(path).map_err(|_| "runtime-store-linked-path")?;
        }
    }
    fs::create_dir_all(&root).map_err(|_| "runtime-store-unavailable")?;
    let lock = StoreLock::acquire(&root).map_err(|_| "runtime-store-busy")?;
    *store = Some((root, lock));
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Removal {
    pub relative: String,
    pub reason: String,
    pub bytes: u64,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: u32,
    pub observed_at: u64,
    pub planned: Vec<Removal>,
    pub removed: Vec<String>,
    pub deferred: Vec<String>,
    pub kept: Vec<String>,
    pub reclaimed_bytes: u64,
}

fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 180
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.+".contains(&c))
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn relative_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let pieces: Vec<_> = relative.split('/').collect();
    if pieces.len() != 2
        || ![
            "versions",
            "candidates",
            "installing",
            "verified",
            "prepared-candidates",
        ]
        .contains(&pieces[0])
        || !id_valid(pieces[1])
        || relative.contains(['\\', ':'])
    {
        return Err(invalid("runtime-cleanup-path-invalid"));
    }
    let parent = root.join(pieces[0]);
    plain_directory(&parent)?;
    Ok(parent.join(pieces[1]))
}
fn pin_path(root: &Path, path: &Path) -> Option<String> {
    let root = crate::dsh::node_script_path(root);
    let path = crate::dsh::node_script_path(path);
    let mut parts = path.components();
    for expected in root.components() {
        let actual = parts.next()?;
        #[cfg(windows)]
        if !expected
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&actual.as_os_str().to_string_lossy())
        {
            return None;
        }
        #[cfg(not(windows))]
        if expected != actual {
            return None;
        }
    }
    let group = parts.next()?.as_os_str().to_str()?.to_ascii_lowercase();
    let id = parts.next()?.as_os_str().to_str()?;
    if !["versions", "candidates", "installing"].contains(&group.as_str()) || !id_valid(id) {
        return None;
    }
    Some(format!("{group}/{id}"))
}
fn pin_key(value: &str) -> String {
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.to_owned()
    }
}
fn live_pins(root: &Path, paths: &[PathBuf]) -> BTreeSet<String> {
    let canonical_root = fs::canonicalize(root).ok();
    let mut pins = BTreeSet::new();
    for path in paths {
        if let Some(pin) = pin_path(root, path) {
            pins.insert(pin_key(&pin));
        }
        if let (Some(base), Ok(actual)) = (&canonical_root, fs::canonicalize(path)) {
            if let Some(pin) = pin_path(base, &actual) {
                pins.insert(pin_key(&pin));
            }
        }
    }
    pins
}
pub fn own_temporary(root: &Path, path: &Path, kind: &str) -> io::Result<()> {
    validate_root(root)?;
    let group = match kind {
        "candidate" => "candidates",
        "install" => "installing",
        _ => return Err(invalid("runtime-cleanup-owner-invalid")),
    };
    let id = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| invalid("runtime-cleanup-owner-invalid"))?;
    if uuid::Uuid::parse_str(id).is_err() || path.parent() != Some(root.join(group).as_path()) {
        return Err(invalid("runtime-cleanup-owner-invalid"));
    }
    plain_directory(path)?;
    crate::maintenance::atomic_json(
        &path.join("desktop-owner.json"),
        &serde_json::json!({"schema":1,"kind":kind,"id":id}),
    )
}
fn temporary_owned(root: &Path, group: &str, path: &Path) -> bool {
    let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if uuid::Uuid::parse_str(id).is_err() {
        return false;
    }
    let kind = if group == "candidates" {
        "candidate"
    } else {
        "install"
    };
    if let Ok(Some(owner)) = optional_json(&path.join("desktop-owner.json"), MAX_RECORD) {
        return owner["schema"] == 1 && owner["kind"] == kind && owner["id"] == id;
    }
    // Explicit legacy ownership evidence, rather than deleting every UUID dir.
    if group == "installing" {
        return optional_json(&root.join("install-prefix.json"), 1024)
            .ok()
            .flatten()
            .is_some_and(|v| v.as_str() == Some(id));
    }
    optional_json(&path.join("preparation.json"), MAX_RECORD)
        .ok()
        .flatten()
        .is_some_and(|v| {
            v["schema"] == 1
                && v["requestId"]
                    .as_str()
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                && v["targetVersion"]
                    .as_str()
                    .is_some_and(|s| semver::Version::parse(s).is_ok())
                && matches!(
                    v["stage"].as_str(),
                    Some("installing" | "prepared" | "failed")
                )
        })
}
fn stage_owned(path: &Path) -> bool {
    let Some(id) = path
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix(".preparing-"))
    else {
        return false;
    };
    if uuid::Uuid::parse_str(id).is_err() {
        return false;
    }
    optional_json(&path.join("request.json"), MAX_RECORD)
        .ok()
        .flatten()
        .is_some_and(|v| {
            v["source"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute())
                && v["destination"]
                    .as_str()
                    .is_some_and(|s| Path::new(s) == path.join("tree"))
        })
}
fn size(path: &Path) -> io::Result<u64> {
    size_at(path, 0, false)
}
fn size_at(path: &Path, depth: usize, reject_links: bool) -> io::Result<u64> {
    if depth > 128 {
        return Err(invalid("runtime-cleanup-depth-budget"));
    }
    let info = fs::symlink_metadata(path)?;
    if linked(&info) {
        return if reject_links {
            Err(invalid("runtime-cache-linked-path"))
        } else {
            Ok(0)
        };
    }
    if info.is_file() {
        return Ok(info.len());
    }
    if !info.is_dir() {
        return Err(invalid("runtime-cleanup-special-file"));
    }
    let mut bytes: u64 = 0;
    for entry in fs::read_dir(path)? {
        bytes = bytes.saturating_add(size_at(&entry?.path(), depth + 1, reject_links)?);
    }
    Ok(bytes)
}
fn pending_key(relative: &str) -> String {
    relative.replace('/', "--") + ".json"
}
fn retry_items(root: &Path) -> io::Result<Vec<Removal>> {
    let directory = root.join("cleanup-pending");
    if !directory.try_exists()? {
        return Ok(vec![]);
    }
    plain_directory(&directory)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let value = read_json(&entry.path(), MAX_RECORD)?;
        let item: Removal = serde_json::from_value(value).map_err(io::Error::other)?;
        relative_path(root, &item.relative)?;
        if entry.file_name().to_str() != Some(pending_key(&item.relative).as_str()) {
            return Err(invalid("runtime-cleanup-retry-invalid"));
        }
        items.push(item);
    }
    Ok(items)
}

/// A read-only plan. All persistent references are checked before any deletion.
pub fn plan(root: &Path, live_paths: &[PathBuf]) -> io::Result<Report> {
    validate_root(root)?;
    let mut report = Report {
        schema: 1,
        observed_at: crate::maintenance::now_ms(),
        ..Report::default()
    };
    let live_pins = live_pins(root, live_paths);
    let mut pins = live_pins.clone();
    if let Some(record) = optional_json(&root.join("update.json"), 64 * 1024 * 1024)? {
        if record["schema"] != 1
            || !matches!(record["stage"].as_str(), Some("committed" | "rolled-back"))
        {
            return Err(invalid("runtime-cleanup-recovery-pending"));
        }
    }
    let selected = optional_json(&root.join("selection.json"), MAX_RECORD)?;
    if let Some(selection) = &selected {
        let id = selection["active"]
            .as_str()
            .filter(|s| id_valid(s))
            .ok_or_else(|| invalid("runtime-cleanup-selection-invalid"))?;
        if selection["schema"] != 1
            || selection["backendReady"] != true
            || selection["uiReady"] != true
            || selection["verifiedAt"].as_u64().unwrap_or(0) == 0
            || !selection["fingerprint"].as_str().is_some_and(digest_valid)
        {
            return Err(invalid("runtime-cleanup-selection-invalid"));
        }
        pins.insert(pin_key(&format!("versions/{id}")));
    }
    if selected.is_none() {
        if let Some(value) = optional_json(&root.join("first-install.json"), 1024)? {
            let id = value
                .as_str()
                .filter(|s| id_valid(s))
                .ok_or_else(|| invalid("runtime-cleanup-first-install-invalid"))?;
            pins.insert(pin_key(&format!("versions/{id}")));
        }
    }
    let retries = retry_items(root)?;
    let retry_names: BTreeSet<_> = retries.iter().map(|i| i.relative.clone()).collect();
    let mut versions = BTreeSet::new();
    for group in ["versions", "candidates", "installing"] {
        let directory = root.join(group);
        if !directory.try_exists()? {
            continue;
        }
        plain_directory(&directory)?;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let relative = format!("{group}/{id}");
            if pins.contains(&pin_key(&relative)) {
                report.kept.push(relative);
                continue;
            }
            let info = fs::symlink_metadata(entry.path())?;
            if linked(&info) || !info.is_dir() {
                report.kept.push(relative);
                continue;
            }
            let owned = if group == "versions" {
                crate::runtime_store::owned_version_bytes(root, &id).is_ok()
                    || stage_owned(&entry.path())
            } else {
                temporary_owned(root, group, &entry.path())
            };
            if !owned && !retry_names.contains(&relative) {
                report.kept.push(relative);
                continue;
            }
            if group == "versions" && !id.starts_with(".preparing-") {
                versions.insert(id);
            }
            report.planned.push(Removal {
                relative,
                reason: "unreferenced-runtime-content".into(),
                bytes: size(&entry.path())?,
            });
        }
    }
    for group in ["prepared-candidates", "verified"] {
        let directory = root.join(group);
        if !directory.try_exists()? {
            continue;
        }
        plain_directory(&directory)?;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let relative = format!("{group}/{name}");
            let info = fs::symlink_metadata(&path)?;
            if linked(&info) || !info.is_file() {
                report.kept.push(relative);
                continue;
            }
            let owned = if group == "verified" {
                name.strip_suffix(".bin")
                    .is_some_and(|id| versions.contains(id))
            } else {
                let value = match read_json(&path, MAX_RECORD) {
                    Ok(value) => value,
                    Err(_) => {
                        report.kept.push(relative);
                        continue;
                    }
                };
                let id = value["id"].as_str().unwrap_or("");
                value["schema"] == 1
                    && id_valid(id)
                    && value["version"].as_str().is_some_and(|version| {
                        name == format!("{version}.json") && semver::Version::parse(version).is_ok()
                    })
                    && value["fingerprint"].as_str().is_some_and(digest_valid)
                    && (selected
                        .as_ref()
                        .is_some_and(|selection| selection["active"] == id)
                        || !live_pins.contains(&pin_key(&format!("versions/{id}"))))
            };
            if owned || retry_names.contains(&relative) {
                report.planned.push(Removal {
                    relative,
                    reason: "obsolete-runtime-reference".into(),
                    bytes: info.len(),
                });
            } else {
                report.kept.push(relative);
            }
        }
    }
    for retry in retries {
        if !pins.contains(&pin_key(&retry.relative))
            && !report.planned.iter().any(|i| i.relative == retry.relative)
        {
            report.planned.push(retry);
        }
    }
    Ok(report)
}

/// Keep parent directories fixed on Windows. std::fs::remove_dir_all unlinks
/// nested reparse points without traversing their targets.
fn fixed_parents(root: &Path, target: &Path) -> io::Result<Vec<File>> {
    validate_root(root)?;
    let parent = target
        .parent()
        .ok_or_else(|| invalid("runtime-cleanup-path-invalid"))?;
    if parent.parent() != Some(root) {
        return Err(invalid("runtime-cleanup-path-invalid"));
    }
    plain_directory(parent)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut handles = Vec::new();
        for path in parent.ancestors().filter(|p| p.is_absolute()) {
            let file = OpenOptions::new()
                .access_mode(0x81)
                .share_mode(3)
                .custom_flags(0x00200000 | 0x02000000)
                .open(path)?;
            if linked(&file.metadata()?) {
                return Err(invalid("runtime-cleanup-linked-directory"));
            }
            handles.push(file);
        }
        Ok(handles)
    }
    #[cfg(not(windows))]
    {
        Ok(vec![])
    }
}
fn remove_item(root: &Path, item: &Removal) -> io::Result<()> {
    let target = relative_path(root, &item.relative)?;
    let _parents = fixed_parents(root, &target)?;
    let pending = root.join("cleanup-pending");
    if pending.try_exists()? {
        plain_directory(&pending)?;
    }
    let receipt = pending.join(pending_key(&item.relative));
    let info = match fs::symlink_metadata(&target) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return match fs::remove_file(&receipt) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            };
        }
        Err(error) => return Err(error),
    };
    if linked(&info) {
        return Err(invalid("runtime-cleanup-linked-target"));
    }
    // Ownership survives a sharing violation or a crash halfway through a tree.
    crate::maintenance::atomic_json(&receipt, item)?;
    if info.is_dir() {
        fs::remove_dir_all(&target)?;
    } else if info.is_file() {
        fs::remove_file(&target)?;
    } else {
        return Err(invalid("runtime-cleanup-special-file"));
    }
    fs::remove_file(receipt)?;
    Ok(())
}
pub fn discard_temporary(root: &Path, path: &Path) -> io::Result<()> {
    validate_root(root)?;
    let relative = pin_path(root, path)
        .filter(|p| root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)) == path)
        .ok_or_else(|| invalid("runtime-cleanup-path-invalid"))?;
    let group = relative.split('/').next().unwrap();
    if !["candidates", "installing"].contains(&group) || !temporary_owned(root, group, path) {
        return Err(invalid("runtime-cleanup-owner-invalid"));
    }
    remove_item(
        root,
        &Removal {
            relative,
            reason: "finished-runtime-installation".into(),
            bytes: size(path)?,
        },
    )
}
pub(crate) fn discard_stage(root: &Path, path: &Path) -> io::Result<()> {
    validate_root(root)?;
    if path.parent() != Some(root.join("versions").as_path()) || !stage_owned(path) {
        return Err(invalid("runtime-cleanup-owner-invalid"));
    }
    let id = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| invalid("runtime-cleanup-owner-invalid"))?;
    remove_item(
        root,
        &Removal {
            relative: format!("versions/{id}"),
            reason: "finished-runtime-freeze".into(),
            bytes: size(path)?,
        },
    )
}
pub(crate) fn discard_unpublished(root: &Path, id: &str) -> io::Result<()> {
    validate_root(root)?;
    crate::runtime_store::owned_version_bytes(root, id)?;
    if optional_json(&root.join("selection.json"), MAX_RECORD)?.is_some_and(|s| s["active"] == id)
        || optional_json(&root.join("first-install.json"), 1024)?.is_some_and(|s| s == id)
        || optional_json(&root.join("update.json"), 64 * 1024 * 1024)?
            .is_some_and(|s| !matches!(s["stage"].as_str(), Some("committed" | "rolled-back")))
    {
        return Err(invalid("runtime-cleanup-runtime-referenced"));
    }
    remove_item(
        root,
        &Removal {
            relative: format!("versions/{id}"),
            reason: "unpublished-runtime".into(),
            bytes: size(&root.join("versions").join(id))?,
        },
    )
}
pub fn collect(root: &Path, live_paths: &[PathBuf]) -> io::Result<Report> {
    let mut report = plan(root, live_paths)?;
    crate::maintenance::atomic_json(&root.join("cleanup-report.json"), &report)?;
    if let Some(mut selection) = optional_json(&root.join("selection.json"), MAX_RECORD)? {
        if !selection["previous"].is_null() {
            selection["previous"] = serde_json::Value::Null;
            crate::maintenance::atomic_json(&root.join("selection.json"), &selection)?;
        }
    }
    for item in &report.planned {
        match remove_item(root, item) {
            Ok(()) => {
                report.removed.push(item.relative.clone());
                report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(item.bytes);
            }
            Err(_) => report.deferred.push(item.relative.clone()),
        }
    }
    // Stale first-install intent cannot win over an already committed selection.
    if root.join("selection.json").try_exists()? {
        if optional_json(&root.join("first-install.json"), 1024)?.is_some() {
            fs::remove_file(root.join("first-install.json"))?;
        }
    }
    crate::maintenance::atomic_json(&root.join("cleanup-report.json"), &report)?;
    Ok(report)
}
pub(crate) fn trim_cache(root: &Path, node: &Path, budget: u64) -> Result<bool, String> {
    let cache = root.join("npm-cache");
    if !cache
        .try_exists()
        .map_err(|_| "runtime-cache-unavailable")?
    {
        return Ok(false);
    }
    validate_root(root).map_err(|_| "runtime-cache-linked-path")?;
    plain_directory(&cache).map_err(|_| "runtime-cache-linked-path")?;
    if size_at(&cache, 0, true).map_err(|_| "runtime-cache-unavailable")? <= budget {
        return Ok(false);
    }
    let _parents =
        fixed_parents(root, &cache.join("_cacache")).map_err(|_| "runtime-cache-linked-path")?;
    crate::npm::clean_cache(node, &cache)?;
    if size_at(&cache, 0, true).map_err(|_| "runtime-cache-unavailable")? > budget {
        return Err("runtime-cache-clean-deferred".into());
    }
    Ok(true)
}
fn maintain(app: &AppHandle) -> Result<bool, String> {
    acquire(app)?;
    let (current, node) = {
        let shared = app.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|_| "runtime-cleanup-state")?;
        if state.ui.phase == crate::ui_snapshot::UiPhase::Exiting
            || matches!(state.phase, crate::state::Phase::Failed { .. })
        {
            return Ok(true);
        }
        if state.boot_in_progress
            || state.remote.applying
            || state.ui.snapshot.is_some()
            || !state.ui.loaded
            || !matches!(state.phase, crate::state::Phase::Running { .. })
        {
            return Ok(false);
        }
        let current = state.runtime.as_ref().ok_or("runtime-cleanup-runtime")?;
        if current
            .managed
            .as_ref()
            .is_some_and(|managed| !managed.committed)
        {
            return Ok(false);
        }
        (current.dsh_bin.clone(), current.node_exe.clone())
    };
    let mut pins = vec![current];
    pins.extend(crate::dsh_upgrade::prepared_paths(app)?);
    let root = crate::runtime_store::directory(app)?;
    let report = collect(&root, &pins).map_err(|_| "runtime-cleanup-deferred")?;
    crate::debug_log(&format!(
        "[runtime-cleanup] removed={} deferred={} bytes={}",
        report.removed.len(),
        report.deferred.len(),
        report.reclaimed_bytes
    ));
    if !report.deferred.is_empty() {
        crate::diagnostics::record(app, "runtime", "cleanup-deferred");
    }
    trim_cache(&root, &node, CACHE_BYTES)?;
    Ok(true)
}
#[cfg(debug_assertions)]
pub(crate) fn pending(app: &AppHandle) -> bool {
    let service = app.state::<RuntimeMaintenance>();
    service.scheduled.load(Ordering::Acquire) || service.requested.load(Ordering::Acquire)
}

/// Work stays off the UI thread, under the existing maintenance coordinator.
pub fn schedule(app: &AppHandle) {
    let service = app.state::<RuntimeMaintenance>();
    service.requested.store(true, Ordering::Release);
    if service.scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut delay = Duration::from_millis(100);
        loop {
            let service = app.state::<RuntimeMaintenance>();
            service.requested.store(false, Ordering::Release);
            let result = match app
                .state::<crate::maintenance::MaintenanceCoordinator>()
                .begin(crate::maintenance::Kind::Cleanup)
            {
                Ok(lease) => {
                    let result = maintain(&app);
                    drop(lease);
                    result
                }
                Err(_) => Ok(false),
            };
            match result {
                Ok(true) if !service.requested.load(Ordering::Acquire) => break,
                Ok(_) => {}
                Err(code) => {
                    crate::diagnostics::record(&app, "runtime", &code);
                    break;
                }
            }
            // Release maintenance between attempts. Page readiness and commit
            // can arrive after a long install, so a transient skip is retried.
            std::thread::sleep(delay);
            delay = (delay * 2).min(Duration::from_secs(2));
        }
        let service = app.state::<RuntimeMaintenance>();
        service.scheduled.store(false, Ordering::Release);
        // A request arriving while the worker finishes must get another pass.
        if service.requested.swap(false, Ordering::AcqRel) {
            schedule(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn temporary() -> tempfile::TempDir {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/native-runtime-store-GCREG1");
        fs::create_dir_all(&directory).unwrap();
        tempfile::tempdir_in(directory).unwrap()
    }
    fn version(root: &Path, id: &str) -> PathBuf {
        let directory = root.join("versions").join(id);
        let entry = "node_modules/@deepseek-ai/dsh/lib/bin.js";
        let path = directory.join("tree").join(entry);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"runtime fixture").unwrap();
        crate::maintenance::atomic_json(&directory.join("manifest.json"), &json!({"schema":1,"id":id,"version":"0.2.1-rc.2",
            "architecture":std::env::consts::ARCH,"entry":entry,"fingerprint":"a".repeat(64),"inventoryHash":"b".repeat(64),
            "nodeHash":"c".repeat(64),"fileCount":1,"totalBytes":15})).unwrap();
        path
    }
    fn select(root: &Path, active: &str, previous: Option<&str>) {
        crate::maintenance::atomic_json(&root.join("selection.json"), &json!({"schema":1,"active":active,"previous":previous,
            "fingerprint":"a".repeat(64),"verifiedAt":1,"backendReady":true,"uiReady":true,"configuredSource":null})).unwrap();
    }
    fn candidate(root: &Path) -> PathBuf {
        let path = root
            .join("candidates")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        own_temporary(root, &path, "candidate").unwrap();
        fs::write(path.join("package.tmp"), b"unused candidate").unwrap();
        path
    }
    #[test]
    fn keeps_only_the_current_version_and_preserves_unknown_and_user_data() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        let old = version(&root, "old");
        select(&root, "current", Some("old"));
        let staging = candidate(&root);
        fs::create_dir_all(root.join("versions/user-notes")).unwrap();
        fs::write(root.join("versions/user-notes/notes.txt"), b"keep").unwrap();
        fs::write(tmp.path().join("chat-history.json"), b"keep chat").unwrap();
        let report = collect(&root, &[current.clone()]).unwrap();
        assert!(current.is_file());
        assert!(!old.exists());
        assert!(!staging.exists());
        assert_eq!(
            read_json(&root.join("selection.json"), MAX_RECORD).unwrap()["previous"],
            serde_json::Value::Null
        );
        assert_eq!(
            fs::read(root.join("versions/user-notes/notes.txt")).unwrap(),
            b"keep"
        );
        assert_eq!(
            fs::read(tmp.path().join("chat-history.json")).unwrap(),
            b"keep chat"
        );
        assert!(report.deferred.is_empty());
        assert!(collect(&root, &[current]).unwrap().planned.is_empty());
    }
    #[test]
    fn a_pending_upgrade_protects_both_versions_until_the_full_commit() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let old = version(&root, "old");
        let new = version(&root, "new");
        select(&root, "new", Some("old"));
        let record = root.join("update.json");
        crate::maintenance::atomic_json(
            &record,
            &json!({"schema":1,"stage":"pending","source":{},"target":{}}),
        )
        .unwrap();
        assert!(collect(&root, &[new.clone()]).is_err());
        assert!(old.exists());
        assert!(new.exists());
        assert!(!root.join("cleanup-report.json").exists());
        crate::maintenance::atomic_json(
            &record,
            &json!({"schema":1,"stage":"committed","source":{},"target":{}}),
        )
        .unwrap();
        collect(&root, &[new.clone()]).unwrap();
        assert!(new.exists());
        assert!(!old.exists());
    }
    #[test]
    fn first_install_and_an_in_memory_candidate_are_temporarily_protected() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "first");
        let next = version(&root, "next");
        crate::maintenance::atomic_json(&root.join("first-install.json"), &json!("first")).unwrap();
        collect(&root, &[next.clone()]).unwrap();
        assert!(current.exists());
        assert!(next.exists());
        select(&root, "first", None);
        collect(&root, &[current.clone()]).unwrap();
        assert!(current.exists());
        assert!(!next.exists());
        assert!(!root.join("first-install.json").exists());
    }
    #[test]
    fn retires_prepared_references_and_receipts_with_their_obsolete_version() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        let old = version(&root, "old");
        select(&root, "current", None);
        let directory = root.join("prepared-candidates");
        crate::maintenance::atomic_json(
            &directory.join("0.2.1-rc.2.json"),
            &json!({"schema":1,"id":"current","version":"0.2.1-rc.2","fingerprint":"a".repeat(64)}),
        )
        .unwrap();
        fs::create_dir(root.join("verified")).unwrap();
        fs::write(root.join("verified/old.bin"), b"obsolete receipt").unwrap();
        fs::write(root.join("verified/current.bin"), b"current receipt").unwrap();
        fs::write(directory.join("notes.txt"), b"unknown purpose").unwrap();
        collect(&root, &[current.clone()]).unwrap();
        assert!(!old.exists());
        assert!(!directory.join("0.2.1-rc.2.json").exists());
        assert!(!root.join("verified/old.bin").exists());
        assert_eq!(
            fs::read(root.join("verified/current.bin")).unwrap(),
            b"current receipt"
        );
        assert_eq!(
            fs::read(directory.join("notes.txt")).unwrap(),
            b"unknown purpose"
        );
    }
    #[test]
    fn invalid_selection_or_retry_paths_prevent_deletion() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let path = version(&root, "keep");
        crate::maintenance::atomic_json(&root.join("selection.json"), &json!({"schema":999}))
            .unwrap();
        assert!(collect(&root, &[]).is_err());
        assert!(path.exists());
        fs::remove_file(root.join("selection.json")).unwrap();
        crate::maintenance::atomic_json(
            &root.join("cleanup-pending/invalid.json"),
            &json!({"relative":"versions/../../outside","reason":"bad","bytes":0}),
        )
        .unwrap();
        assert!(collect(&root, &[]).is_err());
        assert!(path.exists());
    }
    #[test]
    fn a_retry_receipt_is_retired_when_the_tree_was_already_removed() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        select(&root, "current", None);
        let receipt = root.join("cleanup-pending/versions--already-removed.json");
        crate::maintenance::atomic_json(
            &receipt,
            &Removal {
                relative: "versions/already-removed".into(),
                reason: "interrupted-cleanup".into(),
                bytes: 10,
            },
        )
        .unwrap();
        let report = collect(&root, &[current.clone()]).unwrap();
        assert!(report.deferred.is_empty());
        assert!(!receipt.exists());
        assert!(current.exists());
        assert!(collect(&root, &[current]).unwrap().planned.is_empty());
    }
    #[test]
    fn abandoned_freeze_stages_require_an_exact_owned_destination() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        select(&root, "current", None);
        let stage = root
            .join("versions")
            .join(format!(".preparing-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(stage.join("tree")).unwrap();
        crate::maintenance::atomic_json(
            &stage.join("request.json"),
            &json!({"source":tmp.path(),"destination":stage.join("tree")}),
        )
        .unwrap();
        fs::write(stage.join("tree/part.tmp"), b"unfinished").unwrap();
        let unknown = root
            .join("versions")
            .join(format!(".preparing-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&unknown).unwrap();
        collect(&root, &[current]).unwrap();
        assert!(!stage.exists());
        assert!(unknown.exists());
    }
    #[test]
    fn store_lock_excludes_another_process_and_releases_without_deleting_the_lock() {
        const CHILD: &str = "DSH_CLEANUP_LOCK_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            assert!(StoreLock::acquire(Path::new(&root)).is_err());
            return;
        }
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        fs::create_dir(&root).unwrap();
        let owned = StoreLock::acquire(&root).unwrap();
        let child=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","runtime_cleanup::tests::store_lock_excludes_another_process_and_releases_without_deleting_the_lock","--nocapture"])
            .env(CHILD,&root).output().unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
        drop(owned);
        assert!(root.join("store.lock").is_file());
        assert!(StoreLock::acquire(&root).is_ok());
    }
    #[test]
    fn cache_budget_uses_npm_to_reclaim_only_this_stores_cache_when_needed() {
        let Some(node) = crate::dsh::resolve_node() else {
            return;
        };
        if crate::npm::npm_cli_for(&node).is_none() {
            return;
        }
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let cache = root.join("npm-cache/_cacache/content-v2/sha512/aa/bb");
        fs::create_dir_all(&cache).unwrap();
        let content = cache.join("fixture");
        fs::write(&content, [7u8; 128 * 1024]).unwrap();
        let logs = root.join("npm-cache/_logs");
        fs::create_dir(&logs).unwrap();
        let log = logs.join("2026-01-01T00_00_00_000Z-debug-0.log");
        fs::write(&log, [8u8; 128 * 1024]).unwrap();
        let other = tmp.path().join("other-npm-cache");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("sentinel"), b"keep").unwrap();
        assert!(!trim_cache(&root, &node, 512 * 1024).unwrap());
        assert!(content.exists());
        assert!(log.exists());
        assert!(trim_cache(&root, &node, 64 * 1024).unwrap());
        assert!(!content.exists());
        assert!(!log.exists());
        assert!(size(&root.join("npm-cache")).unwrap() <= 64 * 1024);
        assert_eq!(fs::read(other.join("sentinel")).unwrap(), b"keep");
    }
    #[test]
    #[cfg(windows)]
    fn configured_paths_with_verbatim_prefixes_and_different_case_stay_protected() {
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        let old = version(&root, "old");
        let alias = PathBuf::from(format!(
            "\\\\?\\{}",
            current.to_string_lossy().to_ascii_uppercase()
        ));
        collect(&root, &[alias]).unwrap();
        assert!(current.exists());
        assert!(!old.exists());
    }
    #[test]
    #[cfg(windows)]
    fn a_locked_file_leaves_retry_ownership_even_after_a_partial_tree_deletion() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        let old = version(&root, "old");
        select(&root, "current", None);
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&old)
            .unwrap();
        let first = collect(&root, &[current.clone()]).unwrap();
        assert!(first.deferred.contains(&"versions/old".to_owned()));
        assert!(root.join("cleanup-pending/versions--old.json").is_file());
        drop(held);
        fs::remove_file(root.join("versions/old/manifest.json")).ok();
        let second = collect(&root, &[current.clone()]).unwrap();
        assert!(second.deferred.is_empty());
        assert!(!old.exists());
        assert!(current.exists());
        assert!(!root.join("cleanup-pending/versions--old.json").exists());
    }
    #[test]
    #[cfg(windows)]
    fn nested_junctions_are_unlinked_without_deleting_their_external_targets() {
        let Some(node) = crate::dsh::resolve_node() else {
            return;
        };
        let tmp = temporary();
        let root = tmp.path().join("runtime");
        let current = version(&root, "current");
        version(&root, "old");
        select(&root, "current", None);
        let outside = tmp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"external").unwrap();
        let junction = root.join("versions/old/tree/junction");
        assert!(std::process::Command::new(&node)
            .args([
                "-e",
                "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')"
            ])
            .arg(&outside)
            .arg(&junction)
            .status()
            .unwrap()
            .success());
        collect(&root, &[current]).unwrap();
        assert!(!root.join("versions/old").exists());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"external");
        let linked_root = tmp.path().join("linked-runtime");
        assert!(std::process::Command::new(node)
            .args([
                "-e",
                "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')"
            ])
            .arg(&outside)
            .arg(&linked_root)
            .status()
            .unwrap()
            .success());
        assert!(plan(&linked_root, &[]).is_err());
        assert!(outside.join("keep.txt").exists());
    }
}
