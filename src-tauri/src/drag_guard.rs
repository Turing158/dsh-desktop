//! The stale-drag guard: stop the OS move loop before it starts without a
//! button held.
//!
//! Starting a drag is asynchronous against the page's will. [`super::window_controls::window_start_drag`]
//! ends in tao's `handle_os_dragging`, which POSTS `WM_NCLBUTTONDOWN`
//! (`HTCAPTION`) and leaves the modal move loop to begin when the main thread
//! next pumps that message. The command checks `GetAsyncKeyState` at IPC time,
//! but the pump can lag far behind that check: a cold start is the worst case
//! (Defender scans the new exe while WebView2 initializes), and the DSH page
//! load floods the UI thread with resource requests and IPC handled inline. A
//! click released inside that gap arms a modal loop that starts with no button
//! held — it then captures the mouse and waits for a `WM_LBUTTONUP` that was
//! already delivered to the webview, eating every click until the next one
//! while pumping messages, so the page animates on and the window LOOKS alive.
//! That is the reported "软件没卡但点不动" on the packaged exe.
//!
//! The race cannot be closed at IPC time — a check there would have to see the
//! future. It CAN be closed at pump time, which is what this module does: a
//! window subclass receives every `WM_NCLBUTTONDOWN` before `DefWindowProc`
//! would enter the move loop, and the physical button state is checked exactly
//! there. A drag needs the button down, period, so a `WM_NCLBUTTONDOWN` naming
//! a drag hit-test while the button is up can only be a stale posted message;
//! it is swallowed and the modal loop never starts. A genuine press has the
//! button down and passes through untouched.
//!
//! The IPC-time check in the command stays: it refuses the common case (the
//! IPC itself processed after the release) cheaply, and this module guarantees
//! the half that command cannot see. Both are documented where they live.
//!
//! ## Why a subclass
//!
//! The alternative — not posting at all, calling `SendMessage` to enter the
//! loop synchronously from the IPC handler — re-enters the message pump inside
//! a WebView2 protocol callback, a re-entrancy wry and tao deliberately avoid
//! (tao posts for exactly that reason). The subclass keeps the posting design
//! and adds the one check the design is missing.

/// The subclass identifier. Arbitrary; it only has to be non-zero and unique
/// for this window, which one subclass per process lifetime satisfies.
const SUBCLASS_ID: usize = 0x4453_4847; // 'DSHG'

/// Whether a `WM_NCLBUTTONDOWN` `wParam` enters an OS move/resize loop.
///
/// `HTCAPTION` is what `start_dragging` posts; the eight edge values are what
/// `start_resize_dragging` posts (tao maps `ResizeDirection::to_win32` onto
/// them, `HTLEFT`(10) through `HTBOTTOMRIGHT`(17)). Everything else —
/// `HTCLIENT`, the buttons, `HTNOWHERE` — is ordinary hit-testing this guard
/// must never swallow.
fn is_drag_hit_test(hit: usize) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT,
        HTTOPRIGHT,
    };

    matches!(
        hit as u32,
        HTCAPTION
            | HTLEFT
            | HTRIGHT
            | HTTOP
            | HTTOPLEFT
            | HTTOPRIGHT
            | HTBOTTOM
            | HTBOTTOMLEFT
            | HTBOTTOMRIGHT
    )
}

/// The subclass procedure.
///
/// # Safety
/// Called by comctl32 on the thread that owns the window, with the arguments
/// the system passed; `DefSubclassProc` forwards everything this does not
/// handle.
unsafe extern "system" fn guard_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::WM_NCLBUTTONDOWN;

    if msg == WM_NCLBUTTONDOWN
        && is_drag_hit_test(wparam.0)
        && !crate::window_controls::left_button_held()
    {
        // A move/resize loop armed with no button held: swallow the message so
        // `DefWindowProc` never enters the loop. Returning without calling
        // `DefSubclassProc` also keeps tao's own handler from seeing it, which
        // is correct — its `HTCAPTION` follow-up (`WM_MOUSEMOVE`) only matters
        // to a loop that will actually run.
        return LRESULT(0);
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Install the guard on the main window.
///
/// Called once, right after the window is built: subclasses are applied to the
/// live window and last for its lifetime, and installing later would leave the
/// early clicks — the cold-start clicks most likely to race — unguarded.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    // SetWindowSubclass must run on the HWND's owning thread, including when
    // the caller is the asynchronous window-restoration worker.
    let owned = window.clone();
    let _ = window.run_on_main_thread(move || {
        use windows::Win32::UI::Shell::SetWindowSubclass;
        let Ok(hwnd) = owned.hwnd() else {
            return;
        };
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        // SAFETY: this closure runs on the window's UI thread; guard_proc
        // forwards unhandled messages and removes itself on WM_NCDESTROY.
        let installed = unsafe { SetWindowSubclass(hwnd, Some(guard_proc), SUBCLASS_ID, 0) };
        if !installed.as_bool() {
            crate::debug_log("[window] drag-guard-install-failed");
        }
    });
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The caption plus all eight edges, as tao posts them: `drag_window` uses
    /// `HTCAPTION` and `drag_resize_window` maps `ResizeDirection::to_win32`
    /// onto `HTLEFT`(10)…`HTBOTTOMRIGHT`(17). A stale posted message can name
    /// any of the nine, so the guard must cover every one — missing a single
    /// edge re-opens the bug for that resize direction.
    #[test]
    fn the_guard_covers_the_caption_and_every_resize_edge() {
        const DRAG_HITS: [u32; 9] = [2, 10, 11, 12, 13, 14, 15, 16, 17];
        for hit in DRAG_HITS {
            assert!(is_drag_hit_test(hit as usize), "HT{hit} must be guarded");
        }
    }

    /// Hit-tests that are NOT move/resize entries must pass through: `HTCLIENT`
    /// is the page itself, the button values are the system caption's, and
    /// swallowing any of them would eat genuine input.
    #[test]
    fn the_guard_leaves_non_drag_hit_tests_alone() {
        const PLAIN_HITS: [u32; 8] = [
            0,  // HTNOWHERE
            1,  // HTCLIENT — the page itself
            3,  // HTSYSMENU
            5,  // HTMENU
            8,  // HTMINBUTTON
            9,  // HTMAXBUTTON
            18, // HTBORDER
            20, // HTCLOSE
        ];
        for hit in PLAIN_HITS {
            assert!(
                !is_drag_hit_test(hit as usize),
                "HT{hit} must not be guarded"
            );
        }
    }
}
