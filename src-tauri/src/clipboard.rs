//! Direct Win32 clipboard access.
//!
//! ## Why not the WebView APIs
//!
//! Wiring the 编辑 menu through the page alone is not possible here, and each
//! route was measured rather than assumed:
//!
//!   - `navigator.clipboard.readText()` requires a permission prompt. The window
//!     has no native decorations and therefore no browser chrome to show one, and
//!     the promise never settles — it hangs rather than rejecting.
//!   - `document.execCommand('paste')` reports `false` from
//!     `queryCommandSupported` in WebView2; paste is deliberately not
//!     scriptable, because it would let any page read the clipboard silently.
//!   - `navigator.clipboard.writeText()` DOES work, and is used for Copy/Cut —
//!     but it needs the text, which the page has and the clipboard does not.
//!
//! So the clipboard is touched from Rust. That is also the more honest boundary:
//! the page never gains general clipboard access, it can only read what this
//! window put there and write what the user explicitly asked to copy.

#![cfg(windows)]

use std::io;

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// How many times to retry opening the clipboard, and how long to wait between
/// attempts.
///
/// The clipboard is a single global resource: another process holding it is
/// routine (a clipboard manager, or any app mid-copy), not an error. Without a
/// retry, a copy attempt that collides produces a spurious failure.
const OPEN_RETRIES: u32 = 5;
const OPEN_RETRY_DELAY_MS: u64 = 20;

/// Open the clipboard, retrying briefly while another process holds it.
fn open_clipboard() -> io::Result<()> {
    for attempt in 0..OPEN_RETRIES {
        // SAFETY: a null owner is documented as valid for the current task.
        let opened = unsafe { OpenClipboard(None) };
        if opened.is_ok() {
            return Ok(());
        }
        if attempt + 1 < OPEN_RETRIES {
            std::thread::sleep(std::time::Duration::from_millis(OPEN_RETRY_DELAY_MS));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "the clipboard is held by another process",
    ))
}

/// Read the clipboard as text.
///
/// @returns the text, or `Ok(None)` when the clipboard holds no text at all —
///   which is the ordinary "nothing to paste" state, distinct from a failure.
pub fn read_text() -> io::Result<Option<String>> {
    // SAFETY: each call is checked; the clipboard is closed in every path below.
    unsafe {
        // `IsClipboardFormatAvailable` returns a Result — Ok means present.
        // Checked before opening, so a clipboard holding only an image or files
        // is not treated as an error.
        if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
            return Ok(None);
        }

        open_clipboard()?;

        let result = (|| -> io::Result<Option<String>> {
            let handle = match GetClipboardData(CF_UNICODETEXT.0 as u32) {
                Ok(handle) => handle,
                // The format disappeared between the check and the open: also
                // just "nothing to paste".
                Err(_) => return Ok(None),
            };
            if handle.is_invalid() {
                return Ok(None);
            }

            // The clipboard returns a HANDLE that is really an HGLOBAL; the two
            // are distinct newtypes in this crate, so the pointer is carried
            // across rather than the handle being reinterpreted.
            let memory = HGLOBAL(handle.0);
            let pointer = GlobalLock(memory) as *const u16;
            if pointer.is_null() {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    "could not lock the clipboard buffer",
                ));
            }

            // A clipboard string is NUL-terminated UTF-16. Bound the scan so a
            // malformed buffer without a terminator cannot run away.
            const MAX_UNITS: usize = 1 << 22; // 4M UTF-16 units
            let mut length = 0usize;
            while length < MAX_UNITS && *pointer.add(length) != 0 {
                length += 1;
            }
            let slice = std::slice::from_raw_parts(pointer, length);
            let text = String::from_utf16_lossy(slice);

            let _ = GlobalUnlock(memory);
            Ok(Some(text))
        })();

        let _ = CloseClipboard();
        result
    }
}

/// Replace the clipboard contents with `text`.
pub fn write_text(text: &str) -> io::Result<()> {
    // UTF-16 with a terminating NUL, as CF_UNICODETEXT requires.
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let byte_len = utf16.len() * std::mem::size_of::<u16>();

    // SAFETY: the allocation is checked, filled within its bounds, and handed to
    // the clipboard, which takes ownership on success.
    unsafe {
        open_clipboard()?;

        let result = (|| -> io::Result<()> {
            EmptyClipboard().map_err(|error| {
                io::Error::new(io::ErrorKind::Other, format!("EmptyClipboard failed: {error}"))
            })?;

            // GMEM_MOVEABLE is required by SetClipboardData.
            let memory = GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|error| {
                io::Error::new(io::ErrorKind::Other, format!("GlobalAlloc failed: {error}"))
            })?;

            let pointer = GlobalLock(memory) as *mut u16;
            if pointer.is_null() {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    "could not lock the clipboard buffer",
                ));
            }
            std::ptr::copy_nonoverlapping(utf16.as_ptr(), pointer, utf16.len());
            let _ = GlobalUnlock(memory);

            // On success the clipboard owns the block and must not be freed here.
            // `SetClipboardData` takes a HANDLE, while the allocation is an
            // HGLOBAL — distinct newtypes over the same pointer, so it is carried
            // across rather than reinterpreted.
            if let Err(error) = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0))) {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("SetClipboardData failed: {error}"),
                ));
            }
            Ok(())
        })();

        let _ = CloseClipboard();
        result
    }
}

/// Send a `Ctrl+<key>` chord to the focused window.
///
/// ## Why Cut and Paste need this, and Copy does not
///
/// DSH's composer is a **controlled** contenteditable: React owns its contents.
/// A scripted edit is therefore reverted on the next render — measured directly,
/// `document.execCommand('insertText', …)` reports `true`, fires a real `input`
/// event with `inputType: "insertText"`, and the text is gone a frame later
/// because React re-renders from its own state. Only a genuine native edit
/// produces the event sequence the controlled input accepts.
///
/// So paste and cut send real keystrokes. Copy does not need to: reading the
/// selection and writing the clipboard is a pure read of state React already
/// agrees with.
///
/// ## Scoping
///
/// The chord is only sent when the focused window belongs to this process. A
/// blind global `Ctrl+V` is a real edit in whatever application happens to be
/// focused, and a title-bar menu must never type into another program.
///
/// @param key - the letter to combine with Ctrl: `c`, `v`, or `x`.
/// @returns whether the chord was delivered.
pub fn send_edit_shortcut(key: &str) -> io::Result<bool> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, VK_C, VK_CONTROL, VK_V, VK_X,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };

    let virtual_key = match key {
        "c" => VK_C,
        "v" => VK_V,
        "x" => VK_X,
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unsupported edit shortcut {other:?}"),
            ))
        }
    };

    // SAFETY: every handle is checked before use, and the input batch is plain
    // data owned by this stack frame for the duration of the call.
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            return Ok(false);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut pid));
        if pid != std::process::id() {
            // Another application owns the focus. Not an error — just not ours.
            return Ok(false);
        }

        let thread = GetWindowThreadProcessId(foreground, None);
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // The focused child must exist: with no focus there is nothing to edit,
        // and sending anyway would be a no-op at best.
        if GetGUIThreadInfo(thread, &mut info).is_err() || info.hwndFocus.is_invalid() {
            return Ok(false);
        }

        // Ctrl down, key down, key up, Ctrl up — one batch, so no other input can
        // interleave and leave Ctrl logically stuck down.
        let mut inputs = [
            key_input(VK_CONTROL, false),
            key_input(virtual_key, false),
            key_input(virtual_key, true),
            key_input(VK_CONTROL, true),
        ];
        let sent = SendInput(&mut inputs, std::mem::size_of::<INPUT>() as i32);
        Ok(sent == inputs.len() as u32)
    }
}

/// Build one keyboard `INPUT` record for a virtual key.
///
/// Plain data with no pointers, so there is nothing to keep alive beyond the
/// call; hence no `unsafe` on this function itself.
fn key_input(
    key: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
    key_up: bool,
) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
