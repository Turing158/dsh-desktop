//! Two-phase upgrade: prepare while usable, checkpoint after durable shutdown,
//! then commit selection once the new backend is ready. Updates do not save UI state.
use crate::{
    dsh::Runtime,
    maintenance::Stage,
    state::Shared,
    ui_snapshot::UiPhase,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub step: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct ManagerState {
    status: Mutex<Option<Status>>,
    prepared: Mutex<Option<(crate::remote_control::Identity, Runtime, Runtime)>>,
    active: Mutex<Option<Active>>,
}
impl ManagerState {
    pub fn is_updating(&self) -> bool {
        self.active.lock().is_ok_and(|s| s.is_some())
    }
}
pub(crate) fn prepared_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let manager = app.state::<ManagerState>();
    let prepared = manager.prepared.lock().map_err(|_| "runtime-cleanup-state")?;
    Ok(prepared.as_ref().map(|(_, source, target)| vec![source.dsh_bin.clone(), target.dsh_bin.clone()]).unwrap_or_default())
}
pub(crate) fn clear_prepared(app: &AppHandle) {
    if let Ok(mut prepared) = app.state::<ManagerState>().prepared.lock() { *prepared = None; }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u32,
    stage: String,
    source: Runtime,
    target: Runtime,
    checkpoint: crate::update_checkpoint::Checkpoint,
    // Read and discard the deprecated field; new records never store UI state.
    #[serde(default, skip_serializing, rename = "ui_checkpoint")]
    _legacy_ui_checkpoint: Option<serde::de::IgnoredAny>,
    selection: Option<serde_json::Value>,
}
struct Active {
    record: Record,
    config: crate::remote_control::Config,
    lease: crate::maintenance::Lease,
}
pub fn progress(app: &AppHandle, step: &str) {
    let manager = app.state::<ManagerState>();
    let value = if let Ok(mut slot) = manager.status.lock() {
        let now = crate::maintenance::now_ms();
        let new_attempt = step == "checking-recovery" || step == "installing" || (step == "verifying" && slot.as_ref().is_some_and(|v|
            matches!(v.step.as_str(), "rolled-back" | "complete" | "cancelled" | "failed")));
        let started = if new_attempt {
            now
        } else {
            slot.as_ref().map(|v| v.started_at).unwrap_or(now)
        };
        *slot = Some(Status {
            step: step.into(),
            started_at: started,
            updated_at: now,
            error: if new_attempt { None } else { slot.as_ref().and_then(|v| v.error.clone()) },
        });
        slot.clone()
    } else {
        None
    };
    // Push progress and its local failure reason through the existing document
    // as its backend origin is retired; polling cannot cover that navigation.
    if let (Some(value), Some(window)) = (value, app.get_webview_window("main")) {
        if let Ok(json) = serde_json::to_string(&value) {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('dsh-update-progress',{{detail:{json}}}))"
            ));
        }
    }
}
pub fn failure(app: &AppHandle, error: &str) {
    crate::debug_log(&format!("[update] {error}"));
    if let Ok(mut slot) = app.state::<ManagerState>().status.lock() {
        if let Some(status) = slot.as_mut() {
            if status.error.is_none() { status.error = Some(error.into()); }
        }
    }
}
#[tauri::command]
pub fn dsh_update_progress(window: WebviewWindow) -> Result<Option<Status>, String> {
    crate::window_controls::validate_window(&window)?;
    let manager = window.state::<ManagerState>();
    let value = manager.status.lock().map_err(|_| "runtime-state")?.clone();
    Ok(value)
}
pub fn prepared(
    app: &AppHandle,
    identity: crate::remote_control::Identity,
    source: Runtime,
    target: Runtime,
) -> Result<(), String> {
    *app.state::<ManagerState>()
        .prepared
        .lock()
        .map_err(|_| "runtime-state")? = Some((identity, source, target));
    Ok(())
}
fn record_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::runtime_store::directory(app)?.join("update.json"))
}
fn save(app: &AppHandle, record: &Record) -> Result<(), String> {
    crate::maintenance::atomic_json(&record_path(app)?, record)
        .map_err(|_| "update-record-save-failed".into())
}
fn inventory(
    app: &AppHandle,
    runtime: &Runtime,
) -> Result<crate::data_inventory::ResolvedRoots, String> {
    let helper = crate::patch_file(app)?
        .parent()
        .ok_or("runtime-helper-missing")?
        .join("desktop-maintenance/inventory.mjs");
    crate::data_inventory::DataInventory::probe(runtime, None, &helper)?
        .roots
        .ok_or("update-data-roots-unavailable".into())
}
fn contract(
    app: &AppHandle,
    source: &Runtime,
    target: &Runtime,
    roots: &crate::data_inventory::ProviderRoots,
) -> Result<(), String> {
    let a = inventory(app, source)?;
    let b = inventory(app, target)?;
    if !roots.valid()
        || !roots.session_flush
        || roots.session_schema != Some(4)
        || a.data_root != roots.profile_home
        || b.data_root != roots.profile_home
        || a.profile_directory.as_ref() != Some(&roots.profile_directory)
        || b.profile_directory != a.profile_directory
    {
        return Err("update-data-layout-unsupported".into());
    }
    for path in [&roots.profile_directory, &roots.session_root]
        .into_iter()
        .chain(roots.attachment_root.iter())
        .chain(roots.upstream_settings.iter())
        .chain(roots.desktop_preferences.iter())
    {
        if !path.starts_with(&roots.profile_home) {
            return Err("update-data-outside-home".into());
        }
    }
    crate::update_checkpoint::plain_root(&roots.profile_home)
        .map_err(|_| "update-data-linked-path")?;
    // This release supports the upstream v4 session contract. Unknown schema
    // migrations fail before shutdown instead of guessing at persisted data.
    let script="const{createRequire}=require('node:module');const{pathToFileURL}=require('node:url');const r=createRequire(process.argv[1]);import(pathToFileURL(r.resolve('@deepseek-ai/dsh-session')).href).then(m=>process.stdout.write(String(m.SESSION_FORMAT_VERSION)))";
    let mut command = std::process::Command::new(&target.node_exe);
    command.args(["-e", script]).arg(&target.dsh_bin);
    if crate::dsh_update::output(
        &mut command,
        "update-schema",
        std::time::Duration::from_secs(20),
    )?
    .trim()
        != "4"
    {
        return Err("update-session-schema-unsupported".into());
    }
    Ok(())
}
// Preserve safe error codes and the exact failed step before returning to the
// page. Child-process output may contain private paths; journal only a fallback.
fn preparation_step<T>(journal:&crate::maintenance::Progress, step:&str, fallback:&str,
    action:impl FnOnce()->Result<T,String>)->Result<T,String> {
    journal.update(Stage::Preparing,step)?;
    action().map_err(|error| {
        let code=if ["recovery-","runtime-","update-","snapshot-"].iter().any(|prefix|error.starts_with(prefix))
            && error.len()<=160 && error.bytes().all(|b|b.is_ascii_lowercase() || b==b'-') {error.as_str()} else {fallback};
        let _=journal.failed(code);
        error
    })
}
#[cfg(test)]
mod preparation_tests {
    use super::*;
    fn update_record(stage: &str) -> serde_json::Value {
        let runtime = serde_json::json!({"node_exe":"node.exe", "dsh_bin":"dsh/bin.js",
            "source":"configured", "version":"0.2.2"});
        serde_json::json!({"schema":1, "stage":stage, "source":runtime, "target":runtime,
            "checkpoint":{"home":"profile", "saved":"profile-before", "failed":"profile-failed", "files":[]},
            "selection":null})
    }
    #[test]
    fn old_and_new_update_records_load_without_serializing_ui_state() {
        for stage in ["pending", "committed", "rolled-back"] {
            for legacy in [None, Some(serde_json::Value::Null), Some(serde_json::json!(uuid::Uuid::new_v4()))] {
                let mut value = update_record(stage);
                if let Some(legacy) = legacy { value["ui_checkpoint"] = legacy; }
                let record: Record = serde_json::from_value(value).unwrap();
                assert_eq!(record.schema, 1);
                assert_eq!(record.stage, stage);
                assert!(serde_json::to_value(record).unwrap().get("ui_checkpoint").is_none());
            }
        }
    }
    #[test]
    fn legacy_compatibility_does_not_accept_unknown_or_missing_transaction_fields() {
        let mut unknown = update_record("committed");
        unknown["unexpected"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Record>(unknown).is_err());
        let mut missing = update_record("committed");
        missing.as_object_mut().unwrap().remove("checkpoint");
        assert!(serde_json::from_value::<Record>(missing).is_err());
    }
    #[test]
    #[ignore = "read-only check; set DSH_LEGACY_UPDATE_RECORD to an existing update.json"]
    fn existing_legacy_update_record_loads_without_rewriting() {
        let path = std::env::var_os("DSH_LEGACY_UPDATE_RECORD").expect("DSH_LEGACY_UPDATE_RECORD");
        let bytes = std::fs::read(&path).unwrap();
        let record: Record = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record.schema, 1);
        assert!(matches!(record.stage.as_str(), "pending" | "committed" | "rolled-back"));
        assert!(serde_json::to_value(record).unwrap().get("ui_checkpoint").is_none());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn failed_preparation_records_the_real_stage_and_error_without_private_output() {
        for (error,expected) in [("update-data-layout-unsupported","update-data-layout-unsupported"),
            ("runtime-candidate-binding","runtime-candidate-binding"),("disk failure at private path","update-data-check-failed")] {
            let coordinator=crate::maintenance::MaintenanceCoordinator::default();
            let lease=coordinator.begin(crate::maintenance::Kind::Update).unwrap();let journal=lease.progress();
            journal.target("0.2.2-rc.3").unwrap();
            preparation_step(&journal,"data-contract-check-started","update-data-check-failed",||Ok(())).unwrap();
            let result:Result<(),String>=preparation_step(&journal,"data-contract-check-started","update-data-check-failed",||Err(error.into()));
            assert_eq!(result.unwrap_err(),error);
            let record=coordinator.status().unwrap();
            assert_eq!(record.stage,Stage::RecoveryRequired);
            assert_eq!(record.error_code.as_deref(),Some(expected));
            assert_eq!(record.completed_steps.last().map(String::as_str),Some("data-contract-check-started"));
            assert_eq!(record.target_runtime.as_deref(),Some("0.2.2-rc.3"));
            let dir=tempfile::tempdir().unwrap();record.save(dir.path()).unwrap();
            assert_eq!(crate::maintenance::OperationJournal::load(&dir.path().join(format!("{}.json",record.operation_id))).unwrap().error_code,record.error_code);
        }
    }
    #[test]
    fn runtime_commit_finishes_without_a_ui_checkpoint_or_restore() {
        let coordinator=crate::maintenance::MaintenanceCoordinator::default();
        let lease=coordinator.begin(crate::maintenance::Kind::Update).unwrap();
        let journal=lease.progress();
        journal.update(Stage::Committing,"backend-ready").unwrap();
        journal.complete_update().unwrap();
        let record=coordinator.status().unwrap();
        assert_eq!(record.stage,Stage::Complete);
        assert_eq!(record.checkpoint_id,None);
        assert_eq!(record.completed_steps,vec!["backend-ready","runtime-committed"]);
        assert!(record.recovery_actions.is_empty());
    }
}
pub async fn install(
    window: WebviewWindow,
    identity: crate::remote_control::Identity,
    palette: Option<crate::boot_bar::Palette>,
    target_version: String,
    candidate_id: String,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let shared = app.state::<Shared>().inner().clone();
    let lease = app
        .state::<crate::dsh_update::UpdateManager>()
        .begin()?
        .durable(&app)?;
    let (source, target) = {
        let manager = app.state::<ManagerState>();
        let slot = manager.prepared.lock().map_err(|_| "runtime-state")?;
        let (owner, source, target) = slot.as_ref().ok_or("update-candidate-required")?;
        if *owner != identity
            || target.version.as_deref() != Some(&target_version)
            || target.managed.as_ref().map(|m| m.id.as_str()) != Some(&candidate_id)
        {
            return Err("runtime-candidate-stale".into());
        }
        (source.clone(), target.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (roots, config) = {
            let mut s = shared.lock().map_err(|_| "runtime-state")?;
            if s.remote.applying
                || s.boot_in_progress
                || s.ui.phase != UiPhase::Active
                || s.ui.snapshot.is_some()
            {
                return Err("maintenance-busy".into());
            }
            crate::dsh_update::require_idle(&s)?;
            if s.runtime.as_ref().map(|r| &r.dsh_bin) != Some(&source.dsh_bin) {
                return Err("runtime-candidate-stale".into());
            }
            let roots = s
                .storage
                .as_ref()
                .filter(|v| v.backend_instance == identity.backend_instance)
                .ok_or("update-data-roots-unavailable")?
                .roots
                .clone();
            let config = s.remote.active.clone().ok_or("runtime-unavailable")?;
            s.remote.applying = true;
            (roots, config)
        };
        let guard = crate::remote_control::ApplyingGuard(shared.clone());
        let journal = lease.progress();
        journal.target(&target_version)?;
        (|| {
        progress(&app, "verifying");
        preparation_step(&journal,"candidate-verification-started","update-candidate-verification-failed",
            ||crate::runtime_store::verify_candidate(&app, &target))?;
        progress(&app, "checking-data");
        preparation_step(&journal,"data-contract-check-started","update-data-check-failed",
            ||contract(&app, &source, &target, &roots))?;
        Ok::<_,String>(())
        })().map_err(|error| {failure(&app,&error);progress(&app,"failed");error})?;
        let selection_path = crate::runtime_store::directory(&app)?.join("selection.json");
        let selection = match std::fs::read(&selection_path) {
            Ok(bytes) => {
                Some(serde_json::from_slice(&bytes).map_err(|_| "runtime-selection-invalid")?)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("runtime-selection-invalid".into()),
        };
        crate::remote_control::caller(&window, identity).map_err(|e| e.message)?;
        journal.update(Stage::Capturing,"session-flush-started")?;
        let mut process = {
            let mut s = shared.lock().map_err(|_| "runtime-state")?;
            crate::dsh_update::require_idle(&s)?;
            s.ui.backend_instance += 1;
            s.remote.active = None;
            s.process.take().ok_or("runtime-unavailable")?
        };
        progress(&app, "saving-sessions");
        if let Err(error) = process.stop_for_update() {
            failure(&app, &error);
            let _ = journal.failed("update-flush-failed");
            if !process.is_running() {
                drop(process);
                {
                    let mut s = shared.lock().map_err(|_| "runtime-state")?;
                    s.ui.loaded = false;
                }
                clear_prepared(&app);
                let _ = journal.update(Stage::RolledBack, "source-exited-before-checkpoint");
                progress(&app, "rolled-back");
                crate::restart_backend(&app, &shared, source, config);
                return Ok(());
            }
            let mut s = shared.lock().map_err(|_| "runtime-state")?;
            s.process = Some(process);
            s.ui.backend_instance = identity.backend_instance;
            s.remote.active = Some(config);
            drop(s);
            let _ = journal.failed("update-flush-failed");
            progress(&app, "failed");
            return Err(error);
        }
        drop(process);
        {
            let mut s = shared.lock().map_err(|_| "runtime-state")?;
            s.ui.loaded = false;
            s.update_presentation = Some(crate::boot_bar::UpdatePresentation { palette });
        }
        // The lease belongs to the update, independently of UI recovery.
        let mut operation_lease = Some(lease.into_lease());
        let outcome = (|| {
            progress(&app, "checkpointing");
            journal.update(Stage::Checkpointing, "data-checkpoint-started")?;
            let manager = app.state::<ManagerState>();
            let mut active = manager.active.lock().map_err(|_| "runtime-state")?;
            let checkpoint = crate::update_checkpoint::Checkpoint::capture(
                &roots.profile_home,
                uuid::Uuid::new_v4(),
            )
            .map_err(|e| e.to_string())?;
            let record = Record {
                schema: 1,
                stage: "pending".into(),
                source: source.clone(),
                target: target.clone(),
                checkpoint,
                _legacy_ui_checkpoint: None,
                selection,
            };
            if let Err(error) = save(&app, &record) {
                if let Err(cleanup) = record.checkpoint.discard_unpublished() {
                    crate::debug_log(&format!("[update] unpublished checkpoint cleanup failed: {cleanup}"));
                }
                return Err(error);
            }
            *active = Some(Active {
                record,
                config: config.clone(),
                lease: operation_lease.take().ok_or("maintenance-stale")?,
            });
            drop(active);
            journal.update(Stage::StartingCandidate, "candidate-starting")?;
            progress(&app, "starting");
            Ok::<_, String>(())
        })();
        if let Err(error) = outcome {
            failure(&app, &error);
            let _ = journal.failed("update-checkpoint-failed");
            if !rollback_pending(&app) {
                clear_prepared(&app);
                let _ = journal.update(Stage::RolledBack, "checkpoint-failed-source-retained");
                progress(&app, "rolled-back");
                crate::restart_backend(&app, &shared, source, config);
            }
            drop(guard);
            drop(operation_lease);
            crate::runtime_cleanup::schedule(&app);
            return Ok(());
        }
        std::thread::spawn(move || {
            let _guard = guard;
            crate::restart_backend(&app, &shared, target, config);
        });
        Ok(())
    })
    .await
    .map_err(|_| "update-worker")?
}
fn restore_selection(app: &AppHandle, record: &Record) -> Result<(), String> {
    let path = crate::runtime_store::directory(app)?.join("selection.json");
    if let Some(selection) = &record.selection {
        crate::maintenance::atomic_json(&path, selection)
            .map_err(|_| "runtime-selection-save-failed")?;
    } else if path.exists() {
        std::fs::remove_file(path).map_err(|_| "runtime-selection-save-failed")?;
    }
    Ok(())
}
fn cleanup_committed(app: &AppHandle, record: &Record) {
    if record.stage != "committed" { return; }
    // Cleanup is best effort after commit. A locked file must never turn a
    // successful upgrade into rollback; the committed record enables retry.
    match record.checkpoint.cleanup_obsolete() {
        Ok(removed) => crate::debug_log(&format!("[update] removed {removed} obsolete checkpoint directories")),
        Err(error) => {
            crate::debug_log(&format!("[update] checkpoint cleanup will retry on startup: {error}"));
            crate::diagnostics::record(app, "update", "checkpoint-cleanup-failed");
        }
    }
}
pub fn commit_ready(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<ManagerState>();
    let mut slot = manager.active.lock().map_err(|_| "runtime-state")?;
    let Some(active) = slot.as_mut() else {
        return Ok(());
    };
    {
        let shared = app.state::<Shared>();
        let s = shared.lock().map_err(|_| "runtime-state")?;
        if s.runtime.as_ref().map(|r| &r.dsh_bin) != Some(&active.record.target.dsh_bin)
            || s.remote.active.is_none()
        {
            return Err("runtime-candidate-stale".into());
        }
        let roots = s
            .storage
            .as_ref()
            .filter(|r| r.backend_instance == s.ui.backend_instance)
            .ok_or("update-data-roots-unavailable")?;
        if roots.roots.profile_home != active.record.checkpoint.home
            || roots.roots.session_schema != Some(4)
        {
            return Err("update-data-layout-unsupported".into());
        }
    }
    progress(app, "committing");
    let journal = active.lease.progress();
    journal.update(Stage::Committing,"backend-ready")?;
    journal.update(Stage::Committing,"candidate-commit-started")?;
    crate::runtime_store::commit_update(app, &active.record.target, &active.record.source)?;
    // Verification may take time; a backend that exited meanwhile cannot commit.
    {
        let shared = app.state::<Shared>();
        let s = shared.lock().map_err(|_| "runtime-state")?;
        if s.runtime.as_ref().map(|r| &r.dsh_bin) != Some(&active.record.target.dsh_bin)
            || s.remote.active.is_none()
            || s.ui.phase == UiPhase::Exiting
        {
            return Err("runtime-candidate-stale".into());
        }
    }
    active.record.stage = "committed".into();
    save(app, &active.record)?;
    {
        let shared = app.state::<Shared>();
        let mut s = shared.lock().map_err(|_| "runtime-state")?;
        if let Some(m) = s.runtime.as_mut().and_then(|r| r.managed.as_mut()) {
            m.committed = true;
        }
    }
    if journal.complete_update().is_err() {
        crate::diagnostics::record(app, "update", "journal-save-failed");
    }
    cleanup_committed(app, &active.record);
    clear_prepared(app);
    slot.take();
    progress(app, "complete");
    Ok(())
}
pub fn rollback_pending(app: &AppHandle) -> bool {
    let manager = app.state::<ManagerState>();
    let Ok(mut slot) = manager.active.lock() else {
        return false;
    };
    let Some(mut active) = slot.take() else {
        return false;
    };
    drop(slot);
    let app = app.clone();
    std::thread::spawn(move || {
        let shared = app.state::<Shared>().inner().clone();
        let journal = active.lease.progress();
        let process = {
            let Ok(mut s) = shared.lock() else { return };
            if s.ui.phase == UiPhase::Exiting {
                return;
            }
            s.remote.applying = true;
            s.ui.backend_instance += 1;
            s.remote.active = None;
            s.ui.loaded = false;
            s.process.take()
        };
        let _guard = crate::remote_control::ApplyingGuard(shared.clone());
        progress(&app, "rolling-back");
        let result = (|| {
            if let Some(mut process) = process {
                process.stop_and_wait().map_err(|_| "update-backend-stop")?;
            }
            active
                .record
                .checkpoint
                .rollback()
                .map_err(|_| "update-rollback-failed")?;
            restore_selection(&app, &active.record)?;
            active.record.stage = "rolled-back".into();
            save(&app, &active.record)
        })();
        if result.is_err() {
            let _ = journal.failed("update-rollback-failed");
            progress(&app, "failed");
            crate::fail(
                &app,
                &shared,
                "更新回退未完成，旧数据和新版数据均已保留。",
                "请查看故障诊断后重新启动。",
            );
            crate::navigate_current(&app);
            return;
        }
        clear_prepared(&app);
        let _ = journal.update(Stage::RolledBack, "data-and-runtime-rolled-back");
        progress(&app, "rolled-back");
        crate::restart_backend(&app, &shared, active.record.source, active.config);
        drop(active.lease);
        crate::runtime_cleanup::schedule(&app);
    });
    true
}
pub fn recover_interrupted(app: &AppHandle) -> Result<Option<Runtime>, String> {
    let path = record_path(app)?;
    let bytes = match std::fs::read(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("update-record-unavailable".into()),
    };
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("update-record-invalid".into());
    }
    let mut record: Record = serde_json::from_slice(&bytes).map_err(|_| "update-record-invalid")?;
    if record.schema != 1 {
        return Err("update-record-invalid".into());
    }
    if record.stage == "committed" {
        // Also clean legacy committed checkpoints and retry interrupted or
        // locked deletions. Bind the record to today's resolved home first.
        if inventory(app, &record.target).is_ok_and(|roots| roots.data_root == record.checkpoint.home) {
            cleanup_committed(app, &record);
        }
        return Ok(None);
    }
    if record.stage == "rolled-back" {
        return Ok(None);
    }
    if record.stage != "pending"
        || inventory(app, &record.source)?.data_root != record.checkpoint.home
    {
        return Err("update-checkpoint-binding".into());
    }
    record
        .checkpoint
        .rollback()
        .map_err(|_| "update-rollback-failed")?;
    restore_selection(app, &record)?;
    record.stage = "rolled-back".into();
    save(app, &record)?;
    progress(app, "rolled-back");
    Ok(Some(record.source))
}
