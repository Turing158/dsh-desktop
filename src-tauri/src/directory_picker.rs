//! The desktop workspace chooser stays native even when DSH serves remote browsers.

use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub async fn pick_workspace_directory(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    crate::window_controls::validate_window(&window)?;
    let page = window.url().map_err(|e| e.to_string())?;
    let identity = {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        if !crate::remote_control::allowed_origin(&page, &state.phase) {
            return Err("Workspace selection requires the current desktop page".into());
        }
        crate::remote_control::identity(&state)
    };
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let title = crate::locale::text(
        window.app_handle(),
        "选择工作区目录",
        "Choose workspace folder",
    );
    let label = crate::locale::text(window.app_handle(), "选择文件夹", "Select folder");
    // COM's modal message loop must not run inside a WebView2 callback.
    let directory =
        tauri::async_runtime::spawn_blocking(move || pick_directory(owner, title, label))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    crate::window_controls::validate_window(&window)?;
    {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        if crate::remote_control::identity(&state) != identity
            || window.url().map_err(|e| e.to_string())? != page
            || !crate::remote_control::allowed_origin(&page, &state.phase)
        {
            return Err("The workspace page changed; please select the folder again".into());
        }
    }
    Ok(directory.map(|path| path.to_string_lossy().into_owned()))
}

pub(crate) fn pick_directory(
    owner: usize,
    title: &str,
    label: &str,
) -> windows::core::Result<Option<PathBuf>> {
    pick_path(owner,title,label,true)
}
pub(crate) fn pick_file(owner: usize, title: &str, label: &str) -> windows::core::Result<Option<PathBuf>> {
    pick_path(owner,title,label,false)
}
fn pick_path(owner: usize, title: &str, label: &str, folder: bool) -> windows::core::Result<Option<PathBuf>> {
    #[cfg(debug_assertions)]
    if let Some(selection) = smoke_selection(folder) { return Ok(selection); }
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{HRESULT, HSTRING};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
        FOS_PICKFOLDERS, FOS_FILEMUSTEXIST, SIGDN_FILESYSPATH,
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
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | if folder { FOS_PICKFOLDERS } else { FOS_FILEMUSTEXIST }
                | FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_NOCHANGEDIR,
        )?;
        dialog.SetTitle(&HSTRING::from(title))?;
        dialog.SetOkButtonLabel(&HSTRING::from(label))?;
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
// Explicit isolated-test selector. Release builds always use the native picker;
// no IPC accepts a filename or activates this branch.
#[cfg(debug_assertions)]
fn smoke_selection(folder: bool) -> Option<Option<PathBuf>> {
    let root = PathBuf::from(std::env::var_os("DSH_DESKTOP_SMOKE_DIR")?).canonicalize().ok()?;
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("dialog-selection.json")).ok()?).ok()?;
    let selected = &value[if folder {"folder"} else {"file"}];
    if selected.is_null() {return Some(None)}
    let path = PathBuf::from(selected.as_str()?);
    let info = std::fs::symlink_metadata(&path).ok()?;
    if info.file_type().is_symlink() {return Some(None)}
    let path = path.canonicalize().ok()?;
    if !path.starts_with(&root) || folder && !info.is_dir() || !folder && !info.is_file() {return Some(None)}
    Some(Some(path))
}
