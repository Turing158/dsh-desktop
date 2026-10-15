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

use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
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
fn open_clipboard_for(owner: Option<HWND>) -> io::Result<()> {
    for attempt in 0..OPEN_RETRIES {
        // SAFETY: a null owner is documented as valid for the current task.
        let opened = unsafe { OpenClipboard(owner) };
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

fn open_clipboard() -> io::Result<()> {
    open_clipboard_for(None)
}

/// Supply both PNG (lossless alpha) and CF_DIBV5 (native Windows image paste).
/// A real owner HWND is required when EmptyClipboard precedes SetClipboardData.
pub fn write_image(owner: usize, png: &[u8]) -> io::Result<()> {
    use windows::core::w;
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Ole::CF_DIBV5;

    let dib = png_dib(png)?;
    let png_memory = ClipboardMemory::new(png)?;
    let dib_memory = ClipboardMemory::new(&dib)?;
    unsafe {
        let format = RegisterClipboardFormatW(w!("PNG"));
        if format == 0 {
            return Err(io::Error::last_os_error());
        }
        open_clipboard_for(Some(HWND(owner as *mut _)))?;
        let result = (|| {
            EmptyClipboard().map_err(io::Error::other)?;
            png_memory.publish(format)?;
            dib_memory.publish(CF_DIBV5.0 as u32)
        })();
        let _ = CloseClipboard();
        result
    }
}

/// Frees a movable block on all failure paths, until Windows takes ownership.
struct ClipboardMemory(HGLOBAL);
impl ClipboardMemory {
    fn new(bytes: &[u8]) -> io::Result<Self> {
        unsafe {
            let memory = Self(GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(io::Error::other)?);
            let pointer = GlobalLock(memory.0) as *mut u8;
            if pointer.is_null() {
                return Err(io::Error::last_os_error());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
            let _ = GlobalUnlock(memory.0);
            Ok(memory)
        }
    }

    fn publish(self, format: u32) -> io::Result<()> {
        unsafe {
            SetClipboardData(format, Some(HANDLE(self.0 .0))).map_err(io::Error::other)?;
        }
        std::mem::forget(self);
        Ok(())
    }
}
impl Drop for ClipboardMemory {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(Some(self.0));
        }
    }
}

fn png_dib(bytes: &[u8]) -> io::Result<Vec<u8>> {
    const MAX_DECODED: usize = 256 * 1024 * 1024;
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits { bytes: MAX_DECODED },
    );
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(io::Error::other)?;
    let (width, height) = reader.info().size();
    let size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|s| s.checked_mul(4))
        .filter(|&s| s > 0 && s <= MAX_DECODED)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Image dimensions are too large")
        })?;
    if reader.output_buffer_size() > MAX_DECODED {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Decoded image is too large",
        ));
    }
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut pixels).map_err(io::Error::other)?;
    pixels.truncate(info.buffer_size());
    // BITMAPV5HEADER followed by top-down BGRA pixels. Explicit little-endian
    // fields avoid relying on Rust struct padding or alignment in clipboard data.
    let mut dib = vec![0u8; 124 + size];
    for (offset, value) in [
        (0, 124u32),
        (4, width),
        (8, (-(height as i32)) as u32),
        (16, 3), // BI_BITFIELDS
        (20, size as u32),
        (40, 0x00ff0000),
        (44, 0x0000ff00),
        (48, 0x000000ff),
        (52, 0xff000000),
        (56, 0x73524742), // LCS_sRGB
        (108, 4),         // LCS_GM_IMAGES
    ] {
        dib[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    for (pixel, target) in pixels
        .chunks_exact(info.color_type.samples())
        .zip(dib[124..].chunks_exact_mut(4))
    {
        let rgba = match info.color_type {
            png::ColorType::Rgba => [pixel[0], pixel[1], pixel[2], pixel[3]],
            png::ColorType::Rgb => [pixel[0], pixel[1], pixel[2], 255],
            png::ColorType::Grayscale => [pixel[0], pixel[0], pixel[0], 255],
            png::ColorType::GrayscaleAlpha => [pixel[0], pixel[0], pixel[0], pixel[1]],
            png::ColorType::Indexed => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "PNG palette was not expanded",
                ))
            }
        };
        target.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
    }
    Ok(dib)
}

#[cfg(test)]
mod image_tests {
    use super::*;

    fn encoded(color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 1, 2);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(pixels)
            .unwrap();
        bytes
    }

    #[test]
    fn clipboard_bitmap_preserves_dimensions_colors_alpha_and_row_order() {
        let dib = png_dib(&encoded(
            png::ColorType::Rgba,
            &[10, 20, 30, 0, 40, 50, 60, 128],
        ))
        .unwrap();
        assert_eq!(&dib[4..8], &1u32.to_le_bytes());
        assert_eq!(&dib[8..12], &(-2i32).to_le_bytes());
        assert_eq!(&dib[52..56], &0xff000000u32.to_le_bytes());
        assert_eq!(&dib[124..], &[30, 20, 10, 0, 60, 50, 40, 128]);
    }

    #[test]
    fn clipboard_accepts_rgb_and_grayscale_pngs_and_rejects_corrupt_data() {
        for (color, pixels, expected) in [
            (
                png::ColorType::Rgb,
                vec![1, 2, 3, 4, 5, 6],
                vec![3, 2, 1, 255, 6, 5, 4, 255],
            ),
            (
                png::ColorType::Grayscale,
                vec![7, 8],
                vec![7, 7, 7, 255, 8, 8, 8, 255],
            ),
            (
                png::ColorType::GrayscaleAlpha,
                vec![7, 0, 8, 128],
                vec![7, 7, 7, 0, 8, 8, 8, 128],
            ),
        ] {
            assert_eq!(
                &png_dib(&encoded(color, &pixels)).unwrap()[124..],
                &expected
            );
        }
        assert!(png_dib(b"broken PNG").is_err());
    }
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
                io::Error::new(
                    io::ErrorKind::Other,
                    format!("EmptyClipboard failed: {error}"),
                )
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
