//! Explicit dsh channel checks and updates from the title bar.
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
pub struct UpdateManager(Arc<AtomicBool>, crate::maintenance::MaintenanceCoordinator);

#[derive(Default,Clone)]
pub struct CandidateManager(Arc<std::sync::Mutex<Option<CandidateState>>>);
struct CandidateState {
    request_id: uuid::Uuid, identity:crate::remote_control::Identity,
    cancelled:bool, installer:Option<npm::InstallHandle>,
}
struct CandidateGuard {manager:CandidateManager,request_id:uuid::Uuid}
impl CandidateManager {
    fn begin(&self,request_id:uuid::Uuid,identity:crate::remote_control::Identity)->Result<CandidateGuard,String> {
        let mut state=self.0.lock().map_err(|_|"runtime-candidate-state")?;
        if state.is_some() {return Err("runtime-candidate-busy".into());}
        *state=Some(CandidateState {request_id,identity,cancelled:false,installer:None});
        Ok(CandidateGuard {manager:self.clone(),request_id})
    }
    fn cancel(&self,request_id:uuid::Uuid,identity:crate::remote_control::Identity)->Result<(),String> {
        let mut state=self.0.lock().map_err(|_|"runtime-candidate-state")?;
        let Some(state)=state.as_mut() else {return Ok(())};
        if state.request_id!=request_id || state.identity!=identity {return Err("runtime-candidate-stale".into());}
        state.cancelled=true;if let Some(installer)=&state.installer {installer.cancel();}Ok(())
    }
}
impl CandidateGuard {
    fn check(&self)->Result<(),String> {
        let state=self.manager.0.lock().map_err(|_|"runtime-candidate-state")?;
        match state.as_ref().filter(|s|s.request_id==self.request_id) {
            Some(s) if !s.cancelled=>Ok(()),_=>Err("runtime-candidate-cancelled".into())
        }
    }
    fn installer(&self,installer:Option<npm::InstallHandle>)->Result<(),String> {
        let mut state=self.manager.0.lock().map_err(|_|"runtime-candidate-state")?;
        let state=state.as_mut().filter(|s|s.request_id==self.request_id).ok_or("runtime-candidate-stale")?;
        if state.cancelled {if let Some(installer)=installer {installer.cancel();}return Err("runtime-candidate-cancelled".into());}
        state.installer=installer;Ok(())
    }
}
impl Drop for CandidateGuard {
    fn drop(&mut self) {if let Ok(mut state)=self.manager.0.lock() {if state.as_ref().is_some_and(|s|s.request_id==self.request_id) {*state=None;}}}
}

#[derive(Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CandidateSummary {
    id:String,version:String,fingerprint:String,switch_available:bool,
}

fn candidate_install(node:&Path,prefix:&Path,target_version:&str,guard:&CandidateGuard)->Result<(),String> {
    let mut installer=npm::Installer::start_candidate(node,prefix,target_version)?;
    guard.installer(Some(installer.handle()))?;
    let events=installer.take_events().ok_or("runtime-candidate-install-failed")?;
    // Never publish arbitrary npm output as a structured maintenance error.
    let drain=std::thread::spawn(move || {for _ in events {}});
    let result=installer.wait_timeout(Duration::from_secs(600));
    drop(installer);let _=drain.join();guard.installer(None)?;guard.check()?;
    if !result? {return Err("runtime-candidate-install-failed".into());}Ok(())
}

/// Candidate preparation never stops the backend, captures the UI, or changes
/// selection. Real-data startup remains gated by the migration/checkpoint contract.
#[tauri::command]
pub async fn prepare_dsh_candidate(window:WebviewWindow,identity:crate::remote_control::Identity,
    request_id:uuid::Uuid,target_version:String)->Result<CandidateSummary,String> {
    caller(&window)?;
    crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
    let shared=window.state::<Shared>().inner().clone();
    let source=shared.lock().map_err(|_|"runtime-state")?.runtime.clone().ok_or("runtime-unavailable")?;
    npm::candidate_argv(Path::new("candidate"),&target_version)?;
    let operation=window.state::<UpdateManager>().begin()?;
    let guard=window.state::<CandidateManager>().begin(request_id,identity)?;
    let app=window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let operation=operation.durable(&app)?;let progress=operation.progress();
        progress.target(&target_version)?;
        let prefix=crate::runtime_store::candidate_directory(&app)?;
        let record=prefix.join("preparation.json");
        crate::maintenance::atomic_json(&record,&serde_json::json!({"schema":1,"requestId":request_id,
            "sourceVersion":source.version,"targetVersion":target_version,"stage":"installing"})).map_err(|_|"runtime-candidate-record-failed")?;
        let result:Result<CandidateSummary,String>=(|| {
            guard.check()?;
            progress.update(crate::maintenance::Stage::Preparing,"candidate-install-started")?;
            candidate_install(&source.node_exe,&prefix,&target_version,&guard)?;
            guard.check()?;
            progress.update(crate::maintenance::Stage::Preparing,"candidate-freezing")?;
            let candidate=crate::runtime_store::freeze_candidate(&app,&source.node_exe,&prefix,&target_version)?;
            guard.check()?;
            crate::remote_control::caller(&window,identity).map_err(|_|"runtime-candidate-stale")?;
            let current=shared.lock().map_err(|_|"runtime-state")?.runtime.clone().ok_or("runtime-candidate-stale")?;
            if current.dsh_bin!=source.dsh_bin || current.node_exe!=source.node_exe {return Err("runtime-candidate-stale".into());}
            let managed=candidate.managed.ok_or("runtime-candidate-binding")?;
            let summary=CandidateSummary {id:managed.id,version:target_version.clone(),fingerprint:managed.fingerprint,switch_available:false};
            crate::maintenance::atomic_json(&record,&serde_json::json!({"schema":1,"requestId":request_id,
                "sourceVersion":source.version,"targetVersion":target_version,"stage":"prepared","candidate":summary})).map_err(|_|"runtime-candidate-record-failed")?;
            progress.prepared()?;
            Ok(summary)
        })();
        if let Err(error)=&result {
            let code=if error.starts_with("runtime-") && error.bytes().all(|b|b.is_ascii_lowercase() || b==b'-') {error.as_str()} else {"runtime-candidate-preparation-failed"};
            let _=crate::maintenance::atomic_json(&record,&serde_json::json!({"schema":1,"requestId":request_id,
                "targetVersion":target_version,"stage":"failed","errorCode":code}));
            let _=progress.failed(code);
        }
        result
    }).await.map_err(|_|"runtime-candidate-worker")?
}

#[tauri::command]
pub fn cancel_dsh_candidate(window:WebviewWindow,identity:crate::remote_control::Identity,request_id:uuid::Uuid)->Result<(),String> {
    caller(&window)?;crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
    window.state::<CandidateManager>().cancel(request_id,identity)
}

pub(crate) struct Operation(Option<Arc<AtomicBool>>, Option<crate::maintenance::Lease>);

impl UpdateManager {
    pub(crate) fn new(coordinator: crate::maintenance::MaintenanceCoordinator) -> Self {
        Self(Arc::new(AtomicBool::new(false)), coordinator)
    }
    pub(crate) fn begin(&self) -> Result<Operation, String> {
        self.begin_kind(crate::maintenance::Kind::Update)
    }
    fn begin_read(&self) -> Result<Operation,String> {
        self.0.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst)
            .map_err(|_| "dsh 更新操作仍在进行中".to_string())?;
        Ok(Operation(Some(self.0.clone()),None))
    }
    pub(crate) fn begin_kind(&self, kind: crate::maintenance::Kind) -> Result<Operation, String> {
        let lease = self.1.begin(kind)?;
        Ok(Operation(None, Some(lease)))
    }
}
impl Operation {
    pub(crate) fn durable(mut self, app: &AppHandle) -> Result<Self, String> {
        self.1 = Some(self.1.take().ok_or("maintenance-stale")?.durable(app)?);
        Ok(self)
    }
    pub(crate) fn progress(&self) -> crate::maintenance::Progress { self.1.as_ref().expect("operation lease").progress() }
    pub(crate) fn into_lease(mut self) -> crate::maintenance::Lease { self.1.take().expect("operation lease") }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if let Some(read) = &self.0 { read.store(false, Ordering::SeqCst); }
        self.1.take();
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
    #[serde(rename = "stableUpdateAvailable")]
    pub stable_update_available: bool,
    #[serde(rename = "candidateOnly")]
    pub candidate_only: bool,
}

fn stable_update_available(current: &str, latest: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current).map_err(|_| "未能解析当前 dsh 版本号")?;
    let latest = semver::Version::parse(latest).map_err(|_| "未能解析稳定版 dsh 版本号")?;
    Ok(latest.cmp_precedence(&current).is_gt())
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
pub(crate) fn output(command: &mut Command, label: &str, timeout: Duration) -> Result<String, String> {
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

fn current_version(runtime: &crate::dsh::Runtime) -> Result<String, String> {
    let mut command = Command::new(&runtime.node_exe);
    command.arg(crate::dsh::node_script_path(&runtime.dsh_bin)).arg("--version");
    version(&output(
        &mut command,
        "dsh --version",
        crate::dsh::VERSION_PROBE_TIMEOUT,
    )?)
}

fn check(runtime: &crate::dsh::Runtime) -> Result<Versions, String> {
    let node = &runtime.node_exe;
    let current = current_version(runtime)?;
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
        candidate_only:true,
        stable_update_available: stable_update_available(&current, &tags.latest)?,
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
        "permissions": ["allow-dsh-update", "allow-runtime-ready"]
    }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_dsh_update(window: WebviewWindow) -> Result<Versions, String> {
    caller(&window)?;
    let runtime = window.state::<Shared>().lock().map_err(|_| "后台状态不可用")?.runtime.clone().ok_or("后台未就绪")?;
    // Registry/version queries never own the maintenance lease. A slow network
    // check must not block a user from exporting or inspecting local backups.
    let operation = window.state::<UpdateManager>().begin_read()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        check(&runtime)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn dsh_update_activity(window: WebviewWindow) -> Result<bool, String> {
    caller(&window)?;
    let shared = window.state::<Shared>();
    let state = shared.lock().map_err(|_| "后台状态不可用")?;
    activity_for_backend(state.update_activity, state.ui.backend_instance)
}

fn activity_for_backend(activity: Option<(u64, bool)>, instance: u64) -> Result<bool, String> {
    match activity {
        Some((reported, running)) if reported == instance => Ok(running),
        _ => Err("无法确认会话状态，请稍后重试更新。".into()),
    }
}

fn require_idle(state: &crate::state::AppState) -> Result<(), String> {
    if activity_for_backend(state.update_activity, state.ui.backend_instance)? {
        return Err("dsh-update-sessions-running".into());
    }
    Ok(())
}

// Retain the old command name so cached clients fail before any capture or
// global npm mutation. Preparation uses the separate exact-version command.
#[tauri::command]
pub async fn install_dsh_update(
    window: WebviewWindow,
    identity: crate::remote_control::Identity,
    payload: crate::ui_snapshot::UiPayload,
    palette: Option<crate::boot_bar::Palette>,
    channel: Channel,
    target_version: Option<String>,
) -> Result<(), String> {
    caller(&window)?;
    crate::remote_control::caller(&window, identity).map_err(|e|e.message)?;
    {
        let shared=window.state::<Shared>();let state=shared.lock().map_err(|_|"runtime-state")?;
        require_idle(&state)?;
    }
    let _=(payload,palette.and_then(crate::boot_bar::Palette::bounded),channel.args(target_version.as_deref())?);
    Err("安全数据检查点与迁移契约尚未完成，当前版本继续运行。请重新打开更新页面准备独立候选版本。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_cancellation_binds_request_and_document_and_keeps_exclusive_owner() {
        let manager=CandidateManager::default();let id=uuid::Uuid::new_v4();
        let identity=crate::remote_control::Identity {backend_instance:1,window_generation:1,document_generation:2,document_nonce:[1;16]};
        let guard=manager.begin(id,identity).unwrap();assert!(guard.check().is_ok());
        assert!(manager.begin(uuid::Uuid::new_v4(),identity).is_err());
        assert!(manager.cancel(uuid::Uuid::new_v4(),identity).is_err());
        let mut stale=identity;stale.document_generation+=1;assert!(manager.cancel(id,stale).is_err());
        manager.cancel(id,identity).unwrap();assert_eq!(guard.check().unwrap_err(),"runtime-candidate-cancelled");
        assert!(manager.begin(uuid::Uuid::new_v4(),identity).is_err());drop(guard);
        assert!(manager.begin(uuid::Uuid::new_v4(),identity).is_ok());
    }

    #[test]
    fn stable_badge_only_offers_newer_latest_channel_versions() {
        for (current, latest, available) in [
            ("0.1.9", "0.1.10", true),
            ("0.2.0-rc.1", "0.2.0-rc.2", true),
            ("0.2.0-rc.2", "0.2.0-rc.2", false),
            ("0.3.0-alpha.1", "0.2.0", false),
            ("0.2.0-rc.2", "0.2.0", true),
            ("0.2.0+local", "0.2.0+registry", false),
        ] {
            assert_eq!(stable_update_available(current, latest).unwrap(), available);
        }
        assert!(stable_update_available("unknown", "0.2.0").is_err());
    }

    #[test]
    fn native_admission_requires_idle_activity_from_the_current_backend() {
        let mut state = crate::state::AppState::default();
        state.ui.backend_instance = 8;
        assert!(require_idle(&state).is_err());
        state.update_activity = Some((7, false));
        assert!(require_idle(&state).is_err());
        state.update_activity = Some((8, true));
        assert_eq!(require_idle(&state).unwrap_err(), "dsh-update-sessions-running");
        state.update_activity = Some((8, false));
        assert!(require_idle(&state).is_ok());
    }

    #[test]
    fn activity_reports_preserve_unknown_instead_of_treating_it_as_idle() {
        use crate::dsh::{parse_line, ChildEvent};
        for (wire, running) in [("false", Some(false)), ("true", Some(true)), ("null", None), ("\"idle\"", None)] {
            let line = format!("__DSH_UPDATE_ACTIVITY__ {{\"running\":{wire}}}");
            assert_eq!(parse_line(&line), Some(ChildEvent::UpdateActivity(running)));
        }
    }

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
    fn registry_reads_are_exclusive_with_other_reads_but_never_own_maintenance() {
        let manager = UpdateManager::default();
        let read = manager.begin_read().unwrap();
        assert!(manager.begin_read().is_err());
        let maintenance = manager.begin_kind(crate::maintenance::Kind::Restart).unwrap();
        assert!(manager.begin().is_err());
        drop(maintenance);
        assert!(manager.begin_read().is_err());
        drop(read);
        assert!(manager.begin_read().is_ok());
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
        let (dsh_bin, source) = crate::dsh::resolve_dsh(false).expect("dsh required");
        let runtime = crate::dsh::Runtime { node_exe: node, dsh_bin, source, version: None, managed:None };
        let versions = check(&runtime).expect("dsh and npm registry must be available");
        println!("{}", serde_json::to_string(&versions).unwrap());
    }

    #[test]
    fn current_version_executes_the_selected_entry_instead_of_a_path_install() {
        let Some(node) = crate::dsh::resolve_node() else { return };
        let directory = tempfile::tempdir().unwrap();
        let entry = directory.path().join("selected.cjs");
        std::fs::write(&entry, "process.stdout.write('9.8.7-test.1')").unwrap();
        let runtime = crate::dsh::Runtime { node_exe: node, dsh_bin: entry, source: crate::dsh::DshSource::Configured, version: Some("1.2.3".into()),managed:None };
        assert_eq!(current_version(&runtime).unwrap(), "9.8.7-test.1");
    }
}
