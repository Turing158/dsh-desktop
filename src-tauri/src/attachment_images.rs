//! Attachment actions use the desktop host: WebView2 has neither a reliable
//! ClipboardItem implementation nor the browser's Save As picker.

use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

fn decode_image(data: &str) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("Image data is empty or exceeds 64 MiB".into());
    }
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image data is empty or exceeds 64 MiB".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn clipboard_write_image(
    window: tauri::WebviewWindow,
    data: String,
) -> Result<(), String> {
    crate::window_controls::validate_window(&window)?;
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_image(&data)?;
        crate::clipboard::write_image(owner, &bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return false on cancellation. The renderer never chooses a destination path.
#[tauri::command]
pub async fn save_attachment_image(
    window: tauri::WebviewWindow,
    name: String,
    data: String,
) -> Result<bool, String> {
    crate::window_controls::validate_window(&window)?;
    let page = window.url().map_err(|e| e.to_string())?;
    let identity = {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        crate::remote_control::identity(&state)
    };
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let title = crate::locale::text(window.app_handle(), "保存图片", "Save image");
    // A modal COM dialog must run off the WebView callback thread, otherwise its
    // nested message loop can deadlock the renderer. No download is involved.
    let (bytes, path) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_image(&data)?;
        let path =
            pick_destination(owner, &image_filename(&name), title).map_err(|e| e.to_string())?;
        Ok::<_, String>((bytes, path))
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(path) = path else { return Ok(false) };
    crate::window_controls::validate_window(&window)?;
    {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        if crate::remote_control::identity(&state) != identity
            || window.url().map_err(|e| e.to_string())? != page
        {
            return Err("The attachment page changed; please save the image again".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || write_image_file(&path, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn image_filename(name: &str) -> String {
    let safe: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .take(180)
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim_end_matches(['.', ' ']);
    if safe.is_empty() {
        "image.png".into()
    } else {
        safe.into()
    }
}

fn write_image_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // A failed write must not truncate an existing image selected for overwrite.
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn pick_destination(
    owner: usize,
    name: &str,
    title: &str,
) -> windows::core::Result<Option<PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT,
        FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _apartment = Apartment;
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_OVERWRITEPROMPT
                | FOS_NOCHANGEDIR,
        )?;
        dialog.SetTitle(&HSTRING::from(title))?;
        dialog.SetFileName(&HSTRING::from(name))?;
        if let Some(extension) = Path::new(name).extension().and_then(|ext| ext.to_str()) {
            dialog.SetDefaultExtension(&HSTRING::from(extension))?;
            let pattern = HSTRING::from(format!("*.{extension}"));
            let label = HSTRING::from(format!("{} (*.{extension})", extension.to_uppercase()));
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: PCWSTR(label.as_ptr()),
                pszSpec: PCWSTR(pattern.as_ptr()),
            }])?;
        }
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                return Ok(None);
            }
            return Err(error);
        }
        let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = PathBuf::from(std::ffi::OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast()));
        Ok(Some(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_payloads_are_bounded_and_require_base64() {
        for data in ["", "%%%", "YQ"] {
            assert!(decode_image(data).is_err());
        }
        assert_eq!(decode_image("AAEC/w==").unwrap(), [0, 1, 2, 255]);
        assert!(decode_image(&"A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1)).is_err());
    }

    #[test]
    fn suggested_names_cannot_supply_a_directory() {
        assert_eq!(image_filename(r"C:\images\透明图片.PNG"), "透明图片.PNG");
        assert_eq!(image_filename("../../album/a:b?.gif"), "a_b_.gif");
        assert_eq!(image_filename(".."), "image.png");
    }

    #[test]
    fn saving_preserves_original_bytes_and_replaces_only_the_selected_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("透明图片.gif");
        std::fs::write(&path, b"old image").unwrap();
        write_image_file(&path, b"GIF89a\x00\xff").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"GIF89a\x00\xff");
        assert!(write_image_file(&path.join("invalid.png"), b"new image").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"GIF89a\x00\xff");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
