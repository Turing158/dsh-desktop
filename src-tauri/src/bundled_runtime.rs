//! Portable builds carry a complete runtime. Installers may reuse system components.
//! Initialise before Tauri (and therefore before WebView2 or any worker thread).
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PATHS: OnceLock<RuntimePaths> = OnceLock::new();

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRuntime {
    schema: u32,
    node_path: String,
    webview2_path: String,
}

#[derive(Debug)]
struct RuntimePaths {
    node: Option<PathBuf>,
    webview2: Option<PathBuf>,
    installer: bool,
}

/// Architecture word this build expects in the payload's `runtime.json`.
///
/// The offline payload is per-architecture (its `node/node.exe` and its fixed
/// WebView2 runtime are native binaries), so an x86 build must reject an x64
/// payload and the other way round.
#[cfg(target_arch = "x86_64")]
const PAYLOAD_ARCH: &str = "x64";
#[cfg(target_arch = "x86")]
const PAYLOAD_ARCH: &str = "x86";
#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
const PAYLOAD_ARCH: &str = "";

pub fn node() -> Option<PathBuf> {
    PATHS.get()?.node.clone().filter(|path| path.is_file())
}

pub fn allows_system_node() -> bool {
    PATHS.get().is_some_and(|paths| paths.installer)
}

const REQUIRED: &[&str] = &[
    "node/node.exe",
    "node/node_modules/npm/bin/npm-cli.js",
    "webview2/msedgewebview2.exe",
    "webview2/msedge.dll",
    "webview2/icudtl.dat",
];

fn validate(root: &Path) -> Result<(), String> {
    let manifest = std::fs::read(root.join("runtime.json"))
        .map_err(|e| format!("无法读取内置环境清单：{e}"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest)
        .map_err(|e| format!("内置环境清单无效：{e}"))?;
    if manifest["schema"] != 1 || manifest["platform"] != "win32" || manifest["arch"] != PAYLOAD_ARCH {
        return Err("内置环境清单的版本或平台不兼容".into());
    }
    for relative in REQUIRED {
        if !root.join(relative).is_file() {
            return Err(format!("内置环境缺少文件：runtime/{relative}"));
        }
    }
    Ok(())
}

fn configured_path(value: String) -> Result<Option<PathBuf>, String> {
    if value.is_empty() { return Ok(None); }
    let path = PathBuf::from(value);
    if !path.is_absolute() { return Err("安装环境配置中的路径必须是绝对路径，请重新运行安装器".into()); }
    Ok(Some(path))
}

fn runtime_paths(root: &Path) -> Result<RuntimePaths, String> {
    match std::fs::read(root.join("installed.json")) {
        Ok(bytes) => {
            let installed: InstalledRuntime = serde_json::from_slice(&bytes)
                .map_err(|e| format!("安装环境配置无效，请重新运行安装器：{e}"))?;
            if installed.schema != 1 { return Err("安装环境配置版本不兼容，请重新运行安装器".into()); }
            let webview2 = configured_path(installed.webview2_path)?;
            if let Some(path) = &webview2 {
                for file in ["msedgewebview2.exe", "msedge.dll", "icudtl.dat"] {
                    if !path.join(file).is_file() { return Err("已安装的 WebView2 不完整，请重新运行安装器".into()); }
                }
            }
            Ok(RuntimePaths { node: configured_path(installed.node_path)?, webview2, installer: true })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            validate(root)?;
            Ok(RuntimePaths { node: Some(root.join("node/node.exe")), webview2: Some(root.join("webview2")), installer: false })
        }
        Err(error) => Err(format!("无法读取安装环境配置：{error}")),
    }
}

pub fn initialize() -> Result<(), String> {
    if !cfg!(feature = "offline") {
        return Ok(());
    }
    if !cfg!(all(target_os = "windows", any(target_arch = "x86_64", target_arch = "x86"))) {
        return Err("内置环境目前仅支持 Windows x64 / x86".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("无法确定应用目录")?;
    let root = dir.join("runtime");
    let paths = runtime_paths(&root)?;
    if !dir.join("dsh-plugin/desktop-notify.patch.yml").is_file() {
        return Err("便携包缺少 dsh-plugin/desktop-notify.patch.yml".into());
    }
    // A fresh machine may not have npm's global bin directory on PATH yet.
    // Include it for DSH's command shim and the in-app version/update checks.
    let node_directory = paths.node.as_ref().and_then(|node| node.parent()).map(Path::to_path_buf);
    let search_paths = node_directory.into_iter().chain(crate::dsh::global_prefix());
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(search_paths.chain(std::env::split_paths(&inherited)))
        .map_err(|e| format!("无法设置内置环境 PATH：{e}"))?;
    // Process-local settings; do not install anything or change the system PATH.
    std::env::set_var("PATH", path);
    if let Some(webview2) = &paths.webview2 {
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", webview2);
    } else {
        std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
        if tauri::webview_version().is_err() {
            return Err("未检测到 Microsoft Edge WebView2 Runtime，请重新运行安装器并勾选 WebView2".into());
        }
    }
    PATHS.set(paths).map_err(|_| "运行环境已初始化".to_string())
}

pub fn show_failure(error: &str) {
    let text = format!("运行环境不完整，无法启动。\n{error}\n\n安装版请重新运行安装器并安装缺失组件。\n便携版请重新解压完整的 portable 包，保留 runtime 和 dsh-plugin 文件夹。");
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("dsh desktop"), MB_OK | MB_ICONERROR);
    }
    #[cfg(not(windows))]
    eprintln!("{text}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_components_can_use_system_or_private_paths_independently() {
        let temp = tempfile::tempdir().unwrap();
        let node = temp.path().join("external-node.exe");
        let webview = temp.path().join("webview2");
        std::fs::create_dir(&webview).unwrap();
        for file in ["msedgewebview2.exe", "msedge.dll", "icudtl.dat"] {
            std::fs::write(webview.join(file), b"fixture").unwrap();
        }
        for (node_path, webview_path) in [("".into(), "".into()), (node.display().to_string(), "".into()), ("".into(), webview.display().to_string()), (node.display().to_string(), webview.display().to_string())] {
            let config = serde_json::json!({"schema": 1, "nodePath": node_path, "webview2Path": webview_path});
            std::fs::write(temp.path().join("installed.json"), config.to_string()).unwrap();
            let paths = runtime_paths(temp.path()).unwrap();
            assert!(paths.installer);
            assert_eq!(paths.node.is_some(), !node_path.is_empty());
            assert_eq!(paths.webview2.is_some(), !webview_path.is_empty());
        }
        std::fs::remove_file(webview.join("msedge.dll")).unwrap();
        assert!(runtime_paths(temp.path()).unwrap_err().contains("WebView2 不完整"));
        std::fs::write(temp.path().join("installed.json"), r#"{"schema":1,"nodePath":"relative/node.exe","webview2Path":""}"#).unwrap();
        assert!(runtime_paths(temp.path()).is_err());
    }

    #[test]
    fn incomplete_and_wrong_platform_payloads_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        assert!(validate(temp.path()).is_err());
        std::fs::write(temp.path().join("runtime.json"), format!(r#"{{"schema":1,"platform":"win32","arch":"{PAYLOAD_ARCH}"}}"#)).unwrap();
        for relative in REQUIRED {
            let file = temp.path().join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"test fixture").unwrap();
        }
        assert!(validate(temp.path()).is_ok());
        assert!(!temp.path().join("dsh").exists());
        std::fs::remove_file(temp.path().join("node/node.exe")).unwrap();
        assert!(validate(temp.path()).unwrap_err().contains("node/node.exe"));
        std::fs::write(temp.path().join("runtime.json"), r#"{"schema":1,"platform":"win32","arch":"arm64"}"#).unwrap();
        assert!(validate(temp.path()).unwrap_err().contains("不兼容"));
    }
}
