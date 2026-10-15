//! The notification-area icon: the app's home once its window is "closed".
//!
//! Closing the window hides it instead of quitting (see the `CloseRequested`
//! handler in `main.rs`), so the tray icon is what the user comes back through:
//! left-click shows the window again, right-click opens a menu with
//! 显示主界面 / 极简模式 / 退出. The menu is the only real exit — that is what
//! keeps a hidden window from meaning an invisible process tree: the DSH child
//! keeps running while the window is hidden, which is the point (notifications
//! keep arriving), and 退出 tears it down before the process goes away.
//!
//! The first two menu actions are not the same thing, and the difference is the
//! whole of 极简模式: 显示主界面 brings the window back *and* leaves the mode (it
//! means "give me the interface back"), while 极简模式 takes the window off
//! screen entirely — see [`crate::minimal`]. Both end by re-deriving whether the
//! webview belongs on screen, because that answer is not a consequence of the
//! window's visibility alone; [`crate::webview`] owns it.
//!
//! ## Why the tray is installed in code, not in `tauri.conf.json`
//!
//! Tauri 2 supports a declarative `trayIcon` config key, but it cannot express
//! the two behaviours this icon needs: the per-item `on_menu_event` routing and
//! the left-click show/right-click menu split (`show_menu_on_left_click(false)`).
//! The icon is therefore built here, next to the window it mirrors — which is
//! also where the window is created in code, for the same shape of reason.
//!
//! ## The icon image
//!
//! `default_window_icon` is the same artwork tauri-build embeds for the taskbar
//! (`icons/icon.ico`, the brand-blue whale): on Windows targets the codegen step
//! always turns the configured `.ico` into the app's default icon, so the tray
//! reuses it rather than carrying a second file that could drift. A missing
//! image degrades to a platform-default tray icon rather than failing setup —
//! an icon-less tray is still a working menu.

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

/// The tray icon's id, unique within this app's icon list.
const TRAY_ID: &str = "dsh-tray";

/// Menu item id: show the main window again.
const ID_SHOW: &str = "show";
/// Menu item id: toggle 极简模式 (see [`crate::minimal`]).
const ID_MINIMAL: &str = "minimal";
/// Menu item id: the real exit.
const ID_QUIT: &str = "quit";

/// Handles for confirmed-state checkmarks, busy states, and recovery labels.
pub struct TrayMenu {
    /// The 极简模式 checkbox, kept for `set_checked` from the menu handler.
    pub minimal: CheckMenuItem<Wry>,
    pub show: MenuItem<Wry>,
    pub quit: MenuItem<Wry>,
}

/// Route every display request through the lifecycle owner, including when
/// no main window exists or restoration is already in progress.
pub(crate) fn show_main_window(app: &AppHandle) {
    crate::minimal::show(app);
}

/// Re-assert the 极简模式 checkmark from the mode's real state.
///
/// The mark must describe what the app did, not what a click guessed — and
/// there are two paths that change the mode now (the menu item and
/// [`show_main_window`]), so neither may own the mark alone or the menu would
/// claim a mode the app is not in.
pub(crate) fn sync_checkmark(app: &AppHandle) {
    if let Some(handles) = app.try_state::<TrayMenu>() {
        let _ = handles.minimal.set_text(crate::locale::text(app, "极简模式", "Minimal mode"));
        let _ = handles.quit.set_text(crate::locale::text(app, "退出", "Quit"));
        let _ = handles.minimal.set_checked(crate::minimal::is_on(app));
        let _ = handles.minimal.set_enabled(!crate::minimal::busy(app));
        let failed = app
            .state::<crate::state::Shared>()
            .lock()
            .map(|s| s.ui.phase == crate::ui_snapshot::UiPhase::RestoreFailed)
            .unwrap_or(false);
        let _ = handles.show.set_text(if failed {
            crate::locale::text(app, "重试恢复主界面", "Retry restoring main window")
        } else {
            crate::locale::text(app, "显示主界面", "Show main window")
        });
    }
}

/// Install the tray icon. Called once from setup, next to the window creation.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ID_SHOW, "显示主界面", true, None::<&str>)?;
    let minimal = CheckMenuItem::with_id(app, ID_MINIMAL, crate::locale::text(app, "极简模式", "Minimal mode"), true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, crate::locale::text(app, "退出", "Quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &minimal, &quit])?;

    // Kept past this function so the handler can sync the checkmark; see
    // [`TrayMenu`].
    app.manage(TrayMenu {
        minimal: minimal.clone(),
        show: show.clone(),
        quit: quit.clone(),
    });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("dsh desktop")
        .menu(&menu)
        // The menu is a RIGHT-click affordance; a left click brings the window
        // back (the handler below). Leaving the default would open the menu on
        // both buttons and leave the window unreachable by pointing alone.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_SHOW => show_main_window(app),
            ID_MINIMAL => {
                // The shared flag is the truth; the checkbox follows it. The
                // re-assert costs nothing when the platform already toggled the
                // mark, and repairs it when the platform did not.
                crate::minimal::toggle(app);
                sync_checkmark(app);
            }
            ID_QUIT => {
                // The tray is now the only path that actually quits, so the
                // child teardown that the old close path ran lives here.
                crate::minimal::exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
