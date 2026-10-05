//! Desktop-owned LAN configuration. No HTTP management or credential endpoint.
use crate::{
    state::{Phase, Shared},
    ui_snapshot::{UiPayload, UiPhase, UiSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    net::{Ipv4Addr, TcpListener},
    path::Path,
    sync::Arc,
};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const MAX_HOSTS: usize = 32;
pub const MAX_HOST_LENGTH: usize = 253;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub trusted_hosts: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            bind_address: String::new(),
            port: 3080,
            trusted_hosts: vec![],
        }
    }
}
impl Config {
    pub fn authority(&self) -> String {
        format!("{}:{}", self.bind_address, self.port)
    }
    pub fn effective_hosts(&self) -> Vec<String> {
        let mut hosts = vec![self.authority()];
        for host in &self.trusted_hosts {
            if !hosts.contains(host) {
                hosts.push(host.clone());
            }
        }
        hosts
    }
    pub fn validate(mut self, addresses: &[LanAddress]) -> Result<Self, Error> {
        if self.version != 1 {
            return Err(Error::new(
                "config-version",
                "version",
                "配置版本不受支持，仅以本机模式启动",
            ));
        }
        if self.port == 0 {
            return Err(Error::new(
                "port-invalid",
                "port",
                "端口须为 1–65535 的整数",
            ));
        }
        if self.enabled && !addresses.iter().any(|a| a.address == self.bind_address) {
            return Err(Error::new(
                "address-unavailable",
                "bindAddress",
                "所选局域网 IPv4 已不可用，请刷新并重新选择网卡",
            ));
        }
        if !self.bind_address.is_empty()
            && !self
                .bind_address
                .parse::<Ipv4Addr>()
                .is_ok_and(|ip| ip.is_private() && ip.to_string() == self.bind_address)
        {
            return Err(Error::new(
                "address-invalid",
                "bindAddress",
                "仅支持本机 RFC1918 私网 IPv4",
            ));
        }
        if self.trusted_hosts.len() > MAX_HOSTS {
            return Err(Error::new(
                "hosts-limit",
                "trustedHosts",
                "最多添加 32 个 Host",
            ));
        }
        let mut seen = BTreeSet::new();
        let mut hosts = vec![];
        for (index, host) in self.trusted_hosts.iter().enumerate() {
            let host = validate_authority(host).map_err(|message| {
                Error::new("host-invalid", &format!("trustedHosts.{index}"), message)
            })?;
            if seen.insert(host.clone()) {
                hosts.push(host);
            }
        }
        self.trusted_hosts = hosts;
        Ok(self)
    }
}

/// Match upstream's dual-scheme canonical-authority check. Parsing under both
/// schemes preserves explicit :80 / :443 instead of broadening to every port.
pub fn validate_authority(entry: &str) -> Result<String, &'static str> {
    if entry.contains('[') || entry.matches(':').count() > 1 {
        return Err("暂不支持 IPv6 Host");
    }
    if entry.is_empty()
        || entry.len() > MAX_HOST_LENGTH
        || !entry.is_ascii()
        || entry
            .bytes()
            .any(|c| c.is_ascii_whitespace() || b"/*\\?#@%".contains(&c))
    {
        return Err("请输入不含空白、URL、路径或通配符的 host 或 host:port（最多 253 字符）");
    }
    let http = tauri::Url::parse(&format!("http://{entry}")).map_err(|_| "Host 格式无效")?;
    let https = tauri::Url::parse(&format!("https://{entry}")).map_err(|_| "Host 格式无效")?;
    let host = http.host_str().ok_or("Host 格式无效")?;
    if host == "0.0.0.0" {
        return Err("不允许 0.0.0.0");
    }
    let canonical = match http.port().or(https.port()) {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    if canonical != entry.to_ascii_lowercase() {
        return Err("Host 或端口不是规范格式，请检查 IP、悬空冒号及零填充端口");
    }
    Ok(canonical)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub field: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, field: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            field: field.into(),
            message: redact(&message.into()),
        }
    }
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::new("remote-error", "", message)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LanAddress {
    pub name: String,
    pub address: String,
}
pub fn lan_addresses() -> Result<Vec<LanAddress>, Error> {
    let interfaces = if_addrs::get_if_addrs()
        .map_err(|_| Error::new("interfaces", "bindAddress", "读取网卡失败，请稍后刷新"))?;
    let mut seen = BTreeSet::new();
    let mut result = vec![];
    for interface in interfaces {
        if let std::net::IpAddr::V4(ip) = interface.ip() {
            if ip.is_private()
                && interface.is_oper_up()
                && !interface.is_loopback()
                && seen.insert(ip)
            {
                result.push(LanAddress {
                    name: interface.name,
                    address: ip.to_string(),
                });
            }
        }
    }
    result.sort_by(|a, b| a.address.cmp(&b.address));
    Ok(result)
}

pub fn load(path: &Path) -> Result<Config, Error> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(_) => Err(Error::new(
            "config-read",
            "",
            "无法读取远程控制配置，仅以本机模式启动",
        )),
        Ok(bytes) if bytes.len() <= 16384 => serde_json::from_slice(&bytes).map_err(|_| {
            Error::new(
                "config-invalid",
                "",
                "远程控制配置损坏或字段不完整，仅以本机模式启动",
            )
        }),
        _ => Err(Error::new(
            "config-invalid",
            "",
            "远程控制配置过大，仅以本机模式启动",
        )),
    }
}
pub fn save(path: &Path, config: &Config) -> Result<(), Error> {
    use std::io::Write;
    let write = || -> std::io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("config path"))?;
        std::fs::create_dir_all(dir)?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(&serde_json::to_vec_pretty(config)?)?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        Ok(())
    };
    write().map_err(|_| {
        Error::new(
            "config-write",
            "",
            "保存配置失败，原服务继续运行；请检查应用数据目录权限和磁盘空间",
        )
    })
}
fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, Error> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {
        return Ok(std::path::PathBuf::from(dir).join("remote-control.json"));
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("remote-control.json"))
        .map_err(|_| Error::new("config-path", "", "无法定位应用配置目录"))
}

#[derive(Default)]
pub struct Runtime {
    pub document_nonce: [u8; 16],
    pub saved: Config,
    pub active: Option<Config>,
    pub operation_id: u64,
    pub applying: bool,
    pub error: Option<Error>,
    /// The sole restart target permitted to restore this operation's snapshot.
    pub restore_instance: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub backend_instance: u64,
    pub window_generation: u64,
    pub document_generation: u64,
    pub document_nonce: [u8; 16],
}
pub fn identity(s: &crate::state::AppState) -> Identity {
    Identity {
        backend_instance: s.ui.backend_instance,
        window_generation: s.ui.window_generation,
        document_generation: s.ui.document_generation,
        document_nonce: s.remote.document_nonce,
    }
}
pub fn allowed_origin(url: &tauri::Url, phase: &Phase) -> bool {
    let Phase::Running { url: expected, .. } = phase else {
        return false;
    };
    expected
        .parse::<tauri::Url>()
        .is_ok_and(|expected| url.origin() == expected.origin() && url.scheme() == "http")
}
/// Tauri retains dynamically added capabilities. Inspect the ACL contexts that
/// matched the requesting frame, not just the top-level window URL, so an old
/// backend origin cannot use a capability left over from a previous restart.
pub fn current_invocation(invoke: &tauri::ipc::Invoke) -> bool {
    let webview = invoke.message.webview_ref();
    let Ok(url) = webview.url() else { return false };
    let app = webview.app_handle();
    let shared = webview.state::<Shared>();
    let Ok(s) = shared.lock() else { return false };
    // "Is this our own page", asked the same way Tauri's ACL asks it. A `[local]`
    // grant is a grant to *this app's document*, not to loopback at large: under
    // `tauri dev` that document is served by the CLI's server, so answering with
    // the packaged protocol URL alone refused every boot-page command.
    let app_document = crate::ui_snapshot::is_app_document(app, &url);
    webview.label() == "main"
        && invoke.acl.as_ref().is_some_and(|acl| {
            acl.iter()
                .any(|grant| current_context(app_document, &grant.context, &url, &s.phase))
        })
}
fn current_context(
    app_document: bool,
    context: &tauri::utils::acl::ExecutionContext,
    current_url: &tauri::Url,
    phase: &Phase,
) -> bool {
    use tauri::utils::acl::ExecutionContext;
    match context {
        ExecutionContext::Local => app_document,
        ExecutionContext::Remote { url } => {
            allowed_origin(current_url, phase)
                && url.as_str() == format!("{}/*", current_url.origin().ascii_serialization())
        }
    }
}
fn caller(window: &WebviewWindow, claimed: Identity) -> Result<(), Error> {
    let url = window
        .url()
        .map_err(|_| Error::new("origin", "", "无法确认当前页面"))?;
    let shared = window.state::<Shared>();
    let s = shared
        .lock()
        .map_err(|_| Error::new("state", "", "后台状态不可用"))?;
    if window.label() != "main"
        || !allowed_origin(&url, &s.phase)
        || !s.ui.loaded
        || s.ui.phase == UiPhase::Exiting
        || identity(&s) != claimed
    {
        return Err(Error::new(
            "stale-document",
            "",
            "仅允许在电脑桌面应用的当前页面中操作，请等待重新连接",
        ));
    }
    Ok(())
}
pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|_| "remote-origin")?;
    app.add_capability(serde_json::json!({ "identifier": format!("remote-control-{instance}"), "windows": ["main"], "local": false,
        "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] },
        "permissions": ["allow-desktop-locale", "allow-remote-control", "allow-window-controls", "allow-clipboard", "allow-edit-shortcut", "allow-folder-focus", "allow-session-export", "core:app:allow-version"]
    }).to_string()).map_err(|_| "remote-permission".into())
}
pub fn page_load(window: &WebviewWindow, started: bool) {
    if started {
        // Capabilities accumulate in Tauri. A nonce injected only into the live
        // top-level document stops an old-origin frame guessing new counters.
        if let Ok(mut s) = window.state::<Shared>().lock() {
            s.remote.document_nonce = *uuid::Uuid::new_v4().as_bytes();
        }
        return;
    }
    let value = {
        let shared = window.state::<Shared>();
        let Ok(s) = shared.lock() else {
            return;
        };
        if !s.ui.loaded || !window.url().is_ok_and(|url| allowed_origin(&url, &s.phase)) {
            return;
        }
        serde_json::to_string(&identity(&s)).unwrap()
    };
    let _ = window.eval(&format!("window.__DSH_REMOTE_IDENTITY__={value};window.dispatchEvent(new Event('dsh-remote-ready'));"));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    saved: Config,
    active: Option<Config>,
    operation_id: u64,
    applying: bool,
    state: &'static str,
    address: Option<String>,
    error: Option<Error>,
    instance: u64,
    frontend_version: Option<String>,
}
#[tauri::command]
pub fn remote_status(window: WebviewWindow, identity: Identity) -> Result<Status, Error> {
    caller(&window, identity)?;
    let shared = window.state::<Shared>();
    let s = shared
        .lock()
        .map_err(|_| Error::from("后台状态不可用".to_string()))?;
    let r = &s.remote;
    let running = matches!(s.phase, Phase::Running { .. });
    let lan = running && r.active.as_ref().is_some_and(|c| c.enabled) && !r.applying;
    Ok(Status {
        saved: r.saved.clone(),
        active: r.active.clone(),
        operation_id: r.operation_id,
        applying: r.applying,
        state: if r.applying {
            "applying"
        } else if lan {
            "lan"
        } else if r.error.is_some() {
            if running {
                "local-fallback"
            } else {
                "failed"
            }
        } else {
            "disabled"
        },
        address: if lan {
            r.active
                .as_ref()
                .map(|c| format!("http://{}/", c.authority()))
        } else {
            None
        },
        error: r.error.clone(),
        instance: s.ui.backend_instance,
        frontend_version: s.runtime.as_ref().and_then(|r| r.version.clone()),
    })
}
#[tauri::command]
pub async fn remote_lan_addresses(
    window: WebviewWindow,
    identity: Identity,
) -> Result<Vec<LanAddress>, Error> {
    caller(&window, identity)?;
    let result = tauri::async_runtime::spawn_blocking(lan_addresses)
        .await
        .map_err(|_| Error::from("读取网卡失败".to_string()))??;
    caller(&window, identity)?;
    Ok(result)
}
pub fn precheck(config: &Config, current: Option<&Config>) -> Result<(), Error> {
    if !config.enabled
        || current.is_some_and(|old| {
            old.enabled && old.bind_address == config.bind_address && old.port == config.port
        })
    {
        return Ok(());
    }
    TcpListener::bind((config.bind_address.as_str(), config.port))
        .map(drop)
        .map_err(|_| {
            Error::new(
                "port-unavailable",
                "port",
                "目标地址或端口不可用（可能被其他程序占用），请更换端口或刷新网卡",
            )
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReply {
    operation_id: u64,
    changed: bool,
}

struct ApplyingGuard(Shared);
impl Drop for ApplyingGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.0.lock() {
            s.remote.applying = false;
        }
    }
}

#[tauri::command]
pub async fn remote_apply(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    config: Config,
    payload: UiPayload,
) -> Result<ApplyReply, Error> {
    apply_backend(app, window, identity, Some(config), payload).await
}

/// Restart with the current listener configuration, without changing LAN settings.
#[tauri::command]
pub async fn plugins_restart(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    payload: UiPayload,
) -> Result<ApplyReply, Error> {
    apply_backend(app, window, identity, None, payload).await
}

async fn apply_backend(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    requested: Option<Config>,
    payload: UiPayload,
) -> Result<ApplyReply, Error> {
    caller(&window, identity)?;
    let shared = app.state::<Shared>().inner().clone();
    let guard = {
        let mut s = shared
            .lock()
            .map_err(|_| Error::from("后台状态不可用".to_string()))?;
        if s.remote.applying
            || s.boot_in_progress
            || s.installer.is_some()
            || s.ui.phase != UiPhase::Active
            || s.ui.snapshot.is_some()
        {
            return Err(Error::new(
                "busy",
                "",
                "启动、保存或恢复仍在进行，请完成后重试",
            ));
        }
        s.remote.applying = true;
        ApplyingGuard(shared.clone())
    };
    // Share the package-update lock: updating the executable while restarting it
    // must never race. The lock is retained by the background operation.
    let update_guard = app
        .state::<crate::dsh_update::UpdateManager>()
        .begin()
        .map_err(Error::from)?;
    let path = config_path(&app)?;
    let work_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let restart_only = requested.is_none();
        let config = match requested {
            Some(config) => config,
            None => shared
                .lock()
                .map_err(|_| Error::from("后台状态不可用".to_string()))?
                .remote
                .active
                .clone()
                .ok_or_else(|| Error::from("后台未就绪".to_string()))?,
        };
        let addresses = if config.enabled {
            lan_addresses()?
        } else {
            vec![]
        };
        let config = config.validate(&addresses)?;
        caller(&window, identity)?;
        let (current, runtime, source) = {
            let s = shared
                .lock()
                .map_err(|_| Error::from("后台状态不可用".to_string()))?;
            if !restart_only
                && s.remote.saved == config
                && s.remote.active.as_ref() == Some(&config)
                && s.remote.error.is_none()
            {
                return Ok(ApplyReply {
                    operation_id: s.remote.operation_id,
                    changed: false,
                });
            }
            (
                s.remote.active.clone(),
                s.runtime
                    .clone()
                    .ok_or_else(|| Error::from("后台未就绪".to_string()))?,
                s.ui.identity(),
            )
        };
        precheck(&config, current.as_ref())?;
        if payload.page.kind != "dsh" {
            return Err(Error::from("无法安全保存当前页面".to_string()));
        }
        let snapshot = UiSnapshot::capture(payload, source)
            .map_err(|_| Error::new("snapshot", "", "草稿或附件保存失败，原页面和服务已保留"))?;
        caller(&window, identity)?;
        {
            let mut s = shared
                .lock()
                .map_err(|_| Error::from("后台状态不可用".to_string()))?;
            if s.ui.phase != UiPhase::Active || self::identity(&s) != identity {
                return Err(Error::from("页面已变化，请重试".to_string()));
            }
            // Serialize the final check and disk commit against exit/destruction.
            if !restart_only {
                save(&path, &config)?;
                s.remote.saved = config.clone();
                s.remote.error = None;
            }
            s.remote.operation_id += 1;
            s.ui.snapshot = Some(Arc::new(snapshot));
        }
        let operation_id = shared.lock().unwrap().remote.operation_id;
        std::thread::spawn(move || {
            let _guard = guard;
            let _update_guard = update_guard;
            crate::restart_backend(&work_app, &shared, runtime, config);
        });
        Ok(ApplyReply {
            operation_id,
            changed: true,
        })
    })
    .await
    .map_err(|_| Error::from("后台应用操作异常，请重试".to_string()))?
}

pub fn cold_config(app: &AppHandle, shared: &Shared) -> Config {
    let loaded = config_path(app).and_then(|path| load(&path));
    let saved = loaded.clone().unwrap_or_default();
    let validated = loaded
        .and_then(|c| {
            let addresses = if c.enabled { lan_addresses()? } else { vec![] };
            c.validate(&addresses)
        })
        .and_then(|c| {
            precheck(&c, None)?;
            Ok(c)
        });
    let mut s = shared.lock().unwrap();
    s.remote.saved = saved;
    match validated {
        Ok(config) => {
            s.remote.error = None;
            config
        }
        Err(error) => {
            s.remote.error = Some(error);
            Config::default()
        }
    }
}
pub fn check_ready(config: &Config, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|_| "DSH 就绪地址无效")?;
    let expected_host = if config.enabled {
        config.bind_address.as_str()
    } else {
        "127.0.0.1"
    };
    if url.scheme() != "http"
        || url.host_str() != Some(expected_host)
        || config.enabled && url.port_or_known_default() != Some(config.port)
        || !url.username().is_empty()
    {
        return Err("DSH 实际监听地址与请求配置不一致".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    url: String,
    qr_svg: String,
    instance: u64,
}
#[tauri::command]
pub fn remote_connection_info(
    window: WebviewWindow,
    identity: Identity,
) -> Result<ConnectionInfo, Error> {
    caller(&window, identity)?;
    let shared = window.state::<Shared>();
    let s = shared
        .lock()
        .map_err(|_| Error::from("后台状态不可用".to_string()))?;
    if s.remote.applying || !s.remote.active.as_ref().is_some_and(|c| c.enabled) {
        return Err(Error::from("局域网服务尚未就绪".to_string()));
    }
    let Phase::Running { url, .. } = &s.phase else {
        return Err(Error::from("局域网服务尚未就绪".to_string()));
    };
    let code = qrcode::QrCode::new(url.as_bytes())
        .map_err(|_| Error::from("二维码生成失败".to_string()))?;
    Ok(ConnectionInfo {
        url: url.clone(),
        qr_svg: code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(256, 256)
            .build(),
        instance: s.ui.backend_instance,
    })
}
#[derive(Serialize)]
pub struct FirewallHelp {
    add: String,
    remove: String,
}
pub fn firewall_help(config: &Config) -> FirewallHelp {
    let name = format!("DSH-LAN-{}-{}", config.bind_address, config.port);
    FirewallHelp { add: format!("New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress '{}' -LocalPort {} -Profile Private -RemoteAddress LocalSubnet", config.bind_address, config.port),
        remove: format!("Get-NetFirewallRule -DisplayName '{name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule") }
}
#[tauri::command]
pub fn remote_firewall_help(
    window: WebviewWindow,
    identity: Identity,
) -> Result<FirewallHelp, Error> {
    caller(&window, identity)?;
    let shared = window.state::<Shared>();
    let s = shared
        .lock()
        .map_err(|_| Error::from("后台状态不可用".to_string()))?;
    let config = s
        .remote
        .active
        .as_ref()
        .filter(|c| c.enabled && !s.remote.applying)
        .ok_or_else(|| Error::from("局域网服务尚未就绪".to_string()))?;
    Ok(firewall_help(config))
}

/// Child diagnostics may contain URLs; never retain query strings or fragments.
pub fn redact(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|part| {
            if let Some(start) = part.find("http://").or_else(|| part.find("https://")) {
                if let Some(end) = part[start..].find(['?', '#']) {
                    return format!(
                        "{}[redacted]{}",
                        &part[..start + end],
                        if part.ends_with('\n') { "\n" } else { " " }
                    );
                }
            }
            if let Some(start) = part.to_ascii_lowercase().find("token=") {
                return format!("{}token=[redacted] ", &part[..start]);
            }
            part.to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            enabled: true,
            bind_address: "192.168.1.20".into(),
            trusted_hosts: vec![
                "DESKTOP.local:80".into(),
                "desktop.local:80".into(),
                "desktop.local:443".into(),
            ],
            ..Config::default()
        }
    }
    fn addresses() -> Vec<LanAddress> {
        vec![LanAddress {
            name: "Wi-Fi".into(),
            address: "192.168.1.20".into(),
        }]
    }
    #[test]
    fn canonical_authorities_match_shared_upstream_corpus() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../dsh-plugin/ui-remote/authority-cases.json"
        ))
        .unwrap();
        for value in cases["valid"].as_array().unwrap() {
            let text = value.as_str().unwrap();
            assert_eq!(validate_authority(text).unwrap(), text.to_ascii_lowercase());
        }
        for key in ["invalid", "policyInvalid"] {
            for value in cases[key].as_array().unwrap() {
                assert!(
                    validate_authority(value.as_str().unwrap()).is_err(),
                    "{value}"
                );
            }
        }
        assert!(validate_authority(&"a".repeat(254)).is_err());
    }
    #[test]
    fn configuration_requires_a_live_interface_and_deduplicates_without_broadening() {
        let c = config().validate(&addresses()).unwrap();
        assert_eq!(c.trusted_hosts, ["desktop.local:80", "desktop.local:443"]);
        assert_eq!(
            c.effective_hosts(),
            ["192.168.1.20:3080", "desktop.local:80", "desktop.local:443"]
        );
        assert_eq!(
            config().validate(&[]).unwrap_err().code,
            "address-unavailable"
        );
        let mut disabled = config();
        disabled.enabled = false;
        assert!(disabled.validate(&[]).is_ok());
        let mut bad = config();
        bad.version = 2;
        assert!(bad.validate(&addresses()).is_err());
        let mut bad = config();
        bad.port = 0;
        assert!(bad.validate(&addresses()).is_err());
        let mut bad = config();
        bad.trusted_hosts = vec!["desktop.local".into(); 33];
        assert!(bad.validate(&addresses()).is_err());
    }
    #[test]
    fn atomic_settings_replace_and_corrupt_files_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-control.json");
        assert_eq!(load(&path).unwrap(), Config::default());
        save(&path, &config()).unwrap();
        assert_eq!(load(&path).unwrap(), config());
        save(&path, &Config::default()).unwrap();
        assert_eq!(load(&path).unwrap(), Config::default());
        std::fs::write(&path, b"{bad").unwrap();
        assert_eq!(load(&path).unwrap_err().code, "config-invalid");
        assert_eq!(
            save(dir.path(), &config()).unwrap_err().code,
            "config-write"
        );
    }
    #[test]
    fn readiness_and_origin_use_exact_scheme_host_and_port() {
        let c = config();
        assert!(check_ready(&c, "http://192.168.1.20:3080/?token=x").is_ok());
        assert!(check_ready(&c, "http://127.0.0.1:3080/").is_err());
        assert!(check_ready(&c, "http://192.168.1.20:3081/").is_err());
        let phase = Phase::Running {
            url: "http://192.168.1.20:3080/?token=x".into(),
            version: None,
        };
        assert!(allowed_origin(
            &"http://192.168.1.20:3080/".parse().unwrap(),
            &phase
        ));
        for bad in [
            "http://192.168.1.20:3081/",
            "https://192.168.1.20:3080/",
            "http://desktop.local:3080/",
            "http://tauri.localhost/",
        ] {
            assert!(!allowed_origin(&bad.parse().unwrap(), &phase));
        }
    }
    #[test]
    fn retained_capability_from_old_frame_cannot_authorize_current_host_commands() {
        use tauri::utils::acl::ExecutionContext;
        let current = "http://192.168.1.20:3080/".parse().unwrap();
        let phase = Phase::Running {
            url: "http://192.168.1.20:3080/?token=x".into(),
            version: None,
        };
        let remote = |pattern: &str| ExecutionContext::Remote {
            url: pattern.parse().unwrap(),
        };
        assert!(current_context(
            false,
            &remote("http://192.168.1.20:3080/*"),
            &current,
            &phase
        ));
        for pattern in [
            "http://127.0.0.1:4000/*",
            "http://192.168.1.20:3081/*",
            "http://192.168.1.20:*",
            "http://*/*",
        ] {
            assert!(!current_context(false, &remote(pattern), &current, &phase));
        }
        // A `[local]` grant is for this app's own document only. The DSH page on
        // another loopback port is not it, which is what stops a backend origin
        // from reaching the onboarding's install permissions.
        assert!(!current_context(
            false,
            &ExecutionContext::Local,
            &current,
            &phase
        ));
        assert!(!current_context(
            false,
            &remote("http://192.168.1.20:3080/*"),
            &current,
            &Phase::Probing
        ));
        // The boot page, in both forms the two builds serve it in: the packaged
        // protocol URL and the development server.
        for boot in ["http://tauri.localhost/", "http://127.0.0.1:1430/"] {
            let boot = boot.parse().unwrap();
            assert!(current_context(
                true,
                &ExecutionContext::Local,
                &boot,
                &Phase::Probing
            ));
            assert!(!current_context(
                true,
                &remote("http://192.168.1.20:3080/*"),
                &boot,
                &phase
            ));
        }
    }
    #[test]
    fn status_and_diagnostics_never_serialize_the_launch_credential() {
        let mut s = crate::state::AppState::default();
        s.phase = Phase::Running {
            url: "http://192.168.1.20:3080/?token=highly-secret".into(),
            version: None,
        };
        let serialized = serde_json::to_string(&crate::state::status(&s, None, None)).unwrap();
        assert!(!serialized.contains("highly-secret"));
        assert!(!serialized.contains("url"));
        for input in [
            "error http://a/?token=highly-secret next",
            "error token=highly-secret",
            "https://a/#highly-secret",
        ] {
            assert!(!redact(input).contains("highly-secret"));
        }
    }
    #[test]
    fn firewall_commands_are_scoped_and_never_execute() {
        let help = firewall_help(&config());
        for constraint in [
            "-LocalAddress '192.168.1.20'",
            "-LocalPort 3080",
            "-Protocol TCP",
            "-Profile Private",
            "-RemoteAddress LocalSubnet",
        ] {
            assert!(help.add.contains(constraint));
        }
        assert!(help.remove.contains("DSH-LAN-192.168.1.20-3080"));
    }
    #[test]
    fn same_listener_is_not_mistaken_for_an_external_conflict() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let c = Config {
            enabled: true,
            bind_address: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            ..Config::default()
        };
        assert!(precheck(&c, None).is_err());
        assert!(precheck(&c, Some(&c)).is_ok());
        drop(listener);
        assert!(precheck(&c, None).is_ok());
    }
    #[test]
    fn stopping_real_child_tree_releases_its_fixed_port_before_restart() {
        // This fixture runs outside a packaged application. Its test helper
        // uses the build machine's Node even when testing the offline feature.
        let node = crate::dsh::find_on_path("node")
            .expect("Node is required for the process lifecycle test");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let runtime = crate::dsh::Runtime {
            node_exe: node,
            dsh_bin: Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/fake-dsh-remote.mjs"),
            source: crate::dsh::DshSource::Global,
            version: None,
        };
        let c = Config {
            enabled: true,
            bind_address: "127.0.0.1".into(),
            port,
            ..Config::default()
        };
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir(fixture.path().join("plugin-control")).unwrap();
        std::fs::write(fixture.path().join("plugin-control/prepare-boot.mjs"),
            "import { readFileSync } from 'node:fs'; JSON.parse(readFileSync(process.argv[3], 'utf8'));" ).unwrap();
        for _ in 0..2 {
            let mut process = crate::dsh::DshProcess::spawn(
                &runtime,
                &fixture.path().join("fixture.yml"),
                &c,
                &fixture.path().join("changes"),
            )
            .unwrap();
            let events = process.take_events().unwrap();
            let url = crate::dsh::await_ready(&events, std::time::Duration::from_secs(10), |_| {})
                .unwrap();
            assert!(url.contains(&format!(":{port}/")));
            assert!(precheck(&c, None).is_err());
            process.stop_and_wait().unwrap();
            assert!(precheck(&c, None).is_ok());
        }
    }
}
