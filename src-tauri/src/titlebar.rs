//! Native window chrome: coloring the Windows title bar to match the app.
//!
//! The window keeps its **native** decorations. Rather than drawing our own
//! title bar, this module asks DWM to recolor the standard one, which preserves
//! the OS behaviours a custom bar has to reimplement and usually gets subtly
//! wrong: Snap Layouts, snap-to-edge, double-click maximize, the window menu,
//! high-contrast and accessibility themes, and per-monitor DPI.
//!
//! Colors are set through `DwmSetWindowAttribute`, available from Windows 11
//! (build 22000). On older builds every call is skipped silently and the window
//! keeps the default system chrome — the app still works, it just is not tinted.

/// One RGB color, in sRGB byte order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// Build a color from `0xRRGGBB`.
    pub const fn hex(value: u32) -> Self {
        Self {
            r: ((value >> 16) & 0xFF) as u8,
            g: ((value >> 8) & 0xFF) as u8,
            b: (value & 0xFF) as u8,
        }
    }

    /// Pack as a Windows `COLORREF`, which is `0x00BBGGRR` — the reverse of the
    /// web's `RRGGBB`. Getting this backwards swaps red and blue, producing a
    /// plausible-looking but wrong color, so it lives in one place.
    const fn colorref(self) -> u32 {
        ((self.b as u32) << 16) | ((self.g as u32) << 8) | (self.r as u32)
    }
}

/// The chrome a resolved app appearance implies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chrome {
    /// Caption (title bar) background.
    pub caption: Rgb,
    /// Caption text and the minimize/maximize/close glyphs.
    pub text: Rgb,
    /// Whether Windows should treat the window as dark for its own effects.
    pub dark: bool,
}

/// DSH's own chrome colors, so the title bar blends into the app instead of
/// banding against it.
///
/// Taken from the app's design tokens rather than invented:
/// `--dsw-specific-sidebar-fill` is `--dsw-static-neutral-bluish-50` (`#f9fafb`)
/// in the light palette and `-900` (`#1b1b1c`) in the dark one, with
/// `--dsw-alias-label-primary` supplying the matching text ink.
const LIGHT_CHROME: Chrome = Chrome {
    caption: Rgb::hex(0xF9FAFB),
    text: Rgb::hex(0x0F1115),
    dark: false,
};

const DARK_CHROME: Chrome = Chrome {
    caption: Rgb::hex(0x1B1B1C),
    text: Rgb::hex(0xF9FAFB),
    dark: true,
};

/// The chrome for a resolved light/dark decision.
pub const fn chrome_for(dark: bool) -> Chrome {
    if dark {
        DARK_CHROME
    } else {
        LIGHT_CHROME
    }
}

/// Whether DWM caption coloring is usable on the running Windows build.
///
/// `caption_color` = `DWMWA_CAPTION_COLOR`, added in Windows 11 (build 22000).
/// Below that the calls fail with `E_INVALIDARG`, so they are skipped rather
/// than logged as errors on every launch.
pub fn caption_color_supported(build: u32) -> bool {
    build >= 22000
}

#[cfg(windows)]
mod platform {
    use super::{caption_color_supported, Chrome};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    /// Set one `u32` DWM attribute. Failures are ignored on purpose: an
    /// unsupported build or a window that is already gone must not break the
    /// app's own startup or theme switching.
    unsafe fn set_u32(hwnd: HWND, attribute: i32, value: u32) {
        let attribute = windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE(attribute);
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            std::ptr::addr_of!(value).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }

    /// Ask DWM to round the window frame.
    ///
    /// A decorated window is rounded by the system automatically on Windows 11,
    /// but one created with `decorations(false)` is not, so it would sit in the
    /// desktop as a hard rectangle. This restores the same rounding the OS would
    /// have applied. `DWMWCP_DEFAULT` rather than a fixed radius, so the value
    /// tracks the user's own Windows preference.
    ///
    /// # Safety
    /// `hwnd` must be a live window handle owned by this process.
    pub unsafe fn round_corners(hwnd: HWND) {
        use windows::Win32::Graphics::Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT};

        let preference = DWMWCP_DEFAULT.0 as u32;
        let attribute = DWMWA_WINDOW_CORNER_PREFERENCE;
        // Same ignore-on-failure contract as `set_u32`: Windows 10 does not know
        // this attribute and returns an error, which leaves a square frame.
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            std::ptr::addr_of!(preference).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }

    /// Recolor the native title bar to match the app.
    ///
    /// With decorations off there is no caption to tint, but the border colour
    /// still draws the window's outer edge, so the frame is kept in step with the
    /// palette rather than left as the system default.
    ///
    /// Idempotent and cheap, so callers may apply it on every appearance change
    /// without tracking whether anything actually differs.
    ///
    /// # Safety
    /// `hwnd` must be a live window handle owned by this process.
    pub unsafe fn apply(hwnd: HWND, chrome: Chrome, build: u32) {
        // `DWMWA_USE_IMMERSIVE_DARK_MODE` exists from Windows 10 1809 onward and
        // is what tells DWM to treat the window as dark for its own effects.
        set_u32(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE.0, u32::from(chrome.dark));

        if !caption_color_supported(build) {
            return;
        }

        set_u32(hwnd, DWMWA_CAPTION_COLOR.0, chrome.caption.colorref());
        set_u32(hwnd, DWMWA_TEXT_COLOR.0, chrome.text.colorref());
        set_u32(hwnd, DWMWA_BORDER_COLOR.0, chrome.caption.colorref());
    }
}

/// Ask DWM to round the window frame.
///
/// A no-op on non-Windows targets so the module still compiles elsewhere.
#[cfg(windows)]
pub fn round_frame_corners(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
    // SAFETY: the handle comes from the live window we were handed.
    unsafe { platform::round_corners(hwnd) };
}

#[cfg(not(windows))]
pub fn round_frame_corners(_window: &tauri::WebviewWindow) {}

/// Apply chrome colors to a window.
///
/// A no-op on non-Windows targets so the module still compiles elsewhere.
#[cfg(windows)]
pub fn apply_to_window(window: &tauri::WebviewWindow, dark: bool) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
    // SAFETY: the handle comes from the live window we were handed.
    unsafe { platform::apply(hwnd, crate::titlebar::chrome_for(dark), windows_build()) };
}

#[cfg(not(windows))]
pub fn apply_to_window(_window: &tauri::WebviewWindow, _dark: bool) {}

/// The running Windows build number, cached: it cannot change while we run.
#[cfg(windows)]
pub fn windows_build() -> u32 {
    use std::sync::OnceLock;
    static BUILD: OnceLock<u32> = OnceLock::new();
    *BUILD.get_or_init(|| {
        use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
        // `RtlGetVersion` is the documented-in-practice way to get the real
        // build; `GetVersionEx` lies unless the app is manifested for the OS.
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
        }
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        // SAFETY: `info` is a correctly sized, initialized struct.
        let status = unsafe { RtlGetVersion(&mut info) };
        if status == 0 {
            info.dwBuildNumber
        } else {
            // Unknown build: assume unsupported so no failing DWM calls are made.
            0
        }
    })
}

#[cfg(not(windows))]
pub fn windows_build() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorref_packs_channels_in_bgr_order() {
        // Windows COLORREF is 0x00BBGGRR; the web value is 0xRRGGBB. Reversing
        // these swaps red and blue, which looks plausible but is wrong.
        assert_eq!(Rgb::hex(0xFF0000).colorref(), 0x0000_00FF); // red -> low byte
        assert_eq!(Rgb::hex(0x0000FF).colorref(), 0x00FF_0000); // blue -> high byte
        assert_eq!(Rgb::hex(0x00FF00).colorref(), 0x0000_FF00); // green unchanged
    }

    #[test]
    fn colorref_matches_known_good_values() {
        // Computed independently for the two chrome captions.
        assert_eq!(Rgb::hex(0xF9FAFB).colorref(), 0x00FB_FAF9);
        assert_eq!(Rgb::hex(0x1B1B1C).colorref(), 0x001C_1B1B);
    }

    #[test]
    fn chrome_matches_the_app_tokens() {
        // The caption must equal the app's own chrome fill, or the title bar
        // bands against the sidebar it sits above.
        assert_eq!(chrome_for(false).caption, Rgb::hex(0xF9FAFB)); // bluish-50
        assert_eq!(chrome_for(true).caption, Rgb::hex(0x1B1B1C)); // bluish-900
        assert!(!chrome_for(false).dark);
        assert!(chrome_for(true).dark);
    }

    #[test]
    fn caption_coloring_is_gated_on_windows_11() {
        // DWMWA_CAPTION_COLOR arrived in build 22000; older builds must skip the
        // DWM calls entirely rather than log a failure on every theme change.
        assert!(!caption_color_supported(19045)); // Windows 10 22H2
        assert!(!caption_color_supported(21999));
        assert!(caption_color_supported(22000)); // first Windows 11
        assert!(caption_color_supported(22631));
    }

    #[test]
    fn caption_and_text_contrast_in_both_palettes() {
        // A guard against a caption/text pair that would render illegible
        // glyphs: the app ships a light-off-white caption and a near-black ink,
        // and their dark counterparts.
        let light = chrome_for(false);
        let dark = chrome_for(true);
        assert!(light.caption.r > light.text.r, "light caption should be lighter than its ink");
        assert!(dark.caption.r < dark.text.r, "dark caption should be darker than its ink");
    }
}
