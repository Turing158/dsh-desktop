//! Two-phase upgrade: prepare while usable, checkpoint after durable shutdown,
//! then commit selection only after the new desktop acknowledges UI restoration.
use crate::{
    dsh::Runtime,
    maintenance::Stage,
    state::Shared,
    ui_snapshot::{UiPhase, UiSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
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
    ui_checkpoint: uuid::Uuid,
    selection: Option<serde_json::Value>,
}
struct Active {
    record: Record,
    config: crate::remote_control::Config,
}
pub fn progress(app: &AppHandle, step: &str) {
    let manager = app.state::<ManagerState>();
    let value = if let Ok(mut slot) = manager.status.lock() {
        let now = crate::maintenance::now_ms();
        let new_attempt = step == "installing" || (step == "verifying" && slot.as_ref().is_some_and(|v|
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
pub async fn install(
    window: WebviewWindow,
    identity: crate::remote_control::Identity,
    payload: crate::ui_snapshot::UiPayload,
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
        let (roots, config, ui_identity) = {
            let mut s = shared.lock().map_err(|_| "runtime-state")?;
            if s.remote.applying
                || s.boot_in_progress
                || s.ui.phase != UiPhase::Active
                || s.ui.snapshot.is_some()
            {
                return Err("maintenance-busy".into());
            }
            crate::dsh_update::require_idle(&s)?;
            if s.runtime.as_ref().map(|r| &r.dsh_bin) != Some(&source.dsh_bin)
                || payload.frontend_version != source.version.as_deref().unwrap_or("")
            {
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
            (roots, config, s.ui.identity())
        };
        let guard = crate::remote_control::ApplyingGuard(shared.clone());
        progress(&app, "verifying");
        lease.progress().update(Stage::Preparing,"candidate-verification-started")?;
        crate::runtime_store::verify_candidate(&app, &target)?;
        progress(&app, "checking-data");
        lease.progress().update(Stage::Preparing,"data-contract-check-started")?;
        contract(&app, &source, &target, &roots)?;
        let mut snapshot = UiSnapshot::capture(payload, ui_identity)?;
        let recovery = crate::recovery_store::persist(&app, &snapshot)?;
        snapshot.restore_frontend_version = target.version.clone();
        let journal = lease.progress();
        journal.target(&target_version)?;
        journal.checkpoint(
            recovery.id,
            source
                .version
                .as_deref()
                .ok_or("runtime-version-unavailable")?,
        )?;
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
                snapshot.restore_frontend_version = source.version.clone();
                {
                    let mut s = shared.lock().map_err(|_| "runtime-state")?;
                    s.ui.recovery = Some(recovery);
                    s.ui.snapshot = Some(Arc::new(snapshot));
                    s.ui.recovery_lease = Some(lease.into_lease());
                    s.ui.loaded = false;
                    s.ui.transition(UiPhase::Restoring);
                }
                clear_prepared(&app);
                let _ = journal.update(Stage::RolledBack, "source-exited-before-checkpoint");
                progress(&app, "rolled-back");
                std::thread::spawn(move || {
                    let _guard = guard;
                    crate::restart_backend(&app, &shared, source, config);
                });
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
            s.ui.recovery = Some(recovery.clone());
            s.ui.snapshot = Some(Arc::new(snapshot));
            s.ui.recovery_lease = Some(lease.into_lease());
            s.ui.loaded = false;
            s.ui.transition(UiPhase::Restoring);
            s.update_presentation = Some(crate::boot_bar::UpdatePresentation { palette });
        }
        // From here onward the native host owns recovery, including failures
        // before a candidate process can be launched.
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
                ui_checkpoint: recovery.id,
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
                restore_snapshot_version(&shared, &source);
                let _ = journal.update(Stage::RolledBack, "checkpoint-failed-source-retained");
                progress(&app, "rolled-back");
                crate::restart_backend(&app, &shared, source, config);
            }
            drop(guard);
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
fn restore_snapshot_version(shared: &Shared, source: &Runtime) {
    if let Ok(mut s) = shared.lock() {
        if let Some(snapshot) = s.ui.snapshot.as_ref() {
            if let Ok(mut restored) = snapshot
                .wire()
                .and_then(|w| UiSnapshot::capture(w.payload, snapshot.source))
            {
                restored.restore_frontend_version = source.version.clone();
                s.ui.snapshot = Some(Arc::new(restored));
            }
        }
    }
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
pub fn acknowledge(app: &AppHandle, checkpoint: uuid::Uuid) -> Result<(), String> {
    let manager = app.state::<ManagerState>();
    let mut slot = manager.active.lock().map_err(|_| "runtime-state")?;
    let Some(active) = slot.as_mut() else {
        return Ok(());
    };
    if active.record.ui_checkpoint != checkpoint {
        return Err("update-checkpoint-binding".into());
    }
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
    let journal={
        let shared=app.state::<Shared>();let state=shared.lock().map_err(|_|"runtime-state")?;
        state.ui.recovery_lease.as_ref().map(|lease|lease.progress())
    };
    if let Some(journal)=journal {
        journal.update(Stage::Committing,"candidate-commit-started")?;
    }
    crate::runtime_store::commit_update(app, &active.record.target, &active.record.source)?;
    let recovery = app
        .state::<Shared>()
        .lock()
        .map_err(|_| "runtime-state")?
        .ui
        .recovery
        .clone()
        .ok_or("update-checkpoint-binding")?;
    crate::recovery_store::store(app)?
        .permit_version(
            &recovery,
            active
                .record
                .target
                .version
                .as_deref()
                .ok_or("runtime-version-unavailable")?,
        )
        .map_err(|_| "update-recovery-save-failed")?;
    active.record.stage = "committed".into();
    save(app, &active.record)?;
    {
        let shared = app.state::<Shared>();
        let mut s = shared.lock().map_err(|_| "runtime-state")?;
        if let Some(m) = s.runtime.as_mut().and_then(|r| r.managed.as_mut()) {
            m.committed = true;
        }
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
        let (process, journal) = {
            let Ok(mut s) = shared.lock() else { return };
            if s.ui.phase == UiPhase::Exiting {
                return;
            }
            s.remote.applying = true;
            s.ui.backend_instance += 1;
            s.remote.active = None;
            s.ui.loaded = false;
            (
                s.process.take(),
                s.ui.recovery_lease.as_ref().map(|l| l.progress()),
            )
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
            if let Some(p) = journal {
                let _ = p.failed("update-rollback-failed");
            }
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
        restore_snapshot_version(&shared, &active.record.source);
        clear_prepared(&app);
        if let Some(p) = journal {
            let _ = p.update(Stage::RolledBack, "data-and-runtime-rolled-back");
        }
        progress(&app, "rolled-back");
        crate::restart_backend(&app, &shared, active.record.source, active.config);
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
