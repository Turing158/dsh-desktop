//! Application entry: window, commands, and the boot sequence.
//!
//! The window starts on a small local page that reports what the app is doing.
//! A background thread probes for the runtime, offers to install one when it is
//! missing, then starts `dsh web` and navigates the window to the URL it prints.
//! Once navigated the page comes from DSH's own server, which is a remote origin
//! as far as Tauri is concerned. Its host commands receive an exact-origin
//! capability after startup; boot/install commands remain local-only.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod locale;
mod app_icon;
mod boot_bar;
mod bundled_runtime;
mod clipboard;
mod deep_link;
mod drag_guard;
mod dsh;
mod builtin_plugins;
mod dsh_update;
#[cfg(feature = "single")]
mod embedded_plugins;
mod folder_focus;
#[cfg(debug_assertions)]
#[path = "../../tools/lifecycle-smoke.rs"]
mod lifecycle_smoke;
mod minimal;
mod notify;
mod npm;
mod remote_control;
mod session_export;
mod state;
mod terminal;
mod titlebar;
mod tray;
mod ui_snapshot;
mod webview;
mod webview_process;
mod window_controls;
mod winjob;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use dsh::{ChildEvent, CommandExt, Runtime};
use notify::{Notifier, ToastNotifier};
use state::{Phase, Shared, StatusReport};

/// How long to wait for the `dsh web:` readiness line before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Resource-relative location of the notification overlay.
const PATCH_RESOURCE: &str = "dsh-plugin/desktop-notify.patch.yml";

/// Event name carrying install progress to the UI.
const EVENT_INSTALL_PROGRESS: &str = "install-progress";
/// Event name telling the UI the phase changed and it should re-render.
const EVENT_STATUS_CHANGED: &str = "status-changed";

fn main() {
    #[cfg(feature = "single")]
    if !embedded_plugins::check_webview() {
        std::process::exit(1);
    }
    if let Err(error) = bundled_runtime::initialize() {
        bundled_runtime::show_failure(&error);
        std::process::exit(1);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch focuses the running app instead of starting a
            // second DSH server and a second window writing the same settings.
            // The window may be hidden in the tray (closing hides it), so this
            // goes through the tray's show, which unhides before focusing.
            // A launch carrying a deep link queues it instead — `offer` shows
            // the window itself and then tries to activate the link.
            if !deep_link::offer_argv(app, &argv) {
                tray::show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(locale::NativeLocale::default())
        .manage(state::shared())
        .manage(terminal::TerminalManager::default())
        .manage(dsh_update::UpdateManager::default())
        .manage(session_export::ExportDestinations::default())
        .invoke_handler(|invoke| {
            if !remote_control::current_invocation(&invoke) {
                invoke.resolver.reject("stale-origin");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                locale::desktop_locale_changed,
                probe_state,
                retry_boot,
                cancel_install,
                install_node,
                open_external,
                dsh_update::check_dsh_update,
                dsh_update::install_dsh_update,
                window_controls::window_start_drag,
                window_controls::window_start_resize,
                window_controls::window_minimize,
                window_controls::window_toggle_maximize,
                window_controls::window_is_maximized,
                window_controls::window_close,
                window_controls::clipboard_read_text,
                window_controls::clipboard_write_text,
                window_controls::clipboard_edit_shortcut,
                folder_focus::focus_folder_window,
                session_export::prepare_session_export,
                ui_snapshot::submit_ui_snapshot,
                ui_snapshot::request_ui_restore,
                ui_snapshot::finish_ui_restore,
                deep_link::report_deep_link,
                remote_control::remote_status,
                remote_control::remote_lan_addresses,
                remote_control::remote_apply,
                remote_control::plugins_restart,
                remote_control::remote_connection_info,
                remote_control::remote_firewall_help,
                terminal::terminal_profiles,
                terminal::terminal_open,
                terminal::terminal_restart,
                terminal::terminal_list,
                terminal::terminal_attach,
                terminal::terminal_control,
                terminal::terminal_write,
                terminal::terminal_resize,
                terminal::terminal_ack,
                terminal::terminal_detach,
                terminal::terminal_close,
            ];
            handler(invoke)
        })
        .setup(|app| {
            set_app_user_model_id(app.handle());
            create_main_window(app.handle(), false)?;
            // The tray icon exists from launch, not from the first close: it is
            // the way back into a hidden window, and a control that only
            // appears after it is needed would be a poor one.
            tray::install(app.handle())?;
            // A link passed to this process's own launch is queued now and
            // pushed once the DSH document is live (see `deep_link`); the
            // scheme registration is idempotent per-user registry work.
            deep_link::register(app.handle());
            deep_link::capture_startup_args(app.handle());
            #[cfg(debug_assertions)]
            lifecycle_smoke::install(app.handle());
            let handle = app.handle().clone();
            // The window must paint immediately, so probing and the child
            // process stay off this thread.
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the DeepseekHarness desktop app")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                let exiting = app
                    .state::<Shared>()
                    .lock()
                    .map(|s| s.ui.phase == ui_snapshot::UiPhase::Exiting)
                    .unwrap_or(true);
                if !exiting {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::ExitRequested { code: Some(_), .. } | tauri::RunEvent::Exit => {
                shutdown_runtime(app)
            }
            _ => {}
        });
}

/// Create the main window.
///
/// Built in code rather than declared in `tauri.conf.json` for four reasons:
/// the document-title handler is builder-only; the window is created without
/// native decorations, so the app draws its own title bar; the frame corners
/// are rounded explicitly to match it; and file drag-and-drop has to be handed
/// back to the page, which is a builder flag rather than a config key (see
/// [`drag_drop_belongs_to_the_page`]).
fn create_main_window(app: &AppHandle, restoring: bool) -> tauri::Result<()> {
    let (generation, geometry) = {
        let shared = app.state::<Shared>();
        let mut state = shared.lock().expect("state mutex poisoned");
        if state.ui.phase == ui_snapshot::UiPhase::Exiting {
            return Ok(());
        }
        state.ui.window_generation += 1;
        state.ui.document_generation = 0;
        state.ui.loaded = false;
        state.ui.document_url = None;
        (state.ui.window_generation, state.ui.geometry.clone())
    };
    let builder = tauri::WebviewWindowBuilder::new(app, "main", main_window_url(app));
    #[cfg(debug_assertions)]
    let builder = if let Some(dir) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {
        builder.data_directory(PathBuf::from(dir).join("webview"))
    } else {
        builder
    };
    let window = builder
        .title("DeepseekHarness")
        .visible(false)
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .center()
        // No native caption: the DSH-side title bar replaces it. This removes the
        // OS minimize/maximize/close buttons and the system menu, so the page
        // must provide them — which is exactly what the title bar does, calling
        // the `window_controls` commands.
        .decorations(false)
        // The title bar must exist on EVERY page, not only the one DSH serves.
        // A document-created script runs before any page script on each top-level
        // navigation, so this one registration covers the boot page, DSH's own
        // "Loading plugins…" splash, and any later reload. Without it, a
        // decorationless window has no controls until DSH's client plugin mounts —
        // and none at all if the boot fails. See `boot_bar`.
        .initialization_script(boot_bar::initialization_script(app))
        .initialization_script(ui_snapshot::initialization_script(app, generation, restoring))
        .on_page_load(move |window, payload| {
            let started = payload.event() == tauri::webview::PageLoadEvent::Started;
            minimal::page_load(&window, generation, payload.url(), started);
            terminal::page_load(&window, started);
            remote_control::page_load(&window, started);
            // Runs after `minimal::page_load`, which marks the document loaded
            // on Finished — a fresh document is exactly the moment a queued
            // link can be pushed into it. See `deep_link::page_loaded`.
            if !started {
                deep_link::page_loaded(&window);
            }
        })
        // File drag-and-drop belongs to the PAGE, not to Tauri. See
        // `drag_drop_belongs_to_the_page` below — this single flag is what makes
        // dropping a file on the window show DSH's drop placeholder and attach the
        // file, instead of silently doing nothing.
        .disable_drag_drop_handler()
        .on_download(session_export::on_download)
        .on_document_title_changed(|window, title| {
            // The page controls this; ignore an empty title so a transient blank
            // does not leave the window unnamed.
            let trimmed = title.trim();
            if !trimmed.is_empty() {
                let _ = window.set_title(trimmed);
            }
        })
        .build()?;

    bind_main_events(&window, generation);
    if restoring {
        if let Some(geometry) = geometry {
            if ui_snapshot::apply_geometry(&window, &geometry).is_err() {
                debug_log("[minimal] geometry-fallback");
                let _ = window.center();
            }
        }
    }

    // With decorations off, Windows draws a square frame. Rounding it to match
    // the app's own surfaces keeps the window from looking like a raw panel.
    // DWM ignores this on Windows 10, where the frame simply stays square.
    titlebar::round_frame_corners(&window);

    // The title bar's drags are entered asynchronously — `start_dragging` posts
    // `WM_NCLBUTTONDOWN` and the OS move loop starts at pump time, which on a
    // cold start can lag seconds past the click that requested it. The guard
    // swallows a loop armed with no button held; installed here so the early
    // clicks, the ones most likely to race, are already covered. See
    // `drag_guard` and the check in `window_controls::window_start_drag`.
    drag_guard::install(&window);

    // Two different themes, on purpose. The frame follows the DSH preference
    // (it sits directly above the app's sidebar and must not band against it);
    // the window and taskbar icon follow Windows' *system* theme, which is a
    // separate setting from the app theme the window reports. A white mark on a
    // light taskbar is invisible no matter what the app is showing — see
    // `app_icon`.
    let dark = window
        .theme()
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(false);
    titlebar::apply_to_window(&window, dark);
    app_icon::apply_to_window(&window);
    debug_log(&format!(
        "[icon] app theme dark={dark}, taskbar theme={}, metric {}px",
        app_icon::describe_taskbar_theme(),
        app_icon::taskbar_metric()
    ));

    apply_appearance(app);
    if app
        .state::<Shared>()
        .lock()
        .map(|s| s.ui.phase == ui_snapshot::UiPhase::Exiting)
        .unwrap_or(true)
    {
        let _ = window.destroy();
        return Ok(());
    }
    ui_snapshot::record_geometry(&window, generation);
    let _ = window.show();
    Ok(())
}

fn bind_main_events(window: &tauri::WebviewWindow, generation: u64) {
    let owned = window.clone();
    window.on_window_event(move |event| {
        let window = &owned;
        let app = window.app_handle();
        let current = app
            .state::<Shared>()
            .lock()
            .map(|s| {
                s.ui.window_generation == generation && s.ui.phase != ui_snapshot::UiPhase::Exiting
            })
            .unwrap_or(false);
        if !current {
            return;
        }
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                webview::sync(app);
            }
            tauri::WindowEvent::Destroyed => minimal::destroyed(app, generation),
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                ui_snapshot::record_geometry(window, generation)
            }
            tauri::WindowEvent::ThemeChanged(_) => {
                apply_appearance(app);
                apply_system_icon(app);
            }
            _ => {}
        }
    });
}

/// Rebuild against the current backend, never re-run boot from a show intent.
fn main_window_url(app: &AppHandle) -> tauri::WebviewUrl {
    let shared = app.state::<Shared>();
    if let Ok(s) = shared.lock() {
        if let Phase::Running { url, .. } = &s.phase {
            if let Ok(url) = url.parse() {
                return tauri::WebviewUrl::External(url);
            }
        }
    }
    tauri::WebviewUrl::default()
}

fn navigate_current(app: &AppHandle) {
    if app
        .state::<Shared>()
        .lock()
        .map(|s| {
            matches!(
                s.ui.phase,
                ui_snapshot::UiPhase::Destroying
                    | ui_snapshot::UiPhase::Minimal
                    | ui_snapshot::UiPhase::Exiting
            )
        })
        .unwrap_or(true)
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let url = match main_window_url(app) {
            tauri::WebviewUrl::External(url) => url,
            _ => {
                #[cfg(windows)]
                let url = "http://tauri.localhost/";
                #[cfg(not(windows))]
                let url = "tauri://localhost/";
                url.parse().expect("local URL")
            }
        };
        let _ = window;
        navigate(app, url.as_str());
    }
}

/// Record the appearance preference reported by the web app.
///
/// `system` is deliberately not resolved here: it is stored as-is so the window's
/// own OS theme (which Tauri tracks per window) decides, and switching the
/// Windows setting updates the title bar without the user touching DSH.
fn record_appearance(app: &AppHandle, state: &Shared, report: &dsh::ThemeReport, instance: u64) {
    let preference = report.preference;
    {
        let Ok(mut guard) = state.lock() else { return };
        if guard.ui.backend_instance != instance
            || guard.ui.phase == ui_snapshot::UiPhase::Exiting
            || guard.appearance == preference
        {
            return;
        }
        guard.appearance = preference;
    }
    debug_log(&format!("[theme] preference={preference:?}"));
    apply_appearance(app);
}

/// Apply the current appearance preference to the native window chrome.
///
/// Safe to call at any time: it reads the stored preference, resolves `system`
/// against the window's live OS theme, and re-applies DWM colors (which is
/// idempotent).
fn apply_appearance(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let preference = app
        .state::<Shared>()
        .lock()
        .map(|guard| guard.appearance)
        .unwrap_or_default();

    let dark = match preference {
        dsh::ThemePreference::Light => false,
        dsh::ThemePreference::Dark => true,
        // `system`: the window already knows what the OS is doing, including
        // which monitor it is on, so no registry read is needed here.
        dsh::ThemePreference::System => window
            .theme()
            .map(|theme| theme == tauri::Theme::Dark)
            .unwrap_or(false),
    };
    titlebar::apply_to_window(&window, dark);
}

/// Apply the window and taskbar icon for the current **Windows** theme.
///
/// Separate from [`apply_appearance`] because the two answer to different
/// settings. The frame follows the user's choice inside DSH; the taskbar is a
/// Windows surface drawn among other Windows surfaces, so it follows the
/// system theme — and specifically `SystemUsesLightTheme`, which is *not* the
/// value the window's own `theme()` reports. See `app_icon`.
///
/// Safe to call at any time, and idempotent.
fn apply_system_icon(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    app_icon::apply_to_window(&window);
}

/// Tag this process so its toast notifications are attributed correctly.
///
/// Without an AppUserModelID Windows may drop toasts from an app that has no
/// Start-menu shortcut (the common case in development).
fn set_app_user_model_id(app: &AppHandle) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

        let identifier = app.config().identifier.clone();
        let _ =
            unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(identifier.as_str())) };
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Resolve the notification overlay that ships with the app.
#[cfg(feature = "single")]
fn patch_file(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app.path().app_cache_dir().map_err(|e| format!("无法定位插件缓存：{e}"))?;
    embedded_plugins::prepare(&cache)
}

#[cfg(not(feature = "single"))]
fn patch_file(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("dsh-plugin").join("desktop-notify.patch.yml");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if cfg!(feature = "offline") {
        return Err(format!("便携包缺少 {PATCH_RESOURCE}，请重新解压完整的 portable 包"));
    }
    // Development: resources are not copied next to the debug binary.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("dsh-plugin").join("desktop-notify.patch.yml"));
    if let Some(candidate) = dev {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "未找到通知插件补丁文件 {PATCH_RESOURCE}；请确认它已随应用一起打包"
    ))
}

/// Publish the current phase to the UI.
fn publish(app: &AppHandle, state: &Shared) {
    if let Ok(guard) = state.lock() {
        let report = state::status(&guard, None, None);
        let _ = app.emit(EVENT_STATUS_CHANGED, report);
    }
}

/// Set the phase and notify the UI.
fn set_phase(app: &AppHandle, state: &Shared, phase: Phase) {
    if let Ok(mut guard) = state.lock() {
        if guard.ui.phase == ui_snapshot::UiPhase::Exiting {
            return;
        }
        guard.phase = phase;
    }
    publish(app, state);
}

/// Record a failure and show it.
fn fail(app: &AppHandle, state: &Shared, message: impl Into<String>, hint: impl Into<String>) {
    let details = failure_details(state);
    set_phase(
        app,
        state,
        Phase::Failed {
            message: message.into(),
            hint: hint.into(),
            details,
            manual_install: false,
        },
    );
}

/// The startup sequence: probe, offer to install if needed, then start.
fn boot(app: AppHandle) {
    let state = app.state::<Shared>().inner().clone();
    {
        let Ok(mut guard) = state.lock() else {
            return;
        };
        if guard.boot_in_progress
            || guard.remote.applying
            || guard.ui.phase == ui_snapshot::UiPhase::Exiting
            || matches!(guard.phase, Phase::Running { .. })
        {
            return;
        }
        guard.boot_in_progress = true;
    }
    struct BootGuard(Shared);
    impl Drop for BootGuard {
        fn drop(&mut self) {
            if let Ok(mut s) = self.0.lock() {
                s.boot_in_progress = false;
            }
        }
    }
    let _boot_guard = BootGuard(state.clone());
    set_phase(&app, &state, Phase::Probing);

    let Some(node_exe) = dsh::resolve_node() else {
        set_phase(
            &app,
            &state,
            Phase::NeedsNode {
                found: None,
                required_major: dsh::MIN_NODE_MAJOR,
            },
        );
        return;
    };

    let major = dsh::node_major(&node_exe);
    match major {
        Some(major) if major >= dsh::MIN_NODE_MAJOR => {}
        other => {
            let found = other.map(|value| format!("v{value}"));
            set_phase(
                &app,
                &state,
                Phase::NeedsNode {
                    found,
                    required_major: dsh::MIN_NODE_MAJOR,
                },
            );
            return;
        }
    }

    // A `major` is only ever Some here: the None case above returned already.
    // The version is still reported to the UI through `probe_state`, which
    // re-reads it; boot itself only needs the executable.

    // Prefer an existing global install: reusing the runtime the user already
    // has avoids a second copy fighting over the shared profile directory.
    match dsh::resolve_dsh(false) {
        Some((dsh_bin, source)) => {
            let runtime = Runtime {
                node_exe,
                dsh_bin,
                source,
                version: None,
            };
            launch(&app, &state, runtime);
        }
        // No dsh anywhere. This is the first-launch path, not an error: install
        // one globally and start it, with no page in between to click through.
        None if cfg!(feature = "offline") => fail(&app, &state, "内置 DSH 不完整", "请重新解压完整的 portable 包"),
        None => auto_install(&app, &state, node_exe),
    }
}

/// Install `dsh` globally, then start it.
///
/// Runs on the boot thread, which is why the install's own wait is inline: the
/// startup sequence has exactly one owner, and the UI only ever observes it
/// through phase changes and progress events.
///
/// Failure is the one case that asks the user for anything. A global install can
/// fail for reasons this app cannot fix (a proxy, a registry that is down, npm's
/// script policy), so the failure screen hands over the command to run by hand
/// rather than retrying silently.
fn auto_install(app: &AppHandle, state: &Shared, node_exe: PathBuf) {
    if exiting(state) {
        return;
    }
    set_phase(app, state, Phase::Installing { version: None });

    let mut installer = match npm::Installer::start(&node_exe) {
        Ok(installer) => installer,
        Err(error) => {
            manual_install_failure(app, state, format!("无法启动安装：{error}"));
            return;
        }
    };

    // Publish the stop handle before waiting, so the cancel button and a window
    // close can both reach the install while it is running.
    if let Ok(mut guard) = state.lock() {
        if guard.ui.phase == ui_snapshot::UiPhase::Exiting {
            return;
        }
        guard.installer = Some(installer.handle());
    }

    // Stream npm's output to the page while it runs, and keep it in the state
    // log as well: the failure screen shows the tail, and npm's own message is
    // more useful than any summary this app could write.
    let mut transcript: Vec<String> = Vec::new();
    if let Some(receiver) = installer.take_events() {
        let app_for_progress = app.clone();
        let state_for_progress = state.clone();
        let progress_thread = std::thread::spawn(move || {
            let mut seen: Vec<String> = Vec::new();
            for progress in receiver {
                seen.push(progress.line.clone());
                if let Ok(mut guard) = state_for_progress.lock() {
                    guard.push_log(progress.line.clone());
                }
                let _ = app_for_progress.emit(EVENT_INSTALL_PROGRESS, progress);
            }
            seen
        });

        // `wait` is called after the reader thread exists but before joining it,
        // so npm's output is drained while it runs instead of filling a pipe.
        let outcome = installer.wait();
        // The channel closes once npm exits, so this join terminates.
        transcript = progress_thread.join().unwrap_or_default();

        // `Ok(false)` is npm exiting non-zero — a normal failure, not an error
        // in the wrapper — so it must be handled here rather than falling through
        // to the verification step below with a misleading "not found" message.
        match outcome {
            Ok(true) => {}
            Ok(false) => {
                clear_installer(state);
                manual_install_failure(app, state, describe_npm_failure(&transcript));
                return;
            }
            Err(error) => {
                clear_installer(state);
                manual_install_failure(app, state, error);
                return;
            }
        }
    } else {
        match installer.wait() {
            Ok(true) => {}
            Ok(false) => {
                clear_installer(state);
                manual_install_failure(app, state, "npm 以非零状态退出".to_string());
                return;
            }
            Err(error) => {
                clear_installer(state);
                manual_install_failure(app, state, error);
                return;
            }
        }
    }
    clear_installer(state);

    if exiting(state) {
        return;
    }

    // Verify rather than trust the exit code: npm can succeed while a native
    // dependency failed to build, leaving a dsh that cannot boot.
    let reported = match npm::verify_install(&node_exe) {
        Ok(reported) => reported,
        Err(error) => {
            manual_install_failure(app, state, format!("安装后校验失败：{error}"));
            return;
        }
    };

    let _ = app.emit(
        EVENT_INSTALL_PROGRESS,
        npm::InstallProgress {
            line: format!("安装完成：dsh {reported}"),
            done: true,
            ok: true,
        },
    );

    // Resolve again rather than assuming the path: this is the same lookup the
    // next launch will do, so a successful start also proves the next one works.
    match dsh::resolve_dsh(false) {
        Some((dsh_bin, source)) => {
            let runtime = Runtime {
                node_exe,
                dsh_bin,
                source,
                version: Some(reported),
            };
            launch(app, state, runtime);
        }
        None => manual_install_failure(
            app,
            state,
            format!(
                "安装报告成功（dsh {reported}），但应用仍找不到 dsh 的入口文件{}",
                transcript
                    .last()
                    .map(|line| format!("（npm 最后一行：{line}）"))
                    .unwrap_or_default()
            ),
        ),
    }
}

/// Drop the install's stop handle once it has finished.
fn clear_installer(state: &Shared) {
    if let Ok(mut guard) = state.lock() {
        guard.installer = None;
    }
}

/// Summarise why npm failed, preferring the line that names the cause.
///
/// npm's output ends with boilerplate — "A complete log of this run can be found
/// in …", "npm error Log files were not written…" — which is *also* tagged
/// `npm error`, so taking the last tagged line reports the location of the log
/// instead of the reason. Measured against a real failure: the tail was the log
/// path, while the cause (`ECONNREFUSED`) sat just above it.
///
/// So the `code` line is preferred first, then any tagged line that is not
/// boilerplate, and the generic message is the fallback for a silent non-zero
/// exit. The failure screen shows the full transcript on demand, so nothing here
/// has to be complete — only worth reading first.
fn describe_npm_failure(transcript: &[String]) -> String {
    /// Lines npm always prints alongside the real cause.
    fn is_boilerplate(line: &str) -> bool {
        const NOISE: [&str; 4] = [
            "A complete log of this run can be found in",
            "Log files were not written due to an error writing to the directory",
            "You can rerun the command with `--loglevel=verbose`",
            "for a verbose log",
        ];
        NOISE.iter().any(|needle| line.contains(needle))
    }

    fn is_tagged(line: &str) -> bool {
        line.contains("npm error") || line.contains("npm ERR!")
    }

    let cause = transcript
        .iter()
        .rev()
        .find(|line| is_tagged(line) && line.contains("code ") && !is_boilerplate(line))
        .or_else(|| {
            transcript
                .iter()
                .rev()
                .find(|line| is_tagged(line) && !is_boilerplate(line))
        });

    match cause {
        Some(line) => format!("npm 安装失败（{}）", line.trim()),
        None => "npm 安装失败（退出码非零，详见下方输出）".to_string(),
    }
}

/// Show the screen that hands the install over to the user, with its cause.
fn manual_install_failure(app: &AppHandle, state: &Shared, reason: String) {
    let details = failure_details(state);
    set_phase(
        app,
        state,
        Phase::Failed {
            message: format!("自动安装 dsh 失败：{reason}"),
            hint: "请按下面的步骤手动安装，然后回到本窗口点击「重新检测」。".to_string(),
            details,
            manual_install: true,
        },
    );
}

/// Start the child process and navigate the window when it is ready.
fn exiting(state: &Shared) -> bool {
    state
        .lock()
        .map(|s| s.ui.phase == ui_snapshot::UiPhase::Exiting)
        .unwrap_or(true)
}

fn launch(app: &AppHandle, state: &Shared, mut runtime: Runtime) {
    runtime.version = dsh::dsh_version(&runtime.node_exe, &runtime.dsh_bin);
    let config = remote_control::cold_config(app, state);
    restart_backend(app, state, runtime, config);
}

/// Both cold start and settings changes use the same stop → start → fallback
/// path. The caller owns the boot/apply lock for the complete operation.
fn restart_backend(
    app: &AppHandle,
    state: &Shared,
    runtime: Runtime,
    config: remote_control::Config,
) {
    let first = start_backend_once(app, state, runtime.clone(), &config);
    if let Err(error) = first {
        if exiting(state) {
            return;
        }
        if let Ok(mut s) = state.lock() {
            s.remote.active = None;
            s.remote.error = Some(remote_control::Error::new("start-failed", "", &error));
        }
        // Disabling can never reopen the old LAN listener. A failed enabled
        // request is retained on disk while a single local recovery is tried.
        if let Err(local_error) =
            start_backend_once(app, state, runtime, &remote_control::Config::default())
        {
            let previous = {
                let mut s = state.lock().unwrap();
                s.ui.backend_instance += 1;
                s.remote.active = None;
                s.process.take()
            };
            drop(previous);
            fail(
                app,
                state,
                format!("{error}\n仅本机恢复失败：{local_error}"),
                "请检查端口、网卡及 DSH 配置后重试。",
            );
            navigate_current(app);
            return;
        }
    }
    if exiting(state) {
        return;
    }
    {
        let mut s = state.lock().unwrap();
        if s.ui.snapshot.is_some() {
            s.remote.restore_instance = Some(s.ui.backend_instance);
            s.ui.transition(ui_snapshot::UiPhase::Restoring);
        }
        s.remote.applying = false;
    }
    navigate_current(app);
    // Publish Running only once the navigation is in flight. The boot page is
    // the sole `status-changed` listener and refreshes on every event, so an
    // event landing on the very edge of the navigation makes it probe from a
    // document whose webview URL has already moved to the DSH origin. The
    // stale-origin guard refuses that, and the error card the boot page paints
    // for it lingers until the real interface replaces the page — the exact
    // flash reported on cold start with remote control enabled, where the LAN
    // target's slower commit leaves room for the rejected probe to show.
    // Published inside `wait_then_stream`, this event sat immediately before
    // `navigate`, which is the one timing that always loses this race.
    publish(app, state);
}

fn start_backend_once(
    app: &AppHandle,
    state: &Shared,
    runtime: Runtime,
    config: &remote_control::Config,
) -> Result<(), String> {
    if exiting(state) {
        return Err("启动已取消".into());
    }
    let version = runtime.version.clone();
    let patch = patch_file(app)?;
    let (instance, previous) = {
        let mut s = state.lock().map_err(|_| "后台状态不可用")?;
        if s.ui.phase == ui_snapshot::UiPhase::Exiting {
            return Err("启动已取消".into());
        }
        s.ui.backend_instance += 1;
        s.remote.active = None;
        s.ui.loaded = false;
        s.runtime = Some(runtime.clone());
        (s.ui.backend_instance, s.process.take())
    };
    if let Some(mut previous) = previous {
        previous.stop_and_wait().map_err(|e| e.to_string())?;
    }
    terminal::suspend(app);
    // Port ownership preflight is only advisory; the actual spawn is decisive.
    remote_control::precheck(config, None).map_err(|e| e.message)?;
    set_phase(
        app,
        state,
        Phase::Starting {
            version: version.clone(),
        },
    );

    if exiting(state) {
        return Err("启动已取消".into());
    }
    let changes_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("changes");
    #[cfg(debug_assertions)]
    let changes_dir = std::env::var_os("DSH_DESKTOP_SMOKE_DIR")
        .map(|dir| PathBuf::from(dir).join("changes"))
        .unwrap_or(changes_dir);
    let process = dsh::DshProcess::spawn(&runtime, &patch, config, &changes_dir)
        .map_err(|e| format!("无法启动 dsh：{e}"))?;

    // Take the event receiver out of the process so the readiness wait and the
    // ongoing stream are served by one owner.
    let mut process = process;
    let events = process.take_events().ok_or("无法读取 dsh 进程输出")?;

    {
        let mut guard = state.lock().map_err(|_| "后台状态不可用")?;
        if guard.ui.phase == ui_snapshot::UiPhase::Exiting {
            return Err("启动已取消".into());
        }
        guard.process = Some(process);
    };

    // Wait for readiness on this thread: the process owns the stream, so the
    // wait cannot be handed to the UI thread without losing ordering.
    wait_then_stream(app.clone(), state.clone(), events, instance, config)?;
    Ok(())
}

/// Wait for the readiness URL, then keep dispatching notifications.
fn wait_then_stream(
    app: AppHandle,
    state: Shared,
    events: std::sync::mpsc::Receiver<ChildEvent>,
    instance: u64,
    config: &remote_control::Config,
) -> Result<String, String> {
    // Phase one: everything up to the readiness line. The wait itself lives in
    // `dsh::await_ready` so it is covered by unit tests; this closure only
    // records the lines that arrive first.
    let url = dsh::await_ready(&events, READY_TIMEOUT, |event| match event {
        ChildEvent::Notify(payload) => {
            // A question can be raised before the window has navigated, so it
            // is delivered immediately rather than queued behind readiness.
            deliver(&app, &state, payload, instance)
        }
        ChildEvent::Theme(report) => record_appearance(&app, &state, &report, instance),
        other => record(&app, &state, other, instance),
    })
    .map_err(|error| {
        // If the child died, its recent output is more useful than the timeout
        // message alone, so it is appended for the error screen.
        let tail = state
            .lock()
            .map(|guard| guard.log_tail(12))
            .unwrap_or_default();
        if tail.is_empty() {
            error
        } else {
            format!("{error}\n{}", tail.join("\n"))
        }
    })?;

    remote_control::check_ready(config, &url)?;
    ui_snapshot::authorize_backend(&app, instance, &url)?;
    terminal::authorize_backend(&app, instance, &url)?;
    deep_link::authorize_backend(&app, instance, &url)?;
    dsh_update::authorize_backend(&app, instance, &url)?;
    remote_control::authorize_backend(&app, instance, &url)?;
    debug_log(&format!("[ready] {}", public_origin(&url)));
    {
        let mut guard = state.lock().map_err(|_| "后台状态不可用")?;
        if guard.ui.backend_instance != instance || guard.ui.phase == ui_snapshot::UiPhase::Exiting
        {
            return Err("启动已取消".into());
        }
        let version = guard
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.version.clone());
        guard.phase = Phase::Running {
            url: url.clone(),
            version,
        };
        guard.remote.active = Some(config.clone());
    }
    // Not published here: `restart_backend` publishes after it has navigated,
    // so the boot page never refreshes from a document the stale-origin guard
    // must refuse (see the comment there).

    // Phase two: keep consuming for the process's lifetime so notifications
    // keep arriving after the GUI is up.
    let app_for_stream = app.clone();
    let state_for_stream = state.clone();
    std::thread::spawn(move || {
        for event in events {
            let live = state_for_stream
                .lock()
                .map(|s| {
                    s.ui.backend_instance == instance && s.ui.phase != ui_snapshot::UiPhase::Exiting
                })
                .unwrap_or(false);
            if !live {
                break;
            }
            match event {
                ChildEvent::Notify(payload) => {
                    deliver(&app_for_stream, &state_for_stream, payload, instance)
                }
                ChildEvent::Theme(report) => {
                    record_appearance(&app_for_stream, &state_for_stream, &report, instance)
                }
                ChildEvent::Exited(code) => {
                    backend_exited(&app_for_stream, &state_for_stream, instance, code);
                    break;
                }
                other => record(&app_for_stream, &state_for_stream, other, instance),
            }
        }
    });

    Ok(url)
}

/// Show one notification, respecting the de-duplication window.
fn public_origin(value: &str) -> String {
    value
        .parse::<tauri::Url>()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "[invalid-url]".into())
}

fn backend_exited(app: &AppHandle, state: &Shared, instance: u64, code: i32) {
    let (identity, ui_phase) = {
        let Ok(mut s) = state.lock() else {
            return;
        };
        if s.ui.backend_instance != instance || s.ui.phase == ui_snapshot::UiPhase::Exiting {
            return;
        }
        s.push_log(format!("dsh 输出流已结束（代码 {code}）"));
        s.remote.active = None;
        s.remote.error = Some(remote_control::Error::new(
            "backend-exited",
            "",
            "DSH 后台已停止，局域网访问已失效",
        ));
        s.phase = Phase::Failed {
            message: "DSH 后台已停止响应".into(),
            hint: "请重试启动；未完成恢复的界面快照仍保留在本次应用运行中。".into(),
            details: s.log_tail(12),
            manual_install: false,
        };
        (s.ui.identity(), s.ui.phase)
    };
    debug_log(&format!("[backend] ended instance={instance} code={code}"));
    terminal::suspend(app);
    publish(app, state);
    if ui_phase == ui_snapshot::UiPhase::Capturing {
        minimal::capture_failed(app, identity, "snapshot-backend-unavailable");
    }
    if matches!(
        ui_phase,
        ui_snapshot::UiPhase::Restoring | ui_snapshot::UiPhase::RestoreFailed
    ) {
        navigate_current(app);
    }
    let _ = ToastNotifier::new(app.clone()).notify(
        "DSH 后台已停止响应",
        "请显示主界面查看状态；本次尚未恢复的快照仍保留。",
    );
}

fn deliver(app: &AppHandle, state: &Shared, payload: dsh::NotifyPayload, instance: u64) {
    let key = payload.dedupe_key();
    let should_show = state
        .lock()
        .map(|mut guard| {
            guard.ui.backend_instance == instance
                && guard.ui.phase != ui_snapshot::UiPhase::Exiting
                && guard.dedupe.should_show(&key)
        })
        .unwrap_or(true);
    if !should_show {
        debug_log(&format!("[notify/suppressed] {key}"));
        return;
    }

    let notifier: Arc<dyn Notifier> = Arc::new(ToastNotifier::new(app.clone()));
    match notifier.notify(
        &remote_control::redact(&payload.title),
        &remote_control::redact(&payload.body),
    ) {
        Ok(()) => {
            debug_log(&format!(
                "[notify/shown] {} — {}",
                payload.title, payload.body
            ));
            record(
                app,
                state,
                ChildEvent::Log(format!("已通知：{}", payload.title)),
                instance,
            );
        }
        Err(error) => {
            debug_log(&format!("[notify/failed] {error}"));
            record(
                app,
                state,
                ChildEvent::Log(format!("通知发送失败：{error}")),
                instance,
            );
        }
    }
}

/// Environment variable enabling a debug log of everything the child prints.
///
/// A desktop wrapper makes the child's output invisible, which is exactly the
/// output needed when notifications do not arrive. Setting `DSH_DESKTOP_DEBUG`
/// to a file path mirrors the full child stream there.
const ENV_DEBUG_LOG: &str = "DSH_DESKTOP_DEBUG";

/// Mirror one line to the debug log when it is enabled.
pub(crate) fn debug_log(line: &str) {
    let redacted = remote_control::redact(line);
    let line = redacted.as_str();
    let Some(path) = std::env::var_os(ENV_DEBUG_LOG) else {
        return;
    };
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(path))
    {
        let _ = writeln!(file, "{line}");
    }
}

/// Record a child event in the diagnostic log.
fn record(app: &AppHandle, state: &Shared, event: ChildEvent, instance: u64) {
    if let Ok(mut guard) = state.lock() {
        if guard.ui.backend_instance != instance || guard.ui.phase == ui_snapshot::UiPhase::Exiting
        {
            return;
        }
        match event {
            ChildEvent::Log(line) => {
                let line = remote_control::redact(&line);
                debug_log(&format!("[log] {line}"));
                guard.push_log(line)
            }
            ChildEvent::Ready(url) => {
                let origin = public_origin(&url);
                debug_log(&format!("[ready] {origin}"));
                guard.push_log(format!("就绪：{origin}"))
            }
            // Handled by `record_appearance`, which also re-colors the window;
            // reaching here means it was already applied, so only log it.
            ChildEvent::Theme(report) => guard.push_log(format!("外观：{:?}", report.preference)),
            ChildEvent::Notify(payload) => {
                debug_log(&format!(
                    "[notify] kind={} title={} body={}",
                    payload.kind, payload.title, payload.body
                ));
                guard.push_log(format!("通知：{} {}", payload.kind, payload.title))
            }
            ChildEvent::Exited(code) => {
                debug_log(&format!("[exit] {code}"));
                if code >= 0 {
                    guard.push_log(format!("dsh 进程已退出（退出码 {code}）"));
                }
            }
        }
    }
    let _ = app;
}

/// Diagnostics for a failed start: the child's own stderr first, then the log.
///
/// stderr is the authoritative place a Node process reports why it refused to
/// boot (a bad flag, a missing module, a port it could not take), so it leads.
fn failure_details(state: &Shared) -> Vec<String> {
    let mut details = Vec::new();
    if let Ok(guard) = state.lock() {
        if let Some(process) = guard.process.as_ref() {
            details.extend(process.stderr_tail(20));
        }
        if details.is_empty() {
            details.extend(guard.log_tail(20));
        }
    }
    details
}

/// Point the window at the GUI URL.
fn navigate(app: &AppHandle, url: &str) {
    if app
        .state::<Shared>()
        .lock()
        .map(|s| {
            matches!(
                s.ui.phase,
                ui_snapshot::UiPhase::Destroying
                    | ui_snapshot::UiPhase::Minimal
                    | ui_snapshot::UiPhase::Exiting
            )
        })
        .unwrap_or(true)
    {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match url.parse::<tauri::Url>() {
        Ok(parsed) => {
            if let Err(error) = window.navigate(parsed) {
                let state = app.state::<Shared>().inner().clone();
                fail(
                    app,
                    &state,
                    format!("无法打开界面：{error}"),
                    "请重试，或在浏览器中打开日志里的地址。",
                );
            }
        }
        Err(error) => {
            let state = app.state::<Shared>().inner().clone();
            fail(app, &state, format!("就绪地址无效：{error}"), "请重试。");
        }
    }
}

/// Stop the child process and any running install.
///
/// Only explicit application exit and final run-loop cleanup own this operation.
/// Destroying a WebView window does not end the backend's lifetime.
pub(crate) fn shutdown_runtime(app: &AppHandle) {
    terminal::shutdown(app);
    let (process, installer, snapshot) = {
        let state = app.state::<Shared>();
        let Ok(mut guard) = state.lock() else {
            return;
        };
        if guard.ui.phase != ui_snapshot::UiPhase::Exiting {
            guard.ui.transition(ui_snapshot::UiPhase::Exiting);
        }
        (
            guard.process.take(),
            guard.installer.take(),
            guard.ui.snapshot.take(),
        )
    };
    // Killing/waiting and temporary-file cleanup must happen outside the shared lock.
    if let Some(installer) = installer {
        installer.cancel();
    }
    drop(process);
    drop(snapshot);
}

/// Why the window is built with [`disable_drag_drop_handler`].
///
/// **This app has no use for Tauri's drag-drop events, and DSH needs the browser
/// ones.** The two are mutually exclusive on Windows, and Tauri's is on by default.
///
/// What Tauri does by default: `tauri-runtime-wry` installs a `drag_drop_handler`,
/// and `wry` then does two things that between them remove the feature —
///
/// ```text
/// controller.SetAllowExternalDrop(false)        // WebView2: "do not accept drops"
/// RegisterDragDrop(hwnd, IDropTarget)           // OLE: the HWND becomes the drop target
/// ```
///
/// and returns `DROPEFFECT_COPY` from `IDropTarget::DragEnter`. The specification
/// behind `AllowExternalDrop` describes exactly the interval this app lives in:
/// while external drop is off, drag events are reported *only* through the
/// controller's own `DragEnter`/`DragLeave`/`Drop` events, and the HTML5 drag
/// events — `dragenter`, `dragover`, `dragleave`, `drop` — are **not** raised in
/// the page.
///
/// That is the whole bug. `dsh-client-ui-attachment` drives its drop overlay and
/// its file intake from document-level HTML5 listeners:
///
/// ```js
/// document.addEventListener("dragenter", onDragEnter)   // sets dragActive → overlay
/// document.addEventListener("dragover",  onDragOver)    // preventDefault → the drop is not
/// document.addEventListener("drop",      onDrop)        //               cancelled by the OS
/// ```
///
/// With the handler installed the page is never told a drag happened, so the
/// placeholder never appears and a drop is swallowed by the webview's drop target
/// before it can become an attachment. Nothing in the frontend can fix that: the
/// events are not delivered, so no listener, injected script, or overlay rule can
/// observe them. It is the host's flag or nothing.
///
/// Nothing is lost by turning it off, because this app never registered a
/// `on_drag_drop_event` listener and reads no `tauri://drag-*` event in Rust or in
/// its own UI — the notifications it does show come from the child process's
/// stdout, not from a drop. Tauri's own bookkeeping that comes with the events
/// (`scopes.allow_file` for a dropped path) is equally unused: this app opens no
/// file by path from the page, and the `fs` plugin is not a dependency.
///
/// [`disable_drag_drop_handler`]: tauri::WebviewWindowBuilder::disable_drag_drop_handler
#[allow(dead_code)]
fn drag_drop_belongs_to_the_page() {}

/// Whether a webview URL belongs to this app's own bundled UI.
///
/// Once the window navigates to the DSH server it becomes a remote origin. Tauri's
/// capability system already withholds these commands from it, but `retry_boot`
/// re-runs the install and `open_external` launches a process, so both are
/// re-checked here: a capability misconfiguration must not turn the embedded GUI
/// into a way to install arbitrary packages.
fn is_trusted_origin(app: &AppHandle, url: &tauri::Url) -> bool {
    match url.scheme() {
        // The custom protocol Tauri serves bundled assets from.
        "tauri" => true,
        // The app's own page in whichever form this build serves it: the custom
        // protocol when packaged, the configured `devUrl` under `tauri dev`.
        // Delegating keeps this list from drifting away from the IPC gate's.
        "http" | "https" => ui_snapshot::is_app_document(app, url),
        _ => false,
    }
}

/// Reject a command invoked from a page this app does not own.
fn require_trusted_origin(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    if is_trusted_origin(window.app_handle(), &url) {
        Ok(())
    } else {
        Err("该操作仅允许在应用自身的界面中执行".to_string())
    }
}

// ── commands ────────────────────────────────────────────────────────────────

/// Report the current state so the UI can render the right page.
/// Report the current state so the UI can render the right page.
///
/// The probe deliberately does not run on the main thread. This command is the
/// boot page's heartbeat — `refresh()` calls it on load and on every
/// `status-changed` — and its work is expensive in cold-start terms:
/// `resolve_node` walks PATH, and `node_major` spawns `node --version` and
/// waits for the child, which Defender's real-time scan can stretch from
/// milliseconds to SECONDS (measured at 5.18 s on the machine this was found
/// on). As a synchronous command that cost was a stopped message pump: every
/// click and drag queued for as long as the spawn took while the page —
/// rendered by WebView2's own process — kept animating, which reads as "the
/// app is fine but nothing responds". That was the reported
/// "软件没卡但点不动" around the moment the interface appears. Off the main
/// thread the same latency is merely a slow answer to an await.
#[tauri::command]
async fn probe_state(state: State<'_, Shared>) -> Result<StatusReport, String> {
    let shared = state.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let node_path = dsh::resolve_node();
        let node_version = node_path
            .as_ref()
            .and_then(|path| dsh::node_major(path))
            .map(|major| format!("v{major}"));
        debug_log(&format!("[probe] node probe took {:?}", t0.elapsed()));
        let guard = shared.lock().expect("state mutex poisoned");
        state::status(&guard, node_path, node_version)
    })
    .await
    .map_err(|error| error.to_string())?)
}

/// Retry the whole startup sequence.
///
/// This is the failure screen's button, so it re-runs the install when there is
/// still no dsh: the user may have just finished the manual steps, and the point
/// of the button is to pick that up rather than to report "still missing".
#[tauri::command]
fn retry_boot(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Shared>,
) -> Result<(), String> {
    require_trusted_origin(&window)?;

    let shared = state.inner().clone();
    // A retry while a boot is already running would install twice, so it is
    // refused rather than queued.
    if let Ok(guard) = shared.lock() {
        if guard.installer.is_some() {
            return Err("安装仍在进行中".to_string());
        }
    }

    let handle = app.clone();
    std::thread::spawn(move || boot(handle));
    Ok(())
}

/// Stop a running install.
#[tauri::command]
fn cancel_install(state: State<'_, Shared>) -> Result<(), String> {
    if let Ok(mut guard) = state.lock() {
        if let Some(installer) = guard.installer.take() {
            installer.cancel();
            return Ok(());
        }
    }
    Ok(())
}

/// Install Node.js through winget.
///
/// Deliberately interactive: this changes system-wide state, so the app never
/// does it silently or unattended. A visible console owns the UAC prompt and
/// shows winget's own progress and result text, and the user can read it before
/// anything is installed.
#[tauri::command]
fn install_node(window: tauri::WebviewWindow) -> Result<(), String> {
    require_trusted_origin(&window)?;

    #[cfg(windows)]
    {
        if dsh::find_on_path("winget").is_none() {
            return Err("未找到 winget，请从 nodejs.org 手动安装 Node.js".to_string());
        }
        // `cmd /k` keeps the window open so the outcome stays readable, and the
        // arguments are fixed constants rather than anything user-supplied.
        std::process::Command::new("cmd.exe")
            .args([
                "/k",
                "winget install --id OpenJS.NodeJS --exact --source winget && echo. && echo 安装完成，请回到 DeepseekHarness 点击「重新检测」。",
            ])
            .spawn()
            .map_err(|error| format!("无法启动 winget：{error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".to_string())
    }
}

/// Open a URL in the system browser, for install guidance.
#[tauri::command]
fn open_external(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    require_trusted_origin(&window)?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http(s) 链接".to_string());
    }
    #[cfg(windows)]
    {
        // Avoids a shell: the URL is validated above and passed as one argv entry.
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags_no_window()
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, url);
        Err("仅支持 Windows".to_string())
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn platform_unsupported() -> Result<(), String> {
    Err("仅支持 Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window's own source, so a builder call can be asserted from a test.
    const MAIN_RS: &str = include_str!("main.rs");

    /// The window builder chain, from the `WebviewWindowBuilder` call to its
    /// `build()`.
    ///
    /// Scoped deliberately: `disable_drag_drop_handler` appears in the prose
    /// around the builder as well, and a whole-file `contains` would pass on a
    /// comment that had drifted away from the call it documents.
    ///
    /// @returns the slice of source holding the builder calls.
    fn window_builder_chain() -> &'static str {
        let start = MAIN_RS
            .find("WebviewWindowBuilder::new")
            .expect("the main window must still be built in code");
        let rest = &MAIN_RS[start..];
        let end = rest
            .find(".build()")
            .expect("the builder chain must still end in build()");
        &rest[..end]
    }

    /// The body of `create_main_window`, up to its closing brace.
    ///
    /// Closing braces inside the function are all indented, so the first
    /// `\n}` is the function's own end — the same scoping trick
    /// [`window_builder_chain`] uses to keep an assertion from being satisfied
    /// by prose elsewhere in the file.
    ///
    /// @returns the slice of source holding the window setup calls.
    fn create_main_window_body() -> &'static str {
        let start = MAIN_RS
            .find("fn create_main_window")
            .expect("create_main_window must still exist");
        let rest = &MAIN_RS[start..];
        let end = rest.find("\n}").expect("create_main_window must still end");
        &rest[..end]
    }

    #[test]
    fn the_window_installs_the_stale_drag_guard() {
        // Drags are entered asynchronously: `start_dragging` posts
        // `WM_NCLBUTTONDOWN` and the modal move loop starts when the main
        // thread pumps it, which on a cold start (Defender scanning the new
        // exe, WebView2 initializing, the DSH page load flooding the queue)
        // can lag seconds past the click that requested it. A loop armed after
        // the release captures the mouse and eats every click until the next
        // one — the reported "软件没卡但点不动" on the packaged exe. The
        // command's IPC-time check cannot see a release that happens after it
        // runs, so the pump-time subclass is the part that closes the race;
        // losing this call loses it silently, on the exact window the title
        // bar drags from.
        assert!(
            create_main_window_body().contains("drag_guard::install(&window)"),
            "create_main_window must install the stale-drag guard on the main window"
        );
    }

    #[test]
    fn the_window_hands_file_drops_to_the_page() {
        // Tauri installs a drag-drop handler by default, and on Windows that is
        // mutually exclusive with the HTML5 drag events DSH listens for: `wry`
        // calls `SetAllowExternalDrop(false)` and registers its own OLE drop
        // target, after which the page never sees `dragenter`/`dragover`/`drop`.
        // The visible result is that dropping a file on the window shows no
        // placeholder and attaches nothing — the page cannot recover, because the
        // events are never delivered. Only this flag fixes it.
        assert!(
            window_builder_chain().contains(".disable_drag_drop_handler()"),
            "the window must call disable_drag_drop_handler(), or the page never receives the \
             HTML5 drag events that drive DSH's drop overlay and file attachment"
        );
    }

    /// This file's *code*, with the test module and every comment line removed.
    ///
    /// Both exclusions are load-bearing. The test module names the forbidden
    /// identifiers in its own assertions, so a whole-file scan would fail on the
    /// test that forbids them; and this file deliberately documents the mechanism
    /// in prose, so a comment could otherwise both satisfy a check for a call and
    /// trip a check for its absence.
    ///
    /// @returns the lines that could actually run.
    fn implementation_code() -> String {
        let end = MAIN_RS.find("#[cfg(test)]").unwrap_or(MAIN_RS.len());
        MAIN_RS[..end]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn nothing_consumes_tauri_drag_events() {
        // The flag is only safe while this holds. If a `tauri://drag-*` listener
        // is ever added, turning the handler off would silently break it — this
        // test is what turns that into a failing build instead.
        let code = implementation_code();
        for forbidden in ["on_drag_drop_event", "tauri://drag", "DragDropEvent"] {
            assert!(
                !code.contains(forbidden),
                "`{forbidden}` expects Tauri's drag-drop handler, which this window disables: \
                 the page needs the HTML5 events instead"
            );
        }
    }

    /// The lines a real failed install ends with, taken from a run against an
    /// unreachable registry. Note the boilerplate after the cause — that is what
    /// a naive "last npm error line" picks up, and it names a log file rather
    /// than a reason.
    fn refused_transcript() -> Vec<String> {
        [
            "npm info using npm@11.16.0",
            "npm info using node@v24.18.0",
            "npm error code ECONNREFUSED",
            "npm error syscall connect",
            "npm error FetchError: request to http://127.0.0.1:9/@deepseek-ai%2fdsh failed",
            "npm error A complete log of this run can be found in: C:\\Users\\x\\npm-cache\\_logs\\2026-09-24T09_52_54_121Z-debug-0.log",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    #[test]
    fn npm_failure_reports_the_cause_not_the_log_path() {
        let message = describe_npm_failure(&refused_transcript());
        assert!(message.contains("ECONNREFUSED"), "got: {message}");
        assert!(
            !message.contains("debug-0.log"),
            "the log path is boilerplate, not the cause: {message}"
        );
        assert!(message.starts_with("npm 安装失败"), "got: {message}");
    }

    #[test]
    fn npm_failure_falls_back_to_a_tagged_line_when_there_is_no_code_line() {
        let transcript =
            vec!["npm error EACCES: permission denied, mkdir 'C:\\Program Files'".to_string()];
        let message = describe_npm_failure(&transcript);
        assert!(message.contains("EACCES"), "got: {message}");
    }

    #[test]
    fn npm_failure_without_error_lines_still_says_something_useful() {
        let transcript = vec!["npm info using npm@11.16.0".to_string()];
        let message = describe_npm_failure(&transcript);
        assert!(message.contains("退出码非零"), "got: {message}");
    }

    #[test]
    fn npm_failure_tolerates_an_empty_transcript() {
        assert!(describe_npm_failure(&[]).contains("退出码非零"));
    }

    /// The `CloseRequested` arm of the window-event handler, up to the next
    /// event arm.
    ///
    /// Scoped like [`window_builder_chain`]: the prose around the handler
    /// discusses the old close behaviour, so a whole-file scan would pass on a
    /// comment describing what this test forbids.
    ///
    /// @returns the slice of source holding the close handling.
    fn close_requested_arm() -> &'static str {
        let start = MAIN_RS
            .find("WindowEvent::CloseRequested")
            .expect("the window-event handler must still arm CloseRequested");
        let rest = &MAIN_RS[start..];
        let end = rest
            .find("WindowEvent::Destroyed")
            .expect("the handler must keep an arm after CloseRequested");
        &rest[..end]
    }

    #[test]
    fn closing_the_main_window_hides_it_to_the_tray() {
        // The close button hides the window rather than quitting it, so the DSH
        // child keeps running (and notifying) with no window on screen. Both
        // halves are load-bearing: without `prevent_close` the window is
        // destroyed before `hide` matters, and without `hide` the close request
        // is swallowed but the window lingers.
        let arm = close_requested_arm();
        assert!(
            arm.contains("api.prevent_close()"),
            "the close request must be prevented, or the window is destroyed"
        );
        assert!(
            arm.contains("window.hide()"),
            "the window must be hidden, or a prevented close leaves it on screen"
        );
    }

    #[test]
    fn closing_no_longer_tears_the_runtime_down() {
        // The old CloseRequested handler called `shutdown_runtime`, which would
        // now kill the DSH child the moment the user "closed" to the tray —
        // an invisible app that had stopped doing the one thing it is for. The
        // teardown belongs to the tray's 退出 and to `Destroyed` only.
        let arm = close_requested_arm();
        assert!(
            !arm.contains("shutdown_runtime"),
            "CloseRequested must not stop the runtime; the tray's 退出 owns that now"
        );
    }

    #[test]
    fn the_tray_is_installed_at_setup() {
        // The icon is installed from launch rather than on first close, so the
        // way back into a hidden window always exists.
        assert!(
            MAIN_RS.contains("tray::install(app.handle())?"),
            "setup must install the tray icon next to the window"
        );
    }

    /// The tray module's source, so its menu can be asserted from a test.
    const TRAY_RS: &str = include_str!("tray.rs");

    /// The tray menu handler's 退出 arm, up to the catch-all arm.
    ///
    /// @returns the slice of source holding the quit handling.
    fn tray_quit_arm() -> &'static str {
        let start = TRAY_RS
            .find("ID_QUIT =>")
            .expect("the tray menu must arm a quit item");
        let rest = &TRAY_RS[start..];
        let end = rest
            .find("_ => {}")
            .expect("the menu handler must keep a catch-all after ID_QUIT");
        &rest[..end]
    }

    #[test]
    fn the_tray_menu_carries_the_three_requested_actions() {
        // The tray is the only real exit now, so the menu is not decoration:
        // each of these labels is a behaviour the user reaches for with no
        // window on screen.
        for label in ["显示主界面", "极简模式", "退出"] {
            assert!(TRAY_RS.contains(label), "the tray menu must offer {label}");
        }
    }

    #[test]
    fn the_tray_quit_tears_the_runtime_down_before_exiting() {
        // This is the ONLY path that ends the app now. If it exited without
        // stopping the child, "closing the window" would hide it and "quitting"
        // would leave an orphaned DSH process tree — the exact lingering state
        // the old close path existed to prevent.
        let arm = tray_quit_arm();
        assert!(arm.contains("crate::minimal::exit(app)"));
        let lifecycle = include_str!("minimal.rs");
        let arm = &lifecycle[lifecycle.find("pub fn exit(").unwrap()..];
        let shutdown = arm
            .find("crate::shutdown_runtime(")
            .expect("退出 must stop the child process");
        let exit = arm.rfind("app.exit(0)").expect("退出 must end the app");
        assert!(
            shutdown < exit,
            "the child teardown must run before app.exit, not after"
        );
    }

    #[test]
    fn the_tray_menu_is_right_click_only_and_left_click_shows_the_window() {
        // The menu is a right-click affordance; a left click is the one
        // affordance a hidden window has that needs no reading — pointing at
        // the icon brings the app back. Both settings are load-bearing: with
        // the default menu-on-left-click, pointing would open a menu instead
        // of the window.
        assert!(
            TRAY_RS.contains("show_menu_on_left_click(false)"),
            "the tray menu must open on right click only"
        );
        assert!(
            TRAY_RS.contains("MouseButton::Left"),
            "the tray must handle a left click of its own"
        );
    }

    #[test]
    fn the_minimal_mode_item_is_a_toggle_now() {
        // 极简模式 shipped as an inert placeholder; it now toggles the mode.
        // The arm must route through `minimal::toggle` and carry no marker of
        // the old pending work — a leftover TODO here would misdescribe the
        // behaviour the menu actually has.
        let start = TRAY_RS
            .find("ID_MINIMAL =>")
            .expect("the tray menu must arm a minimal-mode item");
        let rest = &TRAY_RS[start..];
        let end = rest
            .find("ID_QUIT =>")
            .expect("the minimal arm must end before ID_QUIT");
        let arm = &rest[..end];
        assert!(
            arm.contains("crate::minimal::toggle"),
            "the 极简模式 item must toggle the mode, not sit inert"
        );
        assert!(
            !arm.contains("TODO(极简模式)"),
            "the pending-work marker must go once the behaviour lands"
        );
        // A toggle reads as one in the menu: the item is a checkbox, and the
        // applied state is written back to it so the mark cannot lie.
        assert!(
            TRAY_RS.contains("CheckMenuItem::with_id(app, ID_MINIMAL"),
            "极简模式 must be a CheckMenuItem, or the menu cannot show the mode"
        );
    }
}
