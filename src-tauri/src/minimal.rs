//! Serialized UI lifetime, independent of DSH's backend lifetime.
use crate::state::Shared;
use crate::ui_snapshot::{self, Identity, UiPayload, UiPhase, UiSnapshot, REQUIRED};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);
const RESTORE_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);

pub fn is_on(app: &AppHandle) -> bool {
    app.state::<Shared>()
        .lock()
        .map(|s| {
            if s.ui.enabled {
                s.ui.phase == UiPhase::Minimal
            } else {
                s.minimal
            }
        })
        .unwrap_or(false)
}
pub fn busy(app: &AppHandle) -> bool {
    app.state::<Shared>()
        .lock()
        .map(|s| s.ui.busy())
        .unwrap_or(true)
}
pub fn toggle(app: &AppHandle) {
    set(app, !is_on(app));
}
pub fn set(app: &AppHandle, on: bool) {
    if app.state::<Shared>().lock().map(|s| s.remote.applying).unwrap_or(true) { return; }
    if !on {
        show(app);
        return;
    }
    let enabled = app
        .state::<Shared>()
        .lock()
        .map(|s| s.ui.enabled)
        .unwrap_or(false);
    if !enabled {
        if let Ok(mut s) = app.state::<Shared>().lock() {
            if s.ui.phase == UiPhase::Exiting {
                return;
            }
            s.minimal = true;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        crate::webview::sync(app);
        crate::tray::sync_checkmark(app);
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if crate::terminal::has_sessions(app) {
        if let Ok(mut s) = app.state::<Shared>().lock() { s.ui.last_error = Some("snapshot-terminal-active".into()); }
        ui_snapshot::refresh_bridge(&window);
        use crate::notify::Notifier;
        let _ = crate::notify::ToastNotifier::new(app.clone()).notify("终端会话仍在使用", "请先关闭所有终端，再进入会销毁界面的极简模式。收起侧栏和关闭到托盘可继续使用。");
        return;
    }
    let url = match window.url() {
        Ok(url) => url,
        Err(_) => return,
    };
    let identity = {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if s.ui.phase != UiPhase::Active {
            return;
        }
        if !ui_snapshot::allowed_origin(app, &url, &s.phase) || !s.ui.loaded {
            drop(s);
            report(app, "snapshot-page-not-ready");
            return;
        }
        s.ui.focus_requested = false;
        s.ui.last_error = None;
        s.ui.transition(UiPhase::Capturing)
    };
    ui_snapshot::record_geometry(&window, identity.window_generation);
    crate::tray::sync_checkmark(app);
    let json = serde_json::to_string(&identity).expect("identity serializes");
    // Boot's data stays native-owned. The lightweight bridge only checks that
    // no transient boot dialog or file picker would be discarded.
    let boot = if ui_snapshot::is_app_document(app, &url) {
        serde_json::to_string(&UiPayload::boot()).expect("boot serializes")
    } else {
        "null".into()
    };
    if window
        .eval(&format!("window.__DSH_UI_STATE__?.capture({json},{boot});"))
        .is_err()
    {
        capture_failed(app, identity, "snapshot-bridge");
        return;
    }
    watch_timeout(
        app,
        identity.operation_id,
        UiPhase::Capturing,
        CAPTURE_TIMEOUT,
    );
}

pub fn capture_failed(app: &AppHandle, identity: Identity, error: &str) {
    {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if !s.ui.matches(identity) || s.ui.phase != UiPhase::Capturing {
            return;
        }
        s.ui.last_error = Some(error.into());
        s.ui.transition(UiPhase::Active);
    }
    if let Some(window) = app.get_webview_window("main") {
        ui_snapshot::refresh_bridge(&window);
    }
    crate::tray::sync_checkmark(app);
    report(app, error);
}

pub fn captured(
    app: &AppHandle,
    identity: Identity,
    snapshot: Arc<UiSnapshot>,
) -> Result<(), String> {
    if crate::terminal::has_sessions(app) { capture_failed(app, identity, "snapshot-terminal-active"); return Err("snapshot-terminal-active".into()); }
    let destroying = {
        let shared = app.state::<Shared>();
        let mut s = shared.lock().map_err(|_| "snapshot-state")?;
        let same_boot = snapshot.payload.page.kind == "boot"
            && s.ui.operation_id == identity.operation_id
            && s.ui.window_generation == identity.window_generation
            && s.ui.document_generation == identity.document_generation;
        if (!s.ui.matches(identity) && !same_boot) || s.ui.phase != UiPhase::Capturing {
            return Err("snapshot-stale".into());
        }
        s.ui.snapshot = Some(snapshot);
        s.ui.transition(UiPhase::Destroying)
    };
    crate::tray::sync_checkmark(app);
    let app = app.clone();
    std::thread::spawn(move || destroy_and_observe(app, destroying));
    Ok(())
}

fn destroy_and_observe(app: AppHandle, identity: Identity) {
    let Some(window) = app.get_webview_window("main") else {
        restore_after_destroy(&app, identity, Some("window-missing"));
        return;
    };
    let processes = match crate::webview_process::ProcessSet::capture(&window) {
        Ok(processes) => processes,
        Err(_) => {
            cancel_before_destroy(&app, identity, "process-query-failed");
            return;
        }
    };
    let proceed = app
        .state::<Shared>()
        .lock()
        .map(|s| s.ui.owns_destruction(identity))
        .unwrap_or(false);
    if !proceed {
        return;
    }
    let _ = window.hide();
    if window.destroy().is_err() {
        cancel_before_destroy(&app, identity, "window-destroy-failed");
        return;
    }
    drop(window);
    let deadline = Instant::now() + Duration::from_secs(2);
    while app.get_webview_window("main").is_some() {
        if Instant::now() >= deadline {
            restore_after_destroy(&app, identity, Some("window-removal-timeout"));
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    match processes.wait_for_exit(PROCESS_TIMEOUT) {
        Ok(()) => restore_after_destroy(&app, identity, None),
        Err(_) => restore_after_destroy(&app, identity, Some("process-exit-timeout")),
    }
}

fn cancel_before_destroy(app: &AppHandle, identity: Identity, error: &str) {
    let discarded = {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if !s.ui.owns_destruction(identity) {
            return;
        }
        s.ui.last_error = Some(error.into());
        s.ui.transition(UiPhase::Active);
        s.remote.restore_instance = None;
        s.update_presentation = None;
        s.ui.snapshot.take()
    };
    drop(discarded);
    show_existing(app);
    if let Some(window) = app.get_webview_window("main") {
        ui_snapshot::refresh_bridge(&window);
    }
    crate::tray::sync_checkmark(app);
    report(app, error);
}
fn restore_after_destroy(app: &AppHandle, identity: Identity, error: Option<&str>) {
    let restore = {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if !s.ui.owns_destruction(identity) {
            return;
        }
        let restore = s.ui.focus_requested || error.is_some();
        s.ui.last_error = error.map(str::to_string);
        s.minimal = error.is_none();
        s.ui.transition(if error.is_some() {
            UiPhase::RestoreFailed
        } else {
            UiPhase::Minimal
        });
        restore
    };
    crate::tray::sync_checkmark(app);
    if let Some(error) = error {
        report(app, error);
    }
    if restore {
        show(app);
    }
}

/// Every show intent (tray, second launch, retry) goes through this one owner.
pub fn show(app: &AppHandle) {
    let missing = app.get_webview_window("main").is_none();
    let should_restore = {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if s.ui.phase == UiPhase::Exiting {
            return;
        }
        s.minimal = false;
        match s.ui.request_show(missing) {
            ui_snapshot::ShowAction::Wait => return,
            ui_snapshot::ShowAction::Focus => false,
            ui_snapshot::ShowAction::Restore => true,
        }
    };
    crate::tray::sync_checkmark(app);
    if should_restore {
        let app = app.clone();
        std::thread::spawn(move || restore_window(app));
    } else {
        show_existing(app);
        if let Some(window) = app.get_webview_window("main") {
            ui_snapshot::refresh_bridge(&window);
        }
    }
}
fn restore_window(app: AppHandle) {
    let (operation, has_snapshot) = match app.state::<Shared>().lock() {
        Ok(s) if s.ui.phase == UiPhase::Restoring => (s.ui.operation_id, s.ui.snapshot.is_some()),
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        show_existing(&app);
        let url = window.url();
        let loaded = app
            .state::<Shared>()
            .lock()
            .map(|s| {
                s.ui.loaded
                    && url
                        .as_ref()
                        .is_ok_and(|url| ui_snapshot::allowed_origin(&app, url, &s.phase))
            })
            .unwrap_or(false);
        if loaded {
            ui_snapshot::refresh_bridge(&window);
        } else {
            crate::navigate_current(&app);
        }
    } else if crate::create_main_window(&app, has_snapshot).is_err() {
        restore_failed(&app, operation, "window-create-failed");
        return;
    }
    if !has_snapshot {
        if let Ok(mut s) = app.state::<Shared>().lock() {
            if s.ui.operation_id == operation && s.ui.phase == UiPhase::Restoring {
                s.ui.transition(UiPhase::Active);
            }
        }
        crate::tray::sync_checkmark(&app);
        if let Some(window) = app.get_webview_window("main") {
            ui_snapshot::refresh_bridge(&window);
        }
        return;
    }
    watch_timeout(&app, operation, UiPhase::Restoring, RESTORE_TIMEOUT);
}

pub fn restored(
    app: &AppHandle,
    identity: Identity,
    snapshot_id: u64,
    fields: &[String],
    error: Option<&str>,
) -> Result<(), String> {
    let discarded = {
        let shared = app.state::<Shared>();
        let mut s = shared.lock().map_err(|_| "snapshot-state")?;
        if !s.ui.matches(identity)
            || s.ui.phase != UiPhase::Restoring
            || s.ui.snapshot.as_ref().map(|v| v.snapshot_id) != Some(snapshot_id)
        {
            return Err("snapshot-stale".into());
        }
        if let Some(error) = error {
            drop(s);
            restore_failed(app, identity.operation_id, error);
            return Ok(());
        }
        if REQUIRED
            .iter()
            .any(|field| !fields.iter().any(|f| f == field))
        {
            return Err("snapshot-incomplete".into());
        }
        crate::debug_log(&format!(
            "[minimal] restored op={} elapsed_ms={}",
            identity.operation_id,
            s.ui.started.elapsed().as_millis()
        ));
        s.ui.last_error = None;
        s.ui.transition(UiPhase::Active);
        s.minimal = false;
        s.remote.restore_instance = None;
        s.update_presentation = None;
        s.ui.snapshot.take()
    };
    drop(discarded);
    crate::tray::sync_checkmark(app);
    if let Some(window) = app.get_webview_window("main") {
        ui_snapshot::refresh_bridge(&window);
    }
    show_existing(app);
    Ok(())
}

pub(crate) fn restore_failed(app: &AppHandle, operation: u64, error: &str) {
    {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if s.ui.operation_id != operation || s.ui.phase != UiPhase::Restoring {
            return;
        }
        s.ui.last_error = Some(error.into());
        s.ui.transition(UiPhase::RestoreFailed);
    }
    if let Some(window) = app.get_webview_window("main") {
        ui_snapshot::refresh_bridge(&window);
    }
    crate::tray::sync_checkmark(app);
    report(app, error);
}
fn watch_timeout(app: &AppHandle, operation: u64, phase: UiPhase, duration: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(duration);
        let identity = {
            let shared = app.state::<Shared>();
            let Ok(s) = shared.lock() else {
                return;
            };
            if s.ui.phase != phase || s.ui.operation_id != operation {
                return;
            }
            s.ui.identity()
        };
        if phase == UiPhase::Capturing {
            capture_failed(&app, identity, "snapshot-capture-timeout");
        } else {
            restore_failed(&app, operation, "snapshot-restore-timeout");
        }
    });
}
fn show_existing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        crate::webview::sync(app);
    }
}
fn report(app: &AppHandle, error: &str) {
    crate::debug_log(&format!("[minimal] {error}"));
    use crate::notify::Notifier;
    let _ = crate::notify::ToastNotifier::new(app.clone()).notify(
        "界面状态未能保存或恢复",
        "原界面或快照已保留。请通过托盘显示主界面查看提示，或重试恢复。",
    );
}

pub fn page_load(window: &WebviewWindow, generation: u64, url: &tauri::Url, started: bool) {
    {
        let shared = window.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if s.ui.window_generation != generation
            || matches!(
                s.ui.phase,
                UiPhase::Destroying | UiPhase::Minimal | UiPhase::Exiting
            )
        {
            return;
        }
        if started {
            s.ui.document_generation += 1;
            s.ui.document_url = Some(url.clone());
            s.ui.loaded = false;
            if s.ui.phase == UiPhase::Capturing {
                s.ui.last_error = Some("snapshot-navigation".into());
                s.ui.transition(UiPhase::Active);
            }
        } else {
            if s.ui
                .document_url
                .as_ref()
                .is_some_and(|current| current != url)
            {
                return;
            }
            s.ui.loaded = true;
        }
    }
    if !started {
        let backend_ready = window
            .state::<Shared>()
            .lock()
            .map(|s| matches!(s.phase, crate::state::Phase::Running { .. }))
            .unwrap_or(false);
        if ui_snapshot::is_app_document(window.app_handle(), url) && backend_ready {
            crate::navigate_current(window.app_handle());
        } else {
            ui_snapshot::refresh_bridge(window);
        }
    }
    crate::tray::sync_checkmark(window.app_handle());
}
pub fn destroyed(app: &AppHandle, generation: u64) {
    let shared = app.state::<Shared>();
    let Ok(mut s) = shared.lock() else {
        return;
    };
    if s.ui.window_generation == generation {
        s.ui.loaded = false;
        if !matches!(s.ui.phase, UiPhase::Destroying | UiPhase::Exiting) {
            s.ui.last_error = Some("snapshot-window-lost".into());
            s.ui.transition(UiPhase::RestoreFailed);
        }
    }
}
pub fn exit(app: &AppHandle) {
    let snapshot = {
        let shared = app.state::<Shared>();
        let Ok(mut s) = shared.lock() else {
            app.exit(0);
            return;
        };
        s.ui.transition(UiPhase::Exiting);
        s.ui.focus_requested = false;
        s.ui.snapshot.take()
    };
    let app = app.clone();
    std::thread::spawn(move || {
        drop(snapshot);
        crate::shutdown_runtime(&app);
        app.exit(0);
    });
}
