//! Window controls and clipboard access for the custom title bar.
//!
//! The window is created without native decorations, so every window affordance
//! the OS used to provide — move, resize, minimize, maximize, close — is driven
//! from the page instead. This module is the Rust end of that: the Tauri commands
//! the title bar calls.
//!
//! ## Why these are commands rather than core Tauri permissions
//!
//! Tauri's built-in `core:window` permissions (`allow-minimize`,
//! `allow-start-dragging`, …) would cover most of this, but they are ACL-gated per
//! origin, and this window's content is served from `http://127.0.0.1:<port>` —
//! a **remote** origin as far as Tauri is concerned. Granting that origin the
//! core window permissions means writing a capability with a `remote.urls` entry,
//! which grants the page far more than a title bar needs.
//!
//! Ordinary app commands are also ACL-gated, but they are gated by *our* manifest,
//! so the surface stays exactly the five verbs below. Nothing here can move or
//! resize a window that is not ours, and nothing reads a file.
//!
//! ## Clipboard
//!
//! The WebView cannot do this itself. `navigator.clipboard.readText()` needs a
//! permission prompt that a decorationless shell has no browser UI to answer (it
//! throws `NotAllowedError`), and `document.execCommand('paste')` is not
//! supported by WebView2. So cut/copy/paste run through Win32 directly.

use tauri::{AppHandle, Manager};

/// Bring the window to the foreground, unminimizing if needed.
fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    Ok(window)
}

/// Whether the left mouse button is physically held right now.
///
/// Read with `GetAsyncKeyState`, which reports the live global input state —
/// unlike the webview's event stream, which the page controls synthetically.
/// `crate::drag_guard` reuses this same definition at pump time; two different
/// notions of "held" for the same button is how the two checks drift apart.
pub(crate) fn left_button_held() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0 }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Start an interactive move, as a caption drag would.
///
/// The page calls this from a pointer-down on the bar, so the OS owns the drag:
/// it keeps working when the pointer leaves the window, and it participates in
/// snap-to-edge and the shake-to-minimize gesture.
///
/// ## Why the command refuses when the button is already up
///
/// `start_dragging` does not enter the move loop synchronously — it posts
/// `WM_NCLBUTTONDOWN` and the loop starts when the main thread pumps it. If the
/// main thread was busy at the moment of the press (a cold start is the worst:
/// Defender scans the new exe while WebView2 initializes), that pump happens
/// AFTER the user has already released, and the modal loop then waits for a
/// `WM_LBUTTONUP` that was consumed long ago. The loop pumps messages — the
/// loading card keeps animating — but it eats every mouse click until the next
/// one, which is precisely the reported "软件没卡但点不动" on the boot screen.
/// A drag needs the button down, period; skipping the stale request is one half
/// of the fix.
///
/// ## Why one check here is not the whole fix
///
/// This check runs when the IPC is dispatched, but the modal loop starts when
/// the posted message is pumped — and a release inside that gap cannot be seen
/// from here, because the check would have to see the future. On a cold start
/// the gap is seconds wide, which is how the packaged exe kept reproducing the
/// symptom with this check in place. [`crate::drag_guard`] closes the other
/// half: its subclass re-checks the button at pump time, exactly where the loop
/// would start, and swallows the stale message. Both checks stay — this one
/// refuses the cheap-and-common case, that one is the guarantee the loop never
/// starts without a button.
#[tauri::command]
pub fn window_start_drag(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    validate_window(&window)?;
    if !left_button_held() {
        return Ok(());
    }
    main_window(&app)?
        .start_dragging()
        .map_err(|error| error.to_string())
}

/// Start an interactive resize from an edge or corner.
///
/// `direction` is a lowercase compass name (`north`, `south-east`, …) matching
/// `tauri::ResizeDirection`. It arrives as a string because the page has no way to
/// name a Rust enum, and an unknown value is rejected rather than guessed.
///
/// Guarded by the same button check as [`window_start_drag`]: the resize loop is
/// the same modal `WM_NCLBUTTONDOWN` mechanism with the same stale-press hazard.
#[tauri::command]
pub fn window_start_resize(
    window: tauri::WebviewWindow,
    app: AppHandle,
    direction: String,
) -> Result<(), String> {
    validate_window(&window)?;
    use tauri_runtime::ResizeDirection;

    let direction = match direction.as_str() {
        "east" => ResizeDirection::East,
        "north" => ResizeDirection::North,
        "north-east" => ResizeDirection::NorthEast,
        "north-west" => ResizeDirection::NorthWest,
        "south" => ResizeDirection::South,
        "south-east" => ResizeDirection::SouthEast,
        "south-west" => ResizeDirection::SouthWest,
        "west" => ResizeDirection::West,
        other => return Err(format!("unknown resize direction {other:?}")),
    };

    if !left_button_held() {
        return Ok(());
    }

    // `start_resize_dragging` lives on `Window`, not `WebviewWindow`; the webview
    // exposes its owning window through `AsRef`.
    let window = main_window(&app)?;
    window
        .as_ref()
        .window()
        .start_resize_dragging(direction)
        .map_err(|error| error.to_string())
}

/// Minimize the window.
#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    validate_window(&window)?;
    main_window(&app)?
        .minimize()
        .map_err(|error| error.to_string())
}

/// Toggle between maximized and restored.
#[tauri::command]
pub fn window_toggle_maximize(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<bool, String> {
    validate_window(&window)?;
    let window = main_window(&app)?;
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(!maximized)
}

/// Whether the window is currently maximized, so the button can show the right glyph.
#[tauri::command]
pub fn window_is_maximized(window: tauri::WebviewWindow, app: AppHandle) -> Result<bool, String> {
    validate_window(&window)?;
    main_window(&app)?
        .is_maximized()
        .map_err(|error| error.to_string())
}

/// Close the window, running the same teardown as the native close button.
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    validate_window(&window)?;
    main_window(&app)?
        .close()
        .map_err(|error| error.to_string())
}

/// Read the clipboard as text.
///
/// Returns `None` for an empty or non-text clipboard rather than an error: the
/// title bar uses this to decide whether Paste is available, and "nothing to
/// paste" is an ordinary state, not a failure.
#[cfg(windows)]
#[tauri::command]
pub fn clipboard_read_text(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    validate_window(&window)?;
    crate::clipboard::read_text().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_read_text(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    validate_window(&window)?;
    Ok(None)
}

/// Write text to the clipboard.
///
/// The page supplies the text because it already knows its own selection, which
/// makes Copy deterministic. Cut is different — see [`clipboard_edit_shortcut`].
#[cfg(windows)]
#[tauri::command]
pub fn clipboard_write_text(window: tauri::WebviewWindow, text: String) -> Result<(), String> {
    validate_window(&window)?;
    crate::clipboard::write_text(&text).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_write_text(window: tauri::WebviewWindow, _text: String) -> Result<(), String> {
    validate_window(&window)?;
    Err("clipboard is only supported on Windows".to_string())
}

/// Send a native `Ctrl+<key>` edit chord to the focused element.
///
/// Used for **cut** and **paste**, not copy. DSH's composer is a controlled
/// contenteditable, so a scripted edit is reverted on the next React render:
/// `execCommand('insertText', …)` reports success and fires a real `input` event,
/// and the text vanishes a frame later. Only a genuine native edit produces the
/// event sequence the controlled input accepts.
///
/// Scoped to this process — the chord is refused unless the focused window is
/// ours, so a title-bar menu can never type into another application.
///
/// @param key - `c`, `v`, or `x`.
#[cfg(windows)]
#[tauri::command]
pub fn clipboard_edit_shortcut(window: tauri::WebviewWindow, key: String) -> Result<bool, String> {
    validate_window(&window)?;
    // Only c/v/x are meaningful here; anything else is a caller bug, and the
    // Rust side rejects it rather than sending an arbitrary Ctrl chord.
    crate::clipboard::send_edit_shortcut(&key).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_edit_shortcut(window: tauri::WebviewWindow, _key: String) -> Result<bool, String> {
    validate_window(&window)?;
    Ok(false)
}

/// Dynamic capabilities are origin-specific; this guard also rejects origins
/// from previous backend instances after they have been replaced.
pub(crate) fn validate_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "window-origin")?;
    let shared = window.state::<crate::state::Shared>();
    let state = shared.lock().map_err(|_| "window-state")?;
    if window.label() != "main"
        || !crate::ui_snapshot::allowed_origin(window.app_handle(), &url, &state.phase)
    {
        return Err("window-origin".into());
    }
    Ok(())
}
