//! Explicit dsh channel checks and updates from the title bar.
use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::dsh::CommandExt;
use crate::{
    npm,
    state::{Phase, Shared},
};

#[derive(Default)]
pub struct UpdateManager(Arc<AtomicBool>);

pub(crate) struct Operation(Arc<AtomicBool>);

impl UpdateManager {
    pub(crate) fn begin(&self) -> Result<Operation, String> {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "dsh 更新操作仍在进行中".to_string())?;
        Ok(Operation(self.0.clone()))
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Stable installs use latest; preview installs require an exact version.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Latest,
    Preview,
}

impl Channel {
    fn args(self, target_version: Option<&str>) -> Result<Vec<String>, String> {
        let spec = match self {
            Self::Latest => "@deepseek-ai/dsh@latest".to_string(),
            Self::Preview => {
                let version = target_version.ok_or("缺少预览版版本号，请重新检测")?;
                // IPC must not accept npm tags, ranges, URLs or command options.
                semver::Version::parse(version).map_err(|_| "预览版必须使用完整的版本号")?;
                format!("@deepseek-ai/dsh@{version}")
            }
        };
        Ok(vec!["install".into(), "-g".into(), spec])
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Versions {
    pub current: String,
    pub latest: String,
    pub preview: String,
}

#[derive(Debug, Deserialize)]
struct Tags {
    latest: String,
}

fn version(text: &str) -> Result<String, String> {
    let text = text.trim().trim_start_matches('v');
    // Reject warnings or other command output rather than treating it as an
    // installed version. Dist-tags may include prerelease and build suffixes.
    let core = text.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
        || !text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
    {
        return Err("未能解析 dsh 版本号".into());
    }
    Ok(text.to_string())
}

fn parse_tags(text: &str) -> Result<Tags, String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Response {
        Object(Tags),
        List(Vec<Tags>),
    }
    let parsed = serde_json::from_str::<Response>(text)
        .map_err(|_| "npm 未返回有效的 latest 版本，请重新检测".to_string())?;
    let tags = match parsed {
        Response::Object(tags) => tags,
        Response::List(mut tags) if tags.len() == 1 => tags.remove(0),
        _ => return Err("npm 返回了多组版本，无法确定 latest".into()),
    };
    Ok(Tags { latest: version(&tags.latest)? })
}

fn parse_preview(text: &str) -> Result<String, String> {
    let versions: Vec<String> = serde_json::from_str(text)
        .map_err(|_| "npm 未返回有效的版本列表，请重新检测".to_string())?;
    // Use the registry's final entry as-is, regardless of its prerelease label.
    let last = versions.last().ok_or("npm 返回的版本列表为空，请重新检测")?;
    semver::Version::parse(last).map_err(|_| "npm 返回了无效的预览版版本号")?;
    Ok(last.clone())
}

/// Drain both pipes while waiting, so verbose npm errors cannot fill a pipe
/// and wedge the check. Bound retained output and always reap timed-out probes.
fn output(command: &mut Command, label: &str, timeout: Duration) -> Result<String, String> {
    let job = crate::winjob::JobObject::new().map_err(|e| format!("无法创建进程作业对象：{e}"))?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_no_window()
        .spawn()
        .map_err(|e| format!("无法执行 {label}：{e}"))?;
    let assigned = crate::winjob::open_for_job(child.id()).and_then(|handle| {
        let result = job.assign(handle);
        unsafe { windows::Win32::Foundation::CloseHandle(handle) }.ok();
        result
    });
    if let Err(error) = assigned {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("无法接管 {label} 进程：{error}"));
    }
    fn reader(pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut pipe = pipe;
            let mut buffer = [0; 4096];
            while let Ok(size) = pipe.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.len() > 65536 {
                    bytes.drain(..bytes.len() - 65536);
                }
            }
            String::from_utf8_lossy(&bytes).trim().to_string()
        })
    }
    let stdout = reader(child.stdout.take().unwrap());
    let stderr = reader(child.stderr.take().unwrap());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            result => {
                // dsh.cmd can own a node child; terminate the tree, not just cmd.
                job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                break Err(match result {
                    Err(e) => format!("等待 {label} 失败：{e}"),
                    _ => format!("{label} 超时，请检查网络或运行环境后重试"),
                });
            }
        }
    };
    drop(job);
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if !status?.success() {
        return Err(format!(
            "{label} 失败：{}",
            if err.is_empty() { out } else { err }
        ));
    }
    Ok(out)
}

fn npm_command(node: &Path) -> Result<Command, String> {
    let cli = npm::npm_cli_for(node).ok_or("未找到 npm")?;
    let mut command = Command::new(node);
    command.arg(cli);
    Ok(command)
}

fn current_version() -> Result<String, String> {
    // Fixed shell text: Windows npm shims are .cmd files. No UI input is
    // interpolated, and this follows the same PATH as `dsh --version`.
    let mut command = Command::new("cmd.exe");
    command.args(["/d", "/c", "dsh --version"]);
    version(&output(
        &mut command,
        "dsh --version",
        crate::dsh::VERSION_PROBE_TIMEOUT,
    )?)
}

fn check(node: &Path) -> Result<Versions, String> {
    let current = current_version()?;
    let text = output(
        npm_command(node)?.args(["view", "@deepseek-ai/dsh", "dist-tags", "--json"]),
        "npm view @deepseek-ai/dsh dist-tags",
        Duration::from_secs(60),
    )?;
    let tags = parse_tags(&text)?;
    let published = output(
        npm_command(node)?.args(["view", "@deepseek-ai/dsh", "versions", "--json"]),
        "npm view @deepseek-ai/dsh versions",
        Duration::from_secs(60),
    )?;
    Ok(Versions {
        current,
        latest: tags.latest,
        preview: parse_preview(&published)?,
    })
}

fn allowed_origin(url: &tauri::Url, phase: &Phase) -> bool {
    let Phase::Running { url: expected, .. } = phase else {
        return false;
    };
    expected.parse::<tauri::Url>().is_ok_and(|expected| {
        url.scheme() == "http"
            && url.origin() == expected.origin()
    })
}

fn caller(window: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let shared = window.state::<Shared>();
    let state = shared.lock().map_err(|_| "后台状态不可用")?;
    if window.label() != "main"
        || !allowed_origin(&url, &state.phase)
        || state.ui.phase == crate::ui_snapshot::UiPhase::Exiting
    {
        return Err("仅允许在当前 dsh 窗口中更新".into());
    }
    state
        .runtime
        .as_ref()
        .map(|runtime| runtime.node_exe.clone())
        .ok_or("未找到 Node.js".into())
}

pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    app.add_capability(serde_json::json!({
        "identifier": format!("dsh-update-backend-{instance}"), "windows": ["main"], "local": false,
        "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] },
        "permissions": ["allow-dsh-update"]
    }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_dsh_update(window: WebviewWindow) -> Result<Versions, String> {
    let node = caller(&window)?;
    let operation = window.state::<UpdateManager>().begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        check(&node)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_dsh_update(
    window: WebviewWindow,
    channel: Channel,
    target_version: Option<String>,
) -> Result<String, String> {
    let node = caller(&window)?;
    let args = channel.args(target_version.as_deref())?;
    let operation = window.state::<UpdateManager>().begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let mut installer = npm::Installer::start_with_args(&node, &args)?;
        let events = installer.take_events().ok_or("无法读取安装输出")?;
        let transcript = std::thread::spawn(move || {
            let mut tail = VecDeque::new();
            for progress in events {
                if tail.len() == 20 { tail.pop_front(); }
                tail.push_back(progress.line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });
        let result = installer.wait();
        // Close the job before joining readers, including on wait errors.
        drop(installer);
        let transcript = transcript.join().unwrap_or_default();
        if !result? { return Err(format!("安装失败：\n{transcript}")); }
        // Verify the global prefix used by npm, including a custom npm prefix.
        let root = output(npm_command(&node)?.args(["root", "-g"]), "npm root -g", Duration::from_secs(20))?;
        let bin = Path::new(root.trim()).join("@deepseek-ai/dsh/lib/bin.js");
        let installed = crate::dsh::probe_version(&node, &bin)
            .ok_or("安装命令已完成，但 dsh --version 校验失败，请重新检测")?;
        let installed = version(&installed)?;
        if matches!(channel, Channel::Preview) && target_version.as_deref() != Some(installed.as_str()) {
            return Err(format!("安装后的 dsh 版本为 {installed}，与选择的预览版不一致，请重新检测"));
        }
        let current = current_version()?;
        if installed != current {
            return Err(format!("已安装 dsh {installed}，但 PATH 中的 dsh 仍为 {current}。请检查 npm 全局目录与 PATH 后重新检测。"));
        }
        Ok(installed)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_latest_from_object_or_single_result_array_without_requiring_other_tags() {
        for text in [
            r#"{"latest":"0.1.7-rc.2","next":"0.2.0-rc.1","alpha":"old"}"#,
            r#"[{"latest":"0.1.7-rc.2"}]"#,
        ] {
            let tags = parse_tags(text).unwrap();
            assert_eq!(tags.latest, "0.1.7-rc.2");
        }
        for text in [
            "[]",
            r#"{"next":"1.0.0"}"#,
            r#"{"latest":"oops","next":"1.0.0"}"#,
            r#"[{"latest":"1.0.0","next":"2.0.0"},{"latest":"3.0.0","next":"4.0.0"}]"#,
            "npm error",
        ] {
            assert!(parse_tags(text).is_err(), "{text}");
        }
    }

    #[test]
    fn preview_uses_the_last_published_version_without_sorting_or_filtering() {
        for (text, expected) in [
            (r#"["0.2.0-rc.2","0.2.1-alpha.1","0.2.1-alpha.2"]"#, "0.2.1-alpha.2"),
            (r#"["1.0.0-alpha.1","1.0.0"]"#, "1.0.0"),
            (r#"["2.0.0","1.0.0-beta.2"]"#, "1.0.0-beta.2"),
            (r#"["1.0.0"]"#, "1.0.0"),
        ] {
            assert_eq!(parse_preview(text).unwrap(), expected);
        }
    }

    #[test]
    fn preview_rejects_empty_or_invalid_registry_results() {
        for text in [
            "[]", "null", "npm error", r#"{"versions":["1.0.0"]}"#,
            r#"["1.0.0","next"]"#, r#"["1.0.0",null]"#, r#"["1.0.0",123]"#,
            r#"["1.0.0","^2.0.0"]"#, r#"["1.0.0","2.0.0-alpha..1"]"#,
        ] {
            assert!(parse_preview(text).is_err(), "{text}");
        }
    }

    #[test]
    fn normalizes_version_output_without_accepting_warnings() {
        assert_eq!(version(" v0.2.0-rc.1\r\n").unwrap(), "0.2.0-rc.1");
        for text in ["", "undefined", "npm warn\n1.0.0", "1.0", "1.0.0\n2.0.0"] {
            assert!(version(text).is_err());
        }
    }

    #[test]
    fn stable_uses_latest_and_preview_installs_the_exact_version() {
        assert_eq!(
            Channel::Latest.args(None).unwrap(),
            ["install", "-g", "@deepseek-ai/dsh@latest"]
        );
        for version in ["0.2.1-alpha.2", "1.0.0-beta.1", "1.0.0-rc.1", "1.0.0", "1.0.0+build.1"] {
            assert_eq!(
                Channel::Preview.args(Some(version)).unwrap(),
                ["install".to_string(), "-g".into(), format!("@deepseek-ai/dsh@{version}")]
            );
        }
    }

    #[test]
    fn preview_rejects_tags_ranges_and_other_package_specs() {
        assert!(Channel::Preview.args(None).is_err());
        for version in [
            "", "latest", "next", "alpha", "beta", "^1.0.0", "~1.0.0", ">=1.0.0", "1.x",
            "v1.0.0", "1.0.0 --force", "1.0.0;whoami", "1.0.0-alpha..1", "1.0.0-alpha.01",
            "https://example.com/dsh.tgz", "file:../dsh", "npm:other-package@1.0.0",
        ] {
            assert!(Channel::Preview.args(Some(version)).is_err(), "{version}");
        }
        for channel in ["next", "alpha", "beta", "latest --force"] {
            assert!(serde_json::from_value::<Channel>(serde_json::json!(channel)).is_err());
        }
    }

    #[test]
    fn operation_is_exclusive_and_unlocked_on_failure() {
        let manager = UpdateManager::default();
        let operation = manager.begin().unwrap();
        assert!(manager.begin().is_err());
        drop(operation);
        assert!(manager.begin().is_ok());
    }

    #[test]
    fn update_requires_current_backend_origin() {
        let phase = Phase::Running {
            url: "http://127.0.0.1:1234/?token=secret".into(),
            version: None,
        };
        assert!(allowed_origin(
            &"http://127.0.0.1:1234/".parse().unwrap(),
            &phase
        ));
        for url in [
            "http://127.0.0.1:1235/",
            "http://tauri.localhost/",
            "https://127.0.0.1:1234/",
            "http://localhost:1234/",
        ] {
            assert!(!allowed_origin(&url.parse().unwrap(), &phase));
        }
        assert!(!allowed_origin(
            &"http://127.0.0.1:1234/".parse().unwrap(),
            &Phase::Probing
        ));
    }

    #[test]
    fn command_output_drains_pipes_reports_errors_and_times_out() {
        let Some(node) = crate::dsh::resolve_node() else {
            return;
        };
        let result = output(
            Command::new(&node).args([
                "-e",
                "process.stderr.write('x'.repeat(200000)); process.stdout.write('1.2.3')",
            ]),
            "probe",
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result, "1.2.3");
        let error = output(
            Command::new(&node).args([
                "-e",
                "console.error('registry unavailable'); process.exitCode=1",
            ]),
            "probe",
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains("registry unavailable"));
        let started = Instant::now();
        let error = output(
            Command::new(&node).args(["-e", "setInterval(()=>{},1000)"]),
            "probe",
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[ignore = "read-only integration check against the configured npm registry"]
    fn reads_installed_version_and_live_registry_versions() {
        let node = crate::dsh::resolve_node().expect("Node.js required");
        let versions = check(&node).expect("dsh and npm registry must be available");
        println!("{}", serde_json::to_string(&versions).unwrap());
    }
}
