//! Ordinary close-to-tray visibility only. UI destruction/restoration belongs
//! to minimal.rs; a missing window is expected and is a safe no-op here.

use tauri::{AppHandle, Manager};

/// The main window's webview, or `None` once the window is gone.
///
/// Reached through `AsRef<Webview>` because [`tauri::WebviewWindow::hide`] is
/// the WINDOW's hide — the exact confusion this module exists to remove. The
/// explicit return type is what disambiguates the two `AsRef` impls (the other
/// is `Window`), and both window and webview share the label `main`.
pub fn main_webview(app: &AppHandle) -> Option<tauri::Webview<tauri::Wry>> {
    app.get_webview_window("main")
        .map(|window| window.as_ref().clone())
}

/// Whether the webview should be painting right now.
///
/// Named as a predicate rather than a sync so the answer can be asserted in a
/// unit test without an `AppHandle`; [`sync`] is the only caller that matters.
///
/// @param window_visible - whether the main window is on screen.
/// @param minimal - whether 极简模式 is on.
/// @returns whether the webview belongs on screen.
pub fn should_show(window_visible: bool, minimal: bool) -> bool {
    window_visible && !minimal
}

/// Put the webview into the visibility its two owners agree on.
///
/// Idempotent, and cheap enough to call on every path that changes either
/// input: an already-correct webview is re-shown, which WebView2 treats as a
/// no-op repaint, not a navigation. Nothing here navigates or rebuilds, which is
/// what keeps 极简模式's restore contract (see [`crate::minimal`]) intact.
///
/// Missing state or a missing window leaves the webview alone: there is no
/// answer to compute, and guessing one would fight the feature that does own it.
///
/// @param app - the app handle.
pub fn sync(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let minimal = app
        .state::<crate::state::Shared>()
        .lock()
        .map(|guard| guard.minimal)
        .unwrap_or(false);
    let Some(webview) = main_webview(app) else {
        return;
    };
    let want = should_show(window.is_visible().unwrap_or(false), minimal);
    // Both directions are safe to issue unconditionally — the failure mode this
    // guards against is a webview left in the wrong state, and a redundant
    // `show`/`hide` costs one WebView2 call.
    let result = if want { webview.show() } else { webview.hide() };
    if let Err(error) = result {
        crate::debug_log(&format!("[webview] sync({want}) failed: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_follows_window_and_applied_minimal_state() {
        assert!(should_show(true, false));
        assert!(!should_show(true, true));
        assert!(!should_show(false, false));
        assert!(!should_show(false, true));
    }
    #[test]
    fn ordinary_visibility_never_navigates_or_rebuilds() {
        let code = include_str!("webview.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!code.contains(".navigate("));
        assert!(!code.contains("WebviewWindowBuilder"));
    }
    #[test]
    fn all_show_intents_use_the_lifecycle_owner() {
        let tray = include_str!("tray.rs");
        let start = tray.find("pub(crate) fn show_main_window").unwrap();
        let body = &tray[start..];
        let body = &body[..body.find("\n}").unwrap()];
        assert!(body.contains("crate::minimal::show(app)"));
        assert!(include_str!("minimal.rs").contains("crate::webview::sync(app)"));
        assert!(include_str!("main.rs").contains("tray::show_main_window(app)"));
    }
}
