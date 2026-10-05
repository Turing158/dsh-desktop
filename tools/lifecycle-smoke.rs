//! Debug-only control for integration tests. Enabled solely by an explicit
//! DSH_DESKTOP_SMOKE_DIR; absent from release builds and from the IPC ACL.
use std::time::Duration;
use tauri::Manager;

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
                            Some("enter") => crate::minimal::set(&app, true),
                            Some("show") => crate::minimal::show(&app),
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
                serde_json::json!({ "phase":state.ui.phase, "identity":state.ui.identity(), "hasSnapshot":state.ui.snapshot.is_some(), "error":state.ui.last_error, "windowCount":window_count, "loaded":state.ui.loaded, "visible":visible, "backend":backend, "command":last })
            };
            if let Ok(json) = serde_json::to_vec(&status) {
                let _ = std::fs::write(dir.join("state.json"), json);
            }
        }
    });
}
