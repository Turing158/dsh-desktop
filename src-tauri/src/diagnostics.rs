//! Diagnostics remain available on the local boot page. Exports contain only
//! structured host facts; raw output is omitted and counted.
use std::{io::{self, Write}, path::{Path, PathBuf}, sync::Mutex};
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub desktop_version: &'static str,
    pub architecture: &'static str,
    pub distribution: &'static str,
    pub node_path: Option<PathBuf>,
    pub node_version: Option<String>,
    pub npm_cli_path: Option<PathBuf>,
    pub npm_version: Option<String>,
    pub dsh_entry: Option<PathBuf>,
    pub dsh_version: Option<String>,
    pub dsh_source: Option<crate::dsh::DshSource>,
    pub managed_runtime: Option<crate::runtime_store::ManagedRuntime>,
    pub path_dsh_entry: Option<PathBuf>,
    pub webview_version: Option<String>,
    pub webview_path: Option<PathBuf>,
    pub backend_instance: u64,
    pub backend_loaded: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub status: &'static str,
    pub reason_code: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: u32,
    pub observed_at: u64,
    pub checked_at: Option<u64>,
    pub phase: crate::state::PublicPhase,
    pub runtime: RuntimeDescriptor,
    pub checks: Vec<Check>,
    pub inventory: crate::data_inventory::DataInventory,
    pub capabilities: Vec<crate::compatibility::Capability>,
    pub operation: Option<crate::maintenance::OperationJournal>,
    pub incomplete_operations: Vec<crate::maintenance::OperationJournal>,
    pub unreadable_journals: usize,
    pub omitted_raw_log_lines: usize,
}
#[derive(Clone, Default)]
struct Cache { checked_at: Option<u64>, backend_instance: u64, checks: Vec<Check>, inventory: Option<crate::data_inventory::DataInventory>, runtime: Option<RuntimeDescriptor>, incomplete_operations: Vec<crate::maintenance::OperationJournal>, unreadable_journals: usize }
#[derive(Default)]
pub struct Diagnostics { cache: Mutex<Cache>, check: Mutex<()>, log: Mutex<()>, dialog_requested: Mutex<bool> }

fn data_root(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR") { return Some(PathBuf::from(root)); }
    app.path().app_data_dir().ok()
}

fn descriptor(state: &crate::state::AppState) -> RuntimeDescriptor {
    let runtime = state.runtime.as_ref();
    let node = runtime.map(|r| r.node_exe.clone());
    let dsh = runtime.map(|r| (r.dsh_bin.clone(), r.source));
    RuntimeDescriptor {
        desktop_version: env!("CARGO_PKG_VERSION"), architecture: std::env::consts::ARCH,
        distribution: if cfg!(feature = "single") { "single" } else if cfg!(feature = "offline") { "bundled" } else { "standard" },
        npm_cli_path: None, node_path: node,
        node_version: None, npm_version: None,
        dsh_entry: dsh.as_ref().map(|(path, _)| path.clone()),
        dsh_source: dsh.map(|(_, source)| source), dsh_version: runtime.and_then(|r| r.version.clone()),
        managed_runtime: runtime.and_then(|r|r.managed.clone()),
        path_dsh_entry: None, webview_version: None, webview_path: None,
        backend_instance: state.ui.backend_instance, backend_loaded: state.ui.loaded,
    }
}
fn summary(app: &AppHandle) -> Result<Report, String> {
    let (phase, runtime, capabilities, omitted_raw_log_lines, storage) = {
        let shared = app.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|_| "diagnostics-state")?;
        (crate::state::PublicPhase::from(&state.phase), descriptor(&state), crate::compatibility::host(&state), state.log.len(), state.storage.clone())
    };
    let cache = app.state::<Diagnostics>().cache.lock().map_err(|_| "diagnostics-cache")?.clone();
    let current = cache.checked_at.is_some_and(|at| crate::maintenance::now_ms().saturating_sub(at) <= 300_000) && cache.backend_instance == runtime.backend_instance;
    let root = data_root(app);
    let mut runtime = runtime;
    if current {
        if let Some(mut checked) = cache.runtime.clone() {
            checked.backend_loaded = runtime.backend_loaded;
            runtime = checked;
        }
    }
    let mut inventory = if current { cache.inventory.unwrap_or_else(|| crate::data_inventory::DataInventory::unresolved(root.clone())) } else { crate::data_inventory::DataInventory::unresolved(root) };
    if let Some(observed) = storage.filter(|s| s.backend_instance == runtime.backend_instance && crate::maintenance::now_ms().saturating_sub(s.observed_at) <= 300_000) { inventory.observe(&observed); }
    Ok(Report { schema: 1, observed_at: crate::maintenance::now_ms(), checked_at: current.then_some(cache.checked_at).flatten(), phase, runtime, checks: if current { cache.checks } else { vec![] }, inventory, capabilities, operation: app.state::<crate::maintenance::MaintenanceCoordinator>().status(), incomplete_operations: cache.incomplete_operations, unreadable_journals: cache.unreadable_journals, omitted_raw_log_lines })
}

fn read_journals(root: Option<&Path>, cache: &mut Cache) {
    cache.incomplete_operations.clear();
    cache.unreadable_journals = 0;
    if let Some(root) = &root {
        if let Ok(entries) = std::fs::read_dir(root.join("maintenance/operations")) {
            for entry in entries {
                let Ok(entry) = entry else { cache.unreadable_journals += 1; continue };
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
                match crate::maintenance::OperationJournal::load(&entry.path()) {
                    Ok(journal) if !journal.stage.terminal() => {
                        cache.incomplete_operations.push(journal);
                        cache.incomplete_operations.sort_by_key(|j| std::cmp::Reverse(j.updated_at));
                        cache.incomplete_operations.truncate(200);
                    },
                    Ok(_) => {},
                    Err(_) => cache.unreadable_journals += 1,
                }
            }
        }
    }
}

fn authorize(window: &WebviewWindow, claimed: Option<crate::remote_control::Identity>) -> Result<(), String> {
    if !matches!(window.label(), "main" | "diagnostics") { return Err("diagnostics-origin".into()); }
    let url = window.url().map_err(|_| "diagnostics-origin")?;
    if crate::ui_snapshot::is_app_document(window.app_handle(), &url) { return Ok(()); }
    crate::remote_control::caller(window, claimed.ok_or("diagnostics-identity-required")?).map_err(|e| e.message)
}

/// Keep the request until the main document's dialog handler is ready, including
/// when showing the interface first has to restore a disposed WebView.
pub fn open(app: &AppHandle) {
    if let Ok(mut requested) = app.state::<Diagnostics>().dialog_requested.lock() {
        *requested = true;
    }
    crate::tray::show_main_window(app);
    if let Some(window) = app.get_webview_window("main") { request_dialog(&window); }
}

pub fn request_dialog(window: &WebviewWindow) {
    let pending = window.state::<Diagnostics>().dialog_requested.lock().map(|requested| *requested).unwrap_or(false);
    if !pending { return; }
    let Ok(url) = window.url() else { return };
    let ready = window.state::<crate::state::Shared>().lock().map(|state| {
        state.ui.loaded
            && !matches!(state.ui.phase, crate::ui_snapshot::UiPhase::Destroying | crate::ui_snapshot::UiPhase::Minimal | crate::ui_snapshot::UiPhase::Exiting)
            && crate::ui_snapshot::allowed_origin(window.app_handle(), &url, &state.phase)
    }).unwrap_or(false);
    if ready {
        let _ = window.eval("document.dispatchEvent(new Event('dsh-desktop:diagnostics-request'));");
    }
}

#[tauri::command]
pub fn desktop_diagnostics_dialog(window: WebviewWindow, identity: Option<crate::remote_control::Identity>) -> Result<bool, String> {
    if window.label() != "main" { return Err("diagnostics-origin".into()); }
    authorize(&window, identity)?;
    let url = window.url().map_err(|_| "diagnostics-origin")?;
    if crate::ui_snapshot::is_app_document(window.app_handle(), &url)
        && matches!(window.state::<crate::state::Shared>().lock().map_err(|_| "diagnostics-state")?.phase, crate::state::Phase::Running { .. }) {
        return Ok(false);
    }
    let service = window.state::<Diagnostics>();
    let mut requested = service.dialog_requested.lock().map_err(|_| "diagnostics-dialog")?;
    Ok(std::mem::take(&mut *requested))
}

#[tauri::command]
pub async fn desktop_diagnostics(window: WebviewWindow, identity: Option<crate::remote_control::Identity>) -> Result<Report, String> {
    authorize(&window, identity)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = summary(&app)?;
        let mut records = Cache::default();
        read_journals(data_root(&app).as_deref(), &mut records);
        report.incomplete_operations = records.incomplete_operations;
        report.unreadable_journals = records.unreadable_journals;
        Ok(report)
    }).await.map_err(|_| "diagnostics-worker")?
}

#[tauri::command]
pub async fn desktop_diagnostics_check(window: WebviewWindow, identity: Option<crate::remote_control::Identity>) -> Result<Report, String> {
    authorize(&window, identity)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Read-only probes never own the maintenance lease: startup and retries
        // must remain possible while Node/npm probes are waiting for a timeout.
        let service = app.state::<Diagnostics>();
        let _check = service.check.try_lock().map_err(|_| "diagnostics-check-busy")?;
        let mut initial = summary(&app)?;
        let runtime = &mut initial.runtime;
        runtime.node_path = runtime.node_path.take().or_else(crate::dsh::resolve_node);
        if runtime.dsh_entry.is_none() {
            if let Some(node)=runtime.node_path.as_deref() {
                if let Ok(Some(found))=crate::runtime_store::resolve(&app,node) {runtime.dsh_entry=Some(found.dsh_bin);runtime.dsh_source=Some(found.source);runtime.dsh_version=found.version;runtime.managed_runtime=found.managed;}
            }
        }
        runtime.npm_cli_path = runtime.node_path.as_deref().and_then(crate::npm::npm_cli_for);
        runtime.path_dsh_entry = crate::dsh::find_on_path("dsh.cmd");
        runtime.webview_version = tauri::webview_version().ok();
        runtime.webview_path = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").map(PathBuf::from);
        let mut cache = Cache { checked_at: Some(crate::maintenance::now_ms()), backend_instance: initial.runtime.backend_instance, ..Cache::default() };
        let mut checks = vec![];
        if let Some(node) = &initial.runtime.node_path {
            let mut cmd = std::process::Command::new(node);
            cmd.arg("--version");
            let version = crate::dsh_update::output(&mut cmd, "node-version", std::time::Duration::from_secs(8)).ok().filter(|v| semver::Version::parse(v.trim_start_matches('v')).is_ok());
            let supported = version.as_deref().and_then(|v| v.trim_start_matches('v').split('.').next()?.parse::<u32>().ok()).is_some_and(|major| major >= crate::dsh::MIN_NODE_MAJOR);
            initial.runtime.node_version = version;
            checks.push(Check { id: "node", status: if supported { "available" } else { "unavailable" }, reason_code: if supported { "node-supported" } else { "node-version-unsupported" } });
            if let Some(cli) = &initial.runtime.npm_cli_path {
                let mut cmd = std::process::Command::new(node);
                cmd.arg(cli).arg("--version");
                initial.runtime.npm_version = crate::dsh_update::output(&mut cmd, "npm-version", std::time::Duration::from_secs(8)).ok().filter(|v| semver::Version::parse(v).is_ok());
            }
            if let (Some(entry), Some(source)) = (&initial.runtime.dsh_entry, initial.runtime.dsh_source) {
                let runtime = crate::dsh::Runtime { node_exe: node.clone(), dsh_bin: entry.clone(), source, version: initial.runtime.dsh_version.clone(),managed:None };
                if let Ok(patch) = crate::patch_file(&app) {
                    if let Some(parent) = patch.parent() {
                        cache.inventory = crate::data_inventory::DataInventory::probe(&runtime, data_root(&app), &parent.join("desktop-maintenance/inventory.mjs")).ok();
                    }
                }
            }
        } else { checks.push(Check { id: "node", status: "unavailable", reason_code: "node-missing" }); }
        checks.push(Check { id: "npm", status: if initial.runtime.npm_version.is_some() { "available" } else { "unavailable" }, reason_code: if initial.runtime.npm_version.is_some() { "npm-probed" } else { "npm-unavailable" } });
        checks.push(Check { id: "dsh-entry", status: if initial.runtime.dsh_entry.as_ref().is_some_and(|p| p.is_file()) { "available" } else { "unavailable" }, reason_code: if initial.runtime.dsh_entry.as_ref().is_some_and(|p| p.is_file()) { "runtime-entry-found" } else { "runtime-entry-missing" } });
        checks.push(Check { id: "data-roots", status: if cache.inventory.is_some() { "limited" } else { "unknown" }, reason_code: if cache.inventory.is_some() { "roots-resolved-consistency-unverified" } else { "inventory-resolver-unavailable" } });
        checks.push(Check { id: "webview", status: if initial.runtime.webview_version.is_some() { "available" } else { "unknown" }, reason_code: if initial.runtime.webview_version.is_some() { "webview-version-reported" } else { "webview-version-unavailable" } });
        cache.checks = checks;
        cache.checked_at = Some(crate::maintenance::now_ms());
        cache.runtime = Some(initial.runtime);
        read_journals(data_root(&app).as_deref(), &mut cache);
        *app.state::<Diagnostics>().cache.lock().map_err(|_| "diagnostics-cache")? = cache;
        record(&app, "diagnostics", "checks-complete");
        summary(&app)
    }).await.map_err(|_| "diagnostics-worker")?
}

#[tauri::command]
pub async fn desktop_diagnostics_export(window: WebviewWindow, identity: Option<crate::remote_control::Identity>) -> Result<Option<String>, String> {
    authorize(&window, identity)?;
    let page = window.url().map_err(|_| "diagnostics-origin")?;
    let owner = window.hwnd().map_err(|_| "diagnostics-window")?.0 as usize;
    let destination = tauri::async_runtime::spawn_blocking(move || crate::directory_picker::pick_directory(owner, "Diagnostics / 诊断报告", "Save / 保存"))
        .await.map_err(|_| "diagnostics-dialog")?.map_err(|_| "diagnostics-dialog")?;
    let Some(destination) = destination else { return Ok(None) };
    authorize(&window, identity)?;
    if window.url().map_err(|_| "diagnostics-origin")? != page { return Err("diagnostics-stale-document".into()); }
    let app = window.app_handle().clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut report = summary(&app)?;
        let mut records = Cache::default();
        read_journals(data_root(&app).as_deref(), &mut records);
        report.incomplete_operations = records.incomplete_operations;
        report.unreadable_journals = records.unreadable_journals;
        let mut value = serde_json::to_value(report).map_err(|_| "diagnostics-serialize")?;
        crate::redaction::report(&mut value);
        export(&destination, &value).map_err(|_| "diagnostics-export-failed".to_string())
    }).await.map_err(|_| "diagnostics-export-worker")??;
    Ok(Some(path.to_string_lossy().into_owned()))
}
fn export(directory: &Path, value: &serde_json::Value) -> io::Result<PathBuf> {
    let file = tempfile::NamedTempFile::new_in(directory)?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    archive.start_file("report.json", options)?;
    serde_json::to_writer_pretty(&mut archive, value)?;
    archive.start_file("summary.txt", options)?;
    archive.write_all(b"DSH desktop diagnostics\nPaths, credentials and raw child output are omitted.\nOnly explicitly probed checks supply evidence. Unknown capabilities remain unknown.\nSee report.json for check codes and limitations.\n")?;
    writeln!(archive, "\nDesktop: {}\nDSH: {}\nNode: {}\nPhase: {}", value["runtime"]["desktopVersion"], value["runtime"]["dshVersion"], value["runtime"]["nodeVersion"], value["phase"]["kind"])?;
    if let Some(checks) = value["checks"].as_array() {
        for check in checks { writeln!(archive, "{}: {} ({})", check["id"], check["status"], check["reasonCode"])?; }
    }
    archive.start_file("capabilities.json", options)?;
    serde_json::to_writer_pretty(&mut archive, &value["capabilities"])?;
    let file = archive.finish()?;
    file.as_file().sync_all()?;
    let path = directory.join(format!("dsh-diagnostics-{}.zip", uuid::Uuid::new_v4()));
    file.persist_noclobber(&path).map_err(|e| e.error)?;
    Ok(path)
}

const LOG_BYTES: u64 = 2 * 1024 * 1024;
const LOG_FILES: usize = 5;
fn append_record(directory: &Path, source: &str, code: &str) -> io::Result<()> {
    if ![source, code].iter().all(|s| s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "diagnostics-code")); }
    std::fs::create_dir_all(directory)?;
    let path = directory.join("diagnostics.jsonl");
    let line = serde_json::to_vec(&serde_json::json!({"time":crate::maintenance::now_ms(), "level":"info", "source":source, "code":code}))?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 + 1 > LOG_BYTES {
        let oldest = directory.join(format!("diagnostics.{}.jsonl", LOG_FILES - 1));
        match std::fs::remove_file(oldest) { Ok(_) => {}, Err(e) if e.kind() == io::ErrorKind::NotFound => {}, Err(e) => return Err(e) }
        for index in (1..LOG_FILES).rev() {
            let from = if index == 1 { path.clone() } else { directory.join(format!("diagnostics.{}.jsonl", index - 1)) };
            let to = directory.join(format!("diagnostics.{index}.jsonl"));
            match std::fs::rename(from, to) { Ok(_) => {}, Err(e) if e.kind() == io::ErrorKind::NotFound => {}, Err(e) => return Err(e) }
        }
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)?;
    file.write_all(b"\n")?;
    Ok(())
}
pub fn record(app: &AppHandle, source: &str, code: &str) {
    let Some(service) = app.try_state::<Diagnostics>() else { return };
    let Ok(_guard) = service.log.lock() else { return };
    if let Some(root) = data_root(app) { let _ = append_record(&root.join("diagnostics"), source, code); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_is_parseable_and_default_export_has_no_raw_log_or_paths() {
        let directory = tempfile::tempdir().unwrap();
        let mut value = serde_json::json!({"phase":{"kind":"failed","message":"secret chat"},"nodePath":"C:\\Users\\Alice", "capabilities":[], "omittedRawLogLines":10});
        crate::redaction::report(&mut value);
        let path = export(directory.path(), &value).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
        let value: serde_json::Value = serde_json::from_reader(zip.by_name("report.json").unwrap()).unwrap();
        assert_eq!(value["omittedRawLogLines"], 10);
        assert!(!value.to_string().contains("secret chat"));
    }
    #[test]
    fn structured_log_rotates_and_refuses_untrusted_output() {
        let directory = tempfile::tempdir().unwrap();
        for _ in 0..8 {
            std::fs::write(directory.path().join("diagnostics.jsonl"), vec![b'x'; LOG_BYTES as usize]).unwrap();
            append_record(directory.path(), "backend", "backend-exited").unwrap();
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), LOG_FILES);
        assert!(append_record(directory.path(), "backend", "token=private").is_err());
        assert!(std::fs::metadata(directory.path().join("diagnostics.jsonl")).unwrap().len() < LOG_BYTES);
    }
}
