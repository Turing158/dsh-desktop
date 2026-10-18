//! The title bar that exists before DSH does.
//!
//! The window is created with `decorations(false)`, so the app draws its own
//! caption — but the app's real bar is a **DSH client plugin**
//! (`dsh-plugin/title-bar/client.js`), and a client plugin only runs once DSH's
//! plugin tree has mounted. Everything before that moment is a page with no
//! caption and no window controls at all: a decorationless window cannot be
//! moved, minimized, or closed from the OS.
//!
//! There are two such pages, and the second one is easy to forget:
//!
//!   1. The app's own boot page (`src-tauri/ui/`) — onboarding, install progress,
//!      and the error screen. Served from the app's private protocol.
//!   2. The DSH page itself, while it still shows its own "Loading plugins…"
//!      splash. This is the longer of the two: `dsh web` serves `index.html`
//!      immediately, and the client plugin tree can take seconds to mount.
//!
//! ## Why a document-created script
//!
//! `WebviewWindowBuilder::initialization_script` hands the source to WebView2's
//! `AddScriptToExecuteOnDocumentCreated`, which runs it before any page script on
//! **every top-level navigation**. One registration therefore covers both pages
//! above and any future reload, with no cooperation from either.
//!
//! **It also runs in subframes, and Tauri cannot turn that off on Windows.** The
//! builder has `initialization_script_for_all_frames`, but its counterpart
//! `with_initialization_script_for_main_only` is documented in `wry` as ignored on
//! Windows: scripts reach subframes regardless. DSH renders same-origin iframes —
//! the document preview is built from a base64 payload — so the injected script
//! guards itself with `window.top === window`. Without that check the bar would
//! draw a second strip inside every preview pane. The guard is asserted by
//! `dsh-plugin/titlebar-boot.test.mjs`, because it is invisible from this side.
//!
//! The alternatives were all worse:
//!
//!   - **Injecting through the DSH webserver** (the `webserver/index-inject` seam
//!     the overlay uses) reaches page 2 and not page 1, which is the page the user
//!     sees when something has gone wrong and most needs a close button.
//!   - **A second, transparent child webview over the caption strip** would work,
//!     but pulls in Tauri's `unstable` feature for what is one HTML element.
//!   - **A local page that then navigates** would still be replaced on navigation,
//!     losing the bar exactly when the DSH page starts loading.
//!
//! ## Handoff
//!
//! The injected bar retires itself when the real one announces that it is on
//! screen (`dsh-desktop:titlebar-ready`, plus a `data-dsh-titlebar` attribute that
//! survives a missed event). Until then it stays — which is what makes a failed
//! boot recoverable rather than a window with no way out.
//!
//! ## How the source reaches the webview
//!
//! Read from disk in development and embedded in release builds. Unlike the icons
//! (`app_icon.rs`), the file is not embedded unconditionally: at ~20 KB it is
//! small enough that either would do, but in development the release resource
//! directory does not exist and `include_str!` alone would freeze the bar at
//! compile time — so editing it would need a full rebuild instead of the window
//! reload every other overlay asset needs.

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Resolved colors from the running DSH, retained across update navigations.
/// Values are assigned through CSS properties, never interpolated into CSS text.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub dark: bool,
    pub background: String,
    pub foreground: String,
    pub border: String,
}

impl Palette {
    pub fn bounded(self) -> Option<Self> {
        [&self.background, &self.foreground, &self.border]
            .iter()
            .all(|color| !color.is_empty() && color.len() <= 128)
            .then_some(self)
    }
}

#[derive(Default)]
pub struct UpdatePresentation {
    pub palette: Option<Palette>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootContext {
    local: bool,
    restoring: bool,
    updating: bool,
    palette: Option<Palette>,
}

/// Available before the DSH modules load, on the same origins as window controls.
#[tauri::command]
pub fn desktop_boot_context(window: tauri::WebviewWindow) -> Result<BootContext, String> {
    crate::window_controls::validate_window(&window)?;
    let url = window.url().map_err(|_| "window-origin")?;
    let shared = window.state::<crate::state::Shared>();
    let state = shared.lock().map_err(|_| "window-state")?;
    Ok(BootContext {
        local: crate::ui_snapshot::is_app_document(window.app_handle(), &url),
        restoring: state.ui.snapshot.is_some(),
        updating: state.update_presentation.is_some(),
        palette: state.update_presentation.as_ref().and_then(|update| update.palette.clone()),
    })
}

/// Resource-relative location of the injected bar.
#[cfg(not(feature = "single"))]
const BAR_RESOURCE: &str = "dsh-plugin/title-bar/boot.js";

/// The release-build copy of [`BAR_RESOURCE`].
///
/// `include_str!` rather than an embedded copy in `resources/`: the bundle
/// manifest already ships the plugin directory, so reading it from the resource
/// directory keeps one file on disk, and this constant is the fallback for the
/// case where that file is somehow missing — a hand-stripped install should still
/// get a title bar.
const BAR_EMBEDDED: &str = include_str!("../../dsh-plugin/title-bar/boot.js");

/// The bar's source, ready to hand to the webview.
///
/// Development prefers the file on disk so an edit plus **Ctrl+R** is enough to
/// see a change, matching how `theme.css` and `dom.js` are treated. A release
/// build has the same file as a bundled resource, so the fallback chain is:
/// resource directory, then the repository path (development only), then the
/// compiled-in copy.
///
/// The embedded copy is never `None`, which is deliberate: a window with no title
/// bar cannot be closed, so this must not have a failure mode that returns
/// nothing.
///
/// @param app - the app handle, for the resource directory.
/// @returns the script source.
#[cfg(feature = "single")]
pub fn source(_app: &tauri::AppHandle) -> String {
    BAR_EMBEDDED.to_string()
}

#[cfg(not(feature = "single"))]
pub fn source(app: &tauri::AppHandle) -> String {
    use tauri::Manager;

    if let Ok(dir) = app.path().resource_dir() {
        if let Ok(text) = std::fs::read_to_string(dir.join(BAR_RESOURCE)) {
            return text;
        }
    }

    // Development: resources are not copied next to the debug binary, and the
    // repository path is where the file actually lives. Preferring the file on
    // disk is what makes an edit plus **Ctrl+R** enough to see a change, matching
    // how `theme.css` and `dom.js` are treated — `include_str!` alone would freeze
    // the bar at compile time.
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join(BAR_RESOURCE));
    if let Some(candidate) = dev {
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            return text;
        }
    }

    // The compiled-in copy. A window with no title bar cannot be closed, so this
    // must not have a failure mode that returns nothing.
    BAR_EMBEDDED.to_string()
}

/// Build the initialisation script registered with the webview.
///
/// The guard is the same one `ui-overlay/dom.js` uses for its right-click
/// listener, and for the same reason: WebView2 can evaluate an
/// `AddScriptToExecuteOnDocumentCreated` script more than once in one document
/// (a frame that re-runs scripts, a second registration during development), and
/// a second bar would be a second set of window controls stacked on the first.
/// The script guards itself too; this wrapper is what makes the *injected* source
/// recognisable to a reader of the Rust side.
///
/// @param app - the app handle, for the resource directory.
/// @returns the script text.
pub fn initialization_script(app: &tauri::AppHandle) -> String {
    format!("window.__DSH_DESKTOP_BOOT_HOST__ = true;\n{}\n{}", crate::locale::initialization_script(app), source(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_bar_is_a_classic_script() {
        // It is injected as a plain <script> body, so `import`/`export` would be
        // a syntax error and top-level `await` would be too — and the failure
        // would be silent, because a document-created script that throws leaves
        // the page without a bar and nothing to show for it.
        assert!(
            !BAR_EMBEDDED.contains("\nimport "),
            "the bar must not use import statements"
        );
        assert!(
            !BAR_EMBEDDED.contains("\nexport "),
            "the bar must not use export statements"
        );
        assert!(
            !BAR_EMBEDDED.contains("\nawait "),
            "the bar must not use top-level await"
        );
    }

    #[test]
    fn the_bar_guards_against_double_evaluation() {
        // A second evaluation must not build a second bar: both would be visible,
        // stacked in the same strip, with two sets of window controls.
        assert!(
            BAR_EMBEDDED.contains("__dshDesktopTitleBarBoot"),
            "the bar must carry the once-only guard flag"
        );
    }

    #[test]
    fn the_bar_refuses_to_mount_inside_a_subframe() {
        // WebView2 runs document-created scripts in subframes, and on Windows
        // Tauri cannot restrict them to the main frame (`for_main_frame_only` is
        // ignored — see the module header). DSH renders same-origin iframes for
        // the document preview, so without this guard the bar appears inside every
        // one of them. The behaviour is asserted in `titlebar-boot.test.mjs`; this
        // is the check that the guard is still in the shipped source.
        assert!(
            BAR_EMBEDDED.contains("window.top !== window"),
            "the bar must refuse to mount in a subframe"
        );
    }

    #[test]
    fn the_bar_retires_on_the_announcement_the_client_plugin_sends() {
        // The two halves are in different worlds — one is an injected classic
        // script, the other a browser bundle — so this name is the entire contract
        // between them. A typo leaves both bars on screen forever.
        const CLIENT: &str = include_str!("../../dsh-plugin/title-bar/client.js");
        assert!(
            BAR_EMBEDDED.contains("dsh-desktop:titlebar-ready"),
            "the bar must listen for the ready event"
        );
        assert!(
            CLIENT.contains("dsh-desktop:titlebar-ready"),
            "the client plugin must announce the ready event"
        );
        assert!(
            BAR_EMBEDDED.contains("data-dsh-titlebar"),
            "the bar must also check the durable ready marker"
        );
        assert!(
            CLIENT.contains("data-dsh-titlebar"),
            "the client plugin must set the durable ready marker"
        );
    }
}
