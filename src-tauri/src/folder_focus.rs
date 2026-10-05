//! Making a directory launch actually SHOW its window.
//!
//! ## The measured failure this exists for
//!
//! The directory actions post to the app's own launcher route, and the route
//! answers `{ok: true}` — the shell ran `explorer.exe <path>`. Yet on this
//! machine the user repeatedly saw nothing. The diagnostics log recorded
//! `ok: true` for every click, and enumerating the shell windows explained it:
//! frames for the requested folders EXISTED — at real screen coordinates, not
//! minimized, not on another virtual desktop — but in a HIDDEN state
//! (`WS_VISIBLE` unset on the frame). For an already-open folder the shell
//! focuses the existing frame instead of opening a new one, and that focus does
//! not clear the hidden state, so a successful launch changed nothing on
//! screen. The user's report — 菜单里点了没反应 — was exactly that.
//!
//! ## What this command does
//!
//! After a successful launch the page calls [`focus_folder_window`], which
//! enumerates the top-level Explorer folder windows (`CabinetWClass`), matches
//! the frame whose title is the launched folder's name (Explorer titles a folder
//! window with the folder's own name — verified against this machine), and
//! makes it visible and foregrounded. It answers `false` when no frame matched,
//! which is the fresh-window case: a brand-new frame the shell shows itself.
//!
//! ## The surface stays narrow
//!
//! The command only ever SHOWS and FOREGROUNDS a window — it never hides,
//! moves, closes, or resizes one, and it matches by class plus title so it
//! cannot reach a window that is not an Explorer folder window.

#![cfg(windows)]

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, IsIconic, IsWindowVisible, SetForegroundWindow,
    ShowWindow, SW_RESTORE,
};

/// The window class every Explorer folder window carries.
const CABINET_CLASS: &str = "CabinetWClass";

/// The folder name a launched path points at, for title matching.
///
/// Trailing separators are ignored, so `C:\projects\alpha\` and `C:\projects\alpha`
/// match the same frame. The root of a drive (`C:\`) yields `C:`, whose frame is
/// titled with the volume label (`本地磁盘 (C:)`) and will NOT match — that case
/// degrades to "no frame found", the same as a fresh window, and the shell's own
/// answer stands.
pub fn folder_name_of(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rsplit(['\\', '/']).next() {
        Some(name) if !name.is_empty() => name,
        // `C:\` trimmed to `C:` — rsplit yields `C:`; but a path of only
        // separators yields nothing, and an empty name matches nothing.
        _ => "",
    }
}

/// Whether an Explorer frame title names the folder.
///
/// Explorer titles the frame with the folder's own name (verified live:
/// `DeepseekHarness-desktop`, `StarFallHub`, `Users`). A suffix is tolerated for
/// shells that decorate the title (`alpha - 文件资源管理器`), but a bare PREFIX
/// is not enough — `docs` must not match `docs-archive`. All slicing goes
/// through `str::get`, which answers `None` at a non-character boundary, so a
/// multi-byte title cannot panic the match.
fn title_matches_folder(title: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let title = title.trim();
    let Some(head) = title.get(..name.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(name) {
        return false;
    }
    match title.get(name.len()..) {
        None => true,
        Some("") => true,
        Some(rest) => rest.starts_with(" - ") || rest.starts_with(" — "),
    }
}

/// What to do with one matched frame.
struct Frame {
    hwnd: HWND,
    visible: bool,
    iconic: bool,
}

/// Collect the Explorer folder frames whose title names `folder`.
fn frames_named(folder: &str, out: &mut Vec<Frame>) {
    struct Ctx<'a> {
        folder: &'a str,
        out: &'a mut Vec<Frame>,
    }
    let mut ctx = Ctx { folder, out };
    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut ctx as *mut Ctx as isize),
        );
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx<'_>) };
        let mut class = [0u16; 32];
        let len = unsafe { GetClassNameW(hwnd, &mut class) };
        let class = String::from_utf16_lossy(&class[..len.max(0) as usize]);
        if class != CABINET_CLASS {
            return true.into();
        }
        let mut title = [0u16; 256];
        let len = unsafe { GetWindowTextW(hwnd, &mut title) };
        let title = String::from_utf16_lossy(&title[..len.max(0) as usize]);
        if !title_matches_folder(&title, ctx.folder) {
            return true.into();
        }
        ctx.out.push(Frame {
            hwnd,
            visible: unsafe { IsWindowVisible(hwnd).as_bool() },
            iconic: unsafe { IsIconic(hwnd).as_bool() },
        });
        true.into()
    }
}

/// Pick the frame most worth showing: a hidden one first (the bug case), then a
/// minimized one, then any.
fn pick<'a>(frames: &'a [Frame]) -> Option<&'a Frame> {
    frames
        .iter()
        .find(|f| !f.visible)
        .or_else(|| frames.iter().find(|f| f.iconic))
        .or_else(|| frames.first())
}

/// Find the Explorer frame for `path` and make it visible and foregrounded.
///
/// Returns whether a frame was found and shown. `false` is the normal answer
/// for a freshly opened folder — the shell shows its own new window — and for
/// paths whose frame cannot be named (a drive root).
pub fn show_folder_window(path: &str) -> Result<bool, String> {
    let folder = folder_name_of(path);
    if folder.is_empty() {
        return Ok(false);
    }

    let mut frames = Vec::new();
    frames_named(folder, &mut frames);
    let Some(frame) = pick(&frames) else {
        return Ok(false);
    };

    // SW_RESTORE both unhides a hidden frame and un-minimizes an iconic one; on
    // an already-visible frame it is a no-op. Foregrounding afterwards is what
    // makes the shown window the one the user is looking at; it can fail under
    // Windows' foreground lock, and showing is still the part that fixes the
    // reported bug, so a foreground refusal is not an error.
    unsafe {
        // `ShowWindow`'s BOOL answers whether the window was already visible —
        // irrelevant either way: the show is unconditional and the foreground
        // call below reports on its own.
        let _ = ShowWindow(frame.hwnd, SW_RESTORE);
    }
    let _ = unsafe { SetForegroundWindow(frame.hwnd) };
    Ok(true)
}

/// The Tauri command the page calls after a successful directory launch.
///
/// `path` is the same absolute directory the launch was given. Errors mean the
/// enumeration itself failed; a missing frame is `Ok(false)`, not an error.
#[tauri::command]
pub fn focus_folder_window(window: tauri::WebviewWindow, path: String) -> Result<bool, String> {
    crate::window_controls::validate_window(&window)?;
    if path.trim().is_empty() {
        return Err("path is empty".to_string());
    }
    show_folder_window(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_takes_the_last_segment() {
        assert_eq!(folder_name_of(r"D:\projects\alpha"), "alpha");
        assert_eq!(folder_name_of(r"D:\projects\alpha\"), "alpha");
        assert_eq!(folder_name_of("D:/projects/alpha/"), "alpha");
        assert_eq!(folder_name_of(r"\\server\share\dir"), "dir");
    }

    #[test]
    fn folder_name_of_a_drive_root_is_the_drive() {
        assert_eq!(folder_name_of(r"C:\"), "C:");
        // And a title check against a volume label will simply not match, which
        // is the documented degradation.
        assert!(!title_matches_folder("本地磁盘 (C:)", folder_name_of(r"C:\")));
    }

    #[test]
    fn titles_match_by_folder_name() {
        assert!(title_matches_folder("alpha", "alpha"));
        assert!(title_matches_folder("ALPHA", "alpha"));
        assert!(title_matches_folder("alpha - 文件资源管理器", "alpha"));
        assert!(title_matches_folder("alpha — File Explorer", "alpha"));
    }

    #[test]
    fn a_bare_prefix_is_not_a_match() {
        // `docs` must not reach `docs-archive` — the reason matching checks the
        // character after the name rather than stopping at the prefix.
        assert!(!title_matches_folder("docs-archive", "docs"));
        assert!(!title_matches_folder("alphax", "alpha"));
    }

    #[test]
    fn empty_names_match_nothing() {
        assert!(!title_matches_folder("anything", ""));
        assert!(!title_matches_folder("", "alpha"));
    }
}
