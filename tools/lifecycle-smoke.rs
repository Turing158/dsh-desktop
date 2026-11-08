//! Debug-only control for integration tests. Enabled solely by an explicit
//! DSH_DESKTOP_SMOKE_DIR; absent from release builds and from the IPC ACL.
use std::time::Duration;
use tauri::Manager;

// Debug smoke instances must not focus/exit into a user's running desktop.
// Derive a separate single-instance identity from their explicit fixture root.
pub fn isolate(context: &mut tauri::Context<tauri::Wry>) {
    use sha2::{Digest, Sha256};
    let Some(root) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR").map(std::path::PathBuf::from) else { return };
    if !root.is_absolute() || !root.is_dir() { return; }
    let Ok(root) = root.canonicalize() else { return };
    let suffix = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    context.config_mut().identifier.push_str(&format!(".smoke.{}", &suffix[..16]));
}

// Only explicit isolated checks can delay setup to force the preparation-first
// ordering. Never inherited by a release build or an ordinary development run.
pub fn before_window() -> Result<(), Box<dyn std::error::Error>> {
    let isolated = std::env::var_os("DSH_DESKTOP_SMOKE_DIR")
        .map(std::path::PathBuf::from).is_some_and(|root| root.is_absolute() && root.is_dir());
    if !isolated { return Ok(()); }
    if let Some(delay) = std::env::var("DSH_DESKTOP_SMOKE_SETUP_DELAY_MS").ok()
        .and_then(|value| value.parse::<u64>().ok()).filter(|delay| *delay <= 5000) {
        std::thread::sleep(Duration::from_millis(delay));
    }
    if std::env::var("DSH_DESKTOP_SMOKE_SETUP_FAIL").as_deref() == Ok("1") {
        return Err(std::io::Error::other("smoke-setup-failed").into());
    }
    Ok(())
}

pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR").map(std::path::PathBuf::from) else {
        return;
    };
    if !dir.is_absolute() || !dir.is_dir() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            if let Ok(text) = std::fs::read_to_string(dir.join("command.json")) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    let sequence = value["sequence"].as_u64().unwrap_or(0);
                    if sequence > last {
                        last = sequence;
                        match value["action"].as_str() {
                            Some("notify") => {
                                let instance = app.state::<crate::state::Shared>().lock().map(|s| s.ui.backend_instance).unwrap_or(0);
                                if let Ok(payload) = serde_json::from_value::<crate::dsh::NotifyPayload>(value["payload"].clone()) {
                                    crate::deliver(&app, app.state::<crate::state::Shared>().inner(), payload, instance);
                                }
                            }
                            Some("enter") => crate::minimal::set(&app, true),
                            Some("show") => crate::minimal::show(&app),
                            Some("diagnostics") => crate::diagnostics::open(&app),
                            Some("runtime-prepare") => {
                                // Uses the production freeze path, but only from an
                                // explicitly requested isolated debug scenario.
                                let source=value["source"].as_str().map(std::path::PathBuf::from);
                                if let (Some(source),Some(node))=(source,crate::dsh::resolve_node()) {
                                    let result=(|| {
                                        let coordinator=app.state::<crate::maintenance::MaintenanceCoordinator>();
                                        let deadline=std::time::Instant::now()+Duration::from_secs(30);
                                        let _lease=loop {
                                            match coordinator.begin(crate::maintenance::Kind::Install) {
                                                Ok(lease)=>break lease,
                                                Err(error) if std::time::Instant::now()>=deadline=>return Err(error),
                                                Err(_)=>std::thread::sleep(Duration::from_millis(100)),
                                            }
                                        };
                                        let runtime=crate::runtime_store::freeze(&app,&node,&source)?;
                                        crate::runtime_store::remember_first_install(&app,&runtime)?;Ok(runtime)
                                    })();
                                    let json=match result {Ok(runtime)=>serde_json::json!({"runtime":runtime}),Err(error)=>serde_json::json!({"error":error})};
                                    let _=crate::maintenance::atomic_json(&dir.join("runtime-prepared.json"),&json);
                                }
                            }
                            Some("runtime-profile-verify") => {
                                let result=(|| {
                                    let target:crate::dsh::Runtime=serde_json::from_value(value["target"].clone()).map_err(|_|"runtime-profile-target")?;
                                    let overlays=value["overlays"].as_array().ok_or("runtime-profile-overlay-invalid")?.iter()
                                        .map(|v|v.as_str().map(std::path::PathBuf::from).ok_or("runtime-profile-overlay-invalid"))
                                        .collect::<Result<Vec<_>,_>>()?;
                                    let (source,storage)={
                                        let state=app.state::<crate::state::Shared>();
                                        let state=state.lock().map_err(|_|"runtime-state")?;
                                        (state.runtime.clone().ok_or("runtime-unavailable")?,state.storage.clone().ok_or("runtime-profile-storage-unavailable")?)
                                    };
                                    crate::runtime_store::verify_profile(&app,&source,&target,&storage.roots,&overlays)
                                })();
                                let json=match result {Ok(verification)=>serde_json::json!({"verification":verification}),Err(error)=>serde_json::json!({"error":error})};
                                let _=crate::maintenance::atomic_json(&dir.join("runtime-profile-verified.json"),&json);
                            }
                            Some("upgrade-reuse-candidate") => {
                                let result=(|| {
                                    let target:crate::dsh::Runtime=serde_json::from_value(value["target"].clone()).map_err(|_|"runtime-candidate-binding")?;
                                    let lease=app.state::<crate::dsh_update::UpdateManager>().begin()?;
                                    let (identity,source)={let shared=app.state::<crate::state::Shared>();let s=shared.lock().map_err(|_|"runtime-state")?;
                                        (crate::remote_control::identity(&s),s.runtime.clone().ok_or("runtime-unavailable")?)};
                                    crate::runtime_store::verify_candidate(&app,&target)?;
                                    crate::dsh_upgrade::prepared(&app,identity,source,target)?;drop(lease);Ok::<_,String>(())
                                })();
                                let json=match result {Ok(())=>serde_json::json!({"ready":true}),Err(error)=>serde_json::json!({"error":error})};
                                let _=crate::maintenance::atomic_json(&dir.join("upgrade-reused.json"),&json);
                            }
                            Some("close") => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.close();
                                }
                            }
                            Some("backend-stop") => {
                                let process = app
                                    .state::<crate::state::Shared>()
                                    .lock()
                                    .ok()
                                    .and_then(|mut state| state.process.take());
                                drop(process);
                            }
                            Some("quit") => {
                                crate::minimal::exit(&app);
                                return;
                            }
                            _ => {}
                        }
                    }
                }
            }
            let window_count = app.webview_windows().len();
            let visible = app
                .get_webview_window("main")
                .is_some_and(|window| window.is_visible().unwrap_or(false));
            let status = {
                let state = app.state::<crate::state::Shared>();
                let Ok(state) = state.lock() else {
                    return;
                };
                if state.ui.phase == crate::ui_snapshot::UiPhase::Exiting {
                    return;
                }
                let backend = match state.phase {
                    crate::state::Phase::Running { .. } => "running",
                    crate::state::Phase::Failed { .. } => "failed",
                    _ => "starting",
                };
                serde_json::json!({ "phase":state.ui.phase, "identity":state.ui.identity(), "hasSnapshot":state.ui.snapshot.is_some(), "error":state.ui.last_error, "windowCount":window_count, "loaded":state.ui.loaded, "visible":visible, "backend":backend, "command":last, "runtime":state.runtime, "runtimeCleanupPending":crate::runtime_cleanup::pending(&app),
                    "notifications": { "enabled": state.notification_preferences.enabled, "soundEnabled":state.notification_preferences.sound_enabled,
                        "sound":state.notification_preferences.sound, "customName":state.notification_preferences.custom_name, "audioBytes":state.notification_preferences.custom_audio.len() } })
            };
            if let Ok(json) = serde_json::to_vec(&status) {
                let _ = std::fs::write(dir.join("state.json"), json);
            }
        }
    });
}
