//! Portable archive primitives. Only validated, private staging is exposed;
//! writing active data roots belongs to the multi-component restore transaction.
pub mod format;
pub mod transaction;
pub mod restore;
mod profile_lock;
pub use restore::RestoreManager;
pub(crate) use restore::{acknowledge,rollback_pending,recover_interrupted,smoke_ui_failure,expects_profile};
use std::{path::PathBuf, process::Command};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use zeroize::Zeroizing;
use crate::{maintenance::{Kind, Stage}, remote_control::Identity, state::Shared};

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Capture { schema: u32, components: Vec<Captured>, excluded: Vec<Excluded>, #[serde(default)] profile_binding: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Captured { id: String, schema: u32, size: u64, sha256: String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Excluded { id: String, reason_code: String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Preview { pub manifest: format::Manifest, pub supported_components: Vec<String>, pub unsupported_components: Vec<String>, pub can_restore: bool, pub reason_code: &'static str, pub restore_handle:Option<uuid::Uuid>, pub expires_at:Option<u64> }
fn known(id: &str) -> bool { matches!(id,"desktop-preferences" | "plugin-intent" | "profile-plugins") }
fn authorize(window: &WebviewWindow, identity: Option<Identity>) -> Result<(), String> {
    if !matches!(window.label(),"main" | "diagnostics") { return Err("backup-origin".into()); }
    if crate::ui_snapshot::is_app_document(window.app_handle(), &window.url().map_err(|_| "backup-origin")?) { return Ok(()); }
    crate::remote_control::caller(window, identity.ok_or("backup-identity")?).map_err(|e| e.message)
}
/// Independent, structured config snapshots; never advertised as a consistent
/// whole-root backup. No backend stop or business files enter this command.
#[tauri::command]
pub async fn desktop_backup_export(window: WebviewWindow, identity: Identity, components: Vec<String>, password: Option<String>) -> Result<Option<String>, String> {
    crate::remote_control::caller(&window,identity).map_err(|e| e.message)?;
    if components.is_empty() || components.len() > 3 || components.iter().any(|id| !known(id))
        || components.iter().collect::<std::collections::HashSet<_>>().len() != components.len() { return Err("backup-component-selection".into()); }
    let password = password.map(Zeroizing::new);
    if password.as_ref().is_some_and(|p| p.is_empty() || p.len() > 1024) { return Err("backup-password-invalid".into()); }
    let app = window.app_handle().clone();
    let page = window.url().map_err(|_| "backup-origin")?;
    let owner = window.hwnd().map_err(|_| "backup-window")?.0 as usize;
    let destination = tauri::async_runtime::spawn_blocking(move || crate::directory_picker::pick_directory(owner,"Backup / 备份","Save / 保存"))
        .await.map_err(|_| "backup-dialog")?.map_err(|_| "backup-dialog")?;
    let Some(destination) = destination else { return Ok(None); };
    crate::remote_control::caller(&window,identity).map_err(|e| e.message)?;
    if window.url().map_err(|_| "backup-origin")? != page { return Err("backup-stale-document".into()); }
    let lease = app.state::<crate::maintenance::MaintenanceCoordinator>().begin(Kind::Backup)?;
    let (runtime, roots) = {
        let shared = app.state::<Shared>(); let state = shared.lock().map_err(|_| "backup-state")?;
        if state.ui.busy() || state.remote.applying || state.boot_in_progress { return Err("maintenance-busy".into()); }
        let storage = state.storage.as_ref().filter(|s| s.backend_instance == state.ui.backend_instance && crate::maintenance::now_ms().saturating_sub(s.observed_at) < 120_000).ok_or("backup-provider-unavailable")?;
        (state.runtime.clone().ok_or("backup-provider-unavailable")?,storage.roots.clone())
    };
    let helper = crate::patch_file(&app)?.parent().ok_or("backup-provider-unavailable")?.join("desktop-maintenance/providers.mjs");
    tauri::async_runtime::spawn_blocking(move || {
        let lease = lease.durable(&app)?; let progress = lease.progress();
        progress.update(Stage::Capturing,"structured-capture-started")?;
        let result = export_components(&runtime,&roots,&helper,&destination,&components,password.as_deref().map(|p| p.as_str()));
        match result {
            Ok(path) => { progress.update(Stage::Complete,"backup-published")?; Ok(Some(path.to_string_lossy().into_owned())) },
            Err(code) => { let _ = progress.failed(&code); Err(code) },
        }
    }).await.map_err(|_| "backup-worker")?
}
fn export_components(runtime: &crate::dsh::Runtime, roots: &crate::data_inventory::ProviderRoots, helper: &std::path::Path, destination: &std::path::Path, selected: &[String], password: Option<&str>) -> Result<PathBuf,String> {
    let staging = tempfile::tempdir().map_err(|_| "backup-staging")?;
    let request = staging.path().join("request.json");
    crate::maintenance::atomic_json(&request,&serde_json::json!({"roots":{"desktopPreferences":roots.desktop_preferences,"pluginIntent":roots.plugin_intent,"profileSwitches":roots.profile_switches},"components":selected,"staging":staging.path()})).map_err(|_| "backup-staging")?;
    let mut command = Command::new(&runtime.node_exe);
    command.arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(&request));
    let result = crate::dsh_update::output(&mut command,"backup-provider",std::time::Duration::from_secs(15)).map_err(|_| "backup-provider-failed")?;
    let captured: Capture = serde_json::from_str(&result).map_err(|_| "backup-provider-invalid")?;
    if captured.schema != 1 || captured.components.len() > 3 || captured.excluded.len() > 3 || captured.components.is_empty() { return Err("backup-provider-empty".into()); }
    let mut manifest = format::Manifest {format_version:1,backup_id:uuid::Uuid::new_v4(),created_at:crate::maintenance::now_ms(),desktop_version:env!("CARGO_PKG_VERSION").into(),
        dsh_version:runtime.version.clone().ok_or("backup-provider-unavailable")?,architecture:std::env::consts::ARCH.into(),source_data_schema:None,profile:"web".into(),scope:"partial".into(),
        credential_policy:"exclude-credentials".into(),encrypted:password.is_some(),components:vec![],
        excluded:vec!["sessions".into(),"attachments".into(),"upstream-settings".into(),"changes".into(),"drafts".into(),"credentials".into(),"workspace-source".into()],
        warnings:vec!["independent-component-snapshots".into(),"full-storage-consistency-unverified".into()]};
    let mut sources = Vec::new();
    for component in captured.components {
        if !known(&component.id) || !selected.contains(&component.id) || component.schema != 1 { return Err("backup-provider-invalid".into()); }
        let path = format!("components/{}/data.json",component.id);
        sources.push(format::Source {path:path.clone(),file:staging.path().join(format!("{}.json",component.id))});
        manifest.components.push(format::Component {id:component.id.clone(),provider:component.id.clone(),schema:1,logical_target:component.id,
            files:vec![format::Entry {path,size:component.size,sha256:component.sha256}]});
    }
    for excluded in captured.excluded {
        if !known(&excluded.id) || !selected.contains(&excluded.id) || !matches!(excluded.reason_code.as_str(),"backup-provider-empty" | "backup-provider-unavailable") { return Err("backup-provider-invalid".into()); }
        manifest.excluded.push(excluded.id);
    }
    for id in ["desktop-preferences","plugin-intent","profile-plugins"] {
        if !manifest.components.iter().any(|c| c.id == id) && !manifest.excluded.iter().any(|e| e == id) { manifest.excluded.push(id.into()); }
    }
    format::write(destination,&manifest,&sources,password).map_err(|e| {
        let code = e.to_string(); if code.starts_with("backup-") && code.len() < 160 { code } else {"backup-export-failed".into()}
    })
}
#[tauri::command]
pub async fn desktop_backup_inspect(window: WebviewWindow, identity: Option<Identity>, password: Option<String>) -> Result<Option<Preview>, String> {
    authorize(&window,identity)?;
    let password = password.map(Zeroizing::new);
    if password.as_ref().is_some_and(|p|p.is_empty()||p.len()>1024) {return Err("backup-password-invalid".into())}
    let page = window.url().map_err(|_| "backup-origin")?;
    let owner = window.hwnd().map_err(|_| "backup-window")?.0 as usize;
    let source = tauri::async_runtime::spawn_blocking(move || crate::directory_picker::pick_file(owner,"Backup / 备份","Open / 打开"))
        .await.map_err(|_| "backup-dialog")?.map_err(|_| "backup-dialog")?;
    let Some(source) = source else {return Ok(None)};
    authorize(&window,identity)?;
    if window.url().map_err(|_| "backup-origin")? != page {return Err("backup-stale-document".into())}
    let app: AppHandle = window.app_handle().clone();
    let lease = app.state::<crate::maintenance::MaintenanceCoordinator>().begin(Kind::Restore)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let verified = format::verify(&source,password.as_deref().map(|p| p.as_str())).map_err(|e| {
            let code=e.to_string(); if code.starts_with("backup-") && code.len()<160 {code} else {"backup-invalid".into()}
        })?;
        restore::preview(&app,&window,identity,verified).map(Some)
    }).await.map_err(|_| "backup-worker")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_node_provider_exports_filtered_selected_components_only() {
        let Some(node_exe) = crate::dsh::resolve_node() else {return};
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("desktop-settings.json");
        let saved = r#"{"version":1,"namespaces":{"desktop-appearance":{"ui":"vanilla","apiKey":"private-secret"},"other":{"token":"private-secret"}}}"#;
        std::fs::write(&file,saved).unwrap();
        let bad = root.path().join("plugins.json"); std::fs::write(&bad,"invalid").unwrap();
        let roots = crate::data_inventory::ProviderRoots {schema:1,profile_home:root.path().into(),profile_directory:root.path().into(),session_root:root.path().into(),session_schema:Some(4),
            session_flush:true,attachment_root:None,install_anchor:root.path().join("package.json"),desktop_preferences:Some(file.clone()),plugin_intent:Some(bad),profile_switches:None,
            upstream_settings:None,credential_classification:None};
        let runtime = crate::dsh::Runtime {node_exe,dsh_bin:root.path().join("bin.js"),source:crate::dsh::DshSource::Configured,version:Some("0.2.1-rc.2".into()),managed:None};
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dsh-plugin/desktop-maintenance/providers.mjs");
        let path = export_components(&runtime,&roots,&helper,root.path(),&["desktop-preferences".into()],None).unwrap();
        let verified = format::verify(&path,None).unwrap();
        assert_eq!(verified.manifest.scope,"partial");
        assert!(verified.manifest.excluded.iter().any(|id| id == "plugin-intent"));
        let text = std::fs::read_to_string(verified.file("components/desktop-preferences/data.json").unwrap()).unwrap();
        assert!(text.contains("vanilla")); assert!(!text.contains("private-secret"));
        assert_eq!(std::fs::read_to_string(file).unwrap(),saved);
    }
}
