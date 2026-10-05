//! Single-file distribution: only the desktop overlay is embedded. Node, npm,
//! DSH and WebView2 continue to use the normal system-runtime startup path.
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/embedded_plugins.rs"));

fn fingerprint(files: &[(&str, &[u8])]) -> String {
    let mut hash = Sha256::new();
    for (name, bytes) in files {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}

pub fn prepare(cache: &Path) -> Result<PathBuf, String> {
    materialize(cache, FILES).map_err(|e| format!("无法准备内置桌面插件：{e}"))
}

fn materialize(cache: &Path, files: &[(&str, &[u8])]) -> std::io::Result<PathBuf> {
    // Content-addressed directories let different app versions coexist without
    // rewriting plugins still in use by an older process. Never use exe/CWD.
    let root = cache.join("plugins").join(fingerprint(files));
    for (relative, bytes) in files {
        let path = root.join(relative);
        if std::fs::read(&path).is_ok_and(|current| current == *bytes) {
            continue;
        }
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        // Publish each complete file atomically. A partial/modified cache is
        // repaired on the next launch; unchanged files are left untouched.
        let mut staged = tempfile::NamedTempFile::new_in(parent)?;
        staged.write_all(bytes)?;
        staged.persist(&path).map_err(|e| e.error)?;
    }
    Ok(root.join(crate::PATCH_RESOURCE))
}

pub fn check_webview() -> bool {
    if tauri::webview_version().is_ok() {
        return true;
    }
    let text = "single 版需要 Microsoft Edge WebView2 Runtime。\n请先安装 WebView2 Evergreen Runtime，再重新启动 DeepseekHarness。\n\n下载地址：https://developer.microsoft.com/microsoft-edge/webview2/";
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let _ = MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from("DeepseekHarness"),
            MB_OK | MB_ICONERROR,
        );
    }
    #[cfg(not(windows))]
    eprintln!("{text}");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_plugins_are_complete_reused_and_repaired() {
        let cache = tempfile::tempdir().unwrap();
        let patch = prepare(cache.path()).unwrap();
        let root = patch.parent().unwrap().parent().unwrap();
        for (relative, bytes) in FILES {
            assert_eq!(
                std::fs::read(root.join(relative)).unwrap(),
                *bytes,
                "{relative}"
            );
        }
        let modified = std::fs::metadata(&patch).unwrap().modified().unwrap();
        assert_eq!(prepare(cache.path()).unwrap(), patch);
        assert_eq!(
            std::fs::metadata(&patch).unwrap().modified().unwrap(),
            modified
        );
        std::fs::write(&patch, "broken cache").unwrap();
        let client = root.join("dsh-plugin/title-bar/client.js");
        std::fs::remove_file(&client).unwrap();
        prepare(cache.path()).unwrap();
        assert!(std::fs::read_to_string(&patch)
            .unwrap()
            .contains("desktop-notify"));
        assert!(client.is_file());
    }

    #[test]
    fn different_payloads_do_not_overwrite_each_other() {
        let cache = tempfile::tempdir().unwrap();
        let old = materialize(cache.path(), &[(crate::PATCH_RESOURCE, b"old")]).unwrap();
        let new = materialize(cache.path(), &[(crate::PATCH_RESOURCE, b"new")]).unwrap();
        assert_ne!(old, new);
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        assert_eq!(std::fs::read(new).unwrap(), b"new");
    }
}
