//! The offline build uses only the runtime shipped beside its executable.
//! Initialise before Tauri (and therefore before WebView2 or any worker thread).
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn root() -> Option<&'static Path> {
    ROOT.get().map(PathBuf::as_path)
}

const REQUIRED: &[&str] = &[
    "node/node.exe",
    "node/node_modules/npm/bin/npm-cli.js",
    "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "webview2/msedgewebview2.exe",
    "webview2/msedge.dll",
    "webview2/icudtl.dat",
];

fn validate(root: &Path) -> Result<(), String> {
    let manifest = std::fs::read(root.join("runtime.json"))
        .map_err(|e| format!("无法读取内置环境清单：{e}"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest)
        .map_err(|e| format!("内置环境清单无效：{e}"))?;
    if manifest["schema"] != 1 || manifest["platform"] != "win32" || manifest["arch"] != "x64" {
        return Err("内置环境清单的版本或平台不兼容".into());
    }
    for relative in REQUIRED {
        if !root.join(relative).is_file() {
            return Err(format!("内置环境缺少文件：runtime/{relative}"));
        }
    }
    Ok(())
}

pub fn initialize() -> Result<(), String> {
    if !cfg!(feature = "offline") {
        return Ok(());
    }
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("内置环境目前仅支持 Windows x64".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("无法确定应用目录")?;
    let root = dir.join("runtime");
    validate(&root)?;
    if !dir.join("dsh-plugin/desktop-notify.patch.yml").is_file() {
        return Err("便携包缺少 dsh-plugin/desktop-notify.patch.yml".into());
    }
    let paths = ["node", "dsh/node_modules/.bin"]
        .into_iter()
        .map(|part| root.join(part));
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(paths.chain(std::env::split_paths(&inherited)))
        .map_err(|e| format!("无法设置内置环境 PATH：{e}"))?;
    // Process-local settings; do not install anything or change the system PATH.
    std::env::set_var("PATH", path);
    std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", root.join("webview2"));
    ROOT.set(root).map_err(|_| "内置环境已初始化".to_string())
}

pub fn show_failure(error: &str) {
    let text = format!("便携包不完整，无法启动。\n{error}\n\n请重新解压完整的 portable 包，保留 runtime 和 dsh-plugin 文件夹。");
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("DeepseekHarness"), MB_OK | MB_ICONERROR);
    }
    #[cfg(not(windows))]
    eprintln!("{text}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_and_wrong_platform_payloads_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        assert!(validate(temp.path()).is_err());
        std::fs::write(temp.path().join("runtime.json"), r#"{"schema":1,"platform":"win32","arch":"x64"}"#).unwrap();
        for relative in REQUIRED {
            let file = temp.path().join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"test fixture").unwrap();
        }
        assert!(validate(temp.path()).is_ok());
        std::fs::remove_file(temp.path().join("node/node.exe")).unwrap();
        assert!(validate(temp.path()).unwrap_err().contains("node/node.exe"));
        std::fs::write(temp.path().join("runtime.json"), r#"{"schema":1,"platform":"win32","arch":"arm64"}"#).unwrap();
        assert!(validate(temp.path()).unwrap_err().contains("不兼容"));
    }
}
