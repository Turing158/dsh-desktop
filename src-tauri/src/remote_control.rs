//! Desktop-owned LAN configuration. No HTTP management or credential endpoint.
use crate::{
    state::{Phase, Shared},
    ui_snapshot::{UiPayload, UiPhase, UiSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{Ipv4Addr, TcpListener},
    path::Path,
    sync::Arc,
};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const MAX_HOSTS: usize = 32;
pub const MAX_HOST_LENGTH: usize = 253;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessScheme {
    Http,
    #[default]
    Https,
}
impl AccessScheme {
    fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferredHost {
    pub host: String,
    #[serde(default)]
    pub scheme: AccessScheme,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ListenerAddress {
    pub address: String,
    pub port: u16,
}
impl ListenerAddress {
    fn from_host(host: &str, default_port: u16) -> Option<Self> {
        let (name, port) = match host.split_once(':') {
            Some((name, port)) => (name, port.parse().ok()?),
            None => (host, default_port),
        };
        let address = if name == "localhost" {
            Ipv4Addr::LOCALHOST
        } else {
            name.parse().ok()?
        };
        Some(Self {
            address: address.to_string(),
            port,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub trusted_hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub host_schemes: BTreeMap<String, AccessScheme>,
    /// Last access selection, saved immediately without restarting the listener.
    /// Keep the legacy JSON key for existing configurations; None follows LAN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_host: Option<PreferredHost>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            bind_address: String::new(),
            port: 3080,
            trusted_hosts: vec![],
            host_schemes: BTreeMap::new(),
            preferred_host: None,
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

    pub fn listen_addresses(&self, addresses: &[LanAddress]) -> Vec<ListenerAddress> {
        if !self.enabled {
            return vec![];
        }
        let mut listeners = vec![ListenerAddress {
            address: self.bind_address.clone(),
            port: self.port,
        }];
        // The desktop document and OAuth callback always use loopback, even
        // when remote browsers reach this same backend through a LAN listener.
        let desktop = ListenerAddress { address: "127.0.0.1".into(), port: self.port };
        if !listeners.contains(&desktop) { listeners.push(desktop); }
        for host in &self.trusted_hosts {
            let Some(listener) = ListenerAddress::from_host(host, self.port) else {
                continue;
            };
            let local = listener
                .address
                .parse::<Ipv4Addr>()
                .is_ok_and(|ip| ip.is_loopback())
                || listener.address == self.bind_address
                || addresses
                    .iter()
                    .any(|address| address.address == listener.address);
            if local && !listeners.contains(&listener) {
                listeners.push(listener);
            }
        }
        listeners
    }

    fn resolved_access(
        &self,
        target: &PreferredHost,
        listeners: &[ListenerAddress],
    ) -> PreferredHost {
        let Some(listener) = ListenerAddress::from_host(&target.host, self.port) else {
            return target.clone();
        };
        if listeners.contains(&listener)
            || listener.address == self.bind_address && listener.port == self.port
        {
            PreferredHost {
                host: format!(
                    "{}:{}",
                    target.host.split(':').next().unwrap(),
                    listener.port
                ),
                scheme: AccessScheme::Http,
            }
        } else {
            target.clone()
        }
    }

    fn access_scheme(&self, host: &str, listeners: &[ListenerAddress]) -> AccessScheme {
        let scheme = self.host_schemes.get(host).copied().unwrap_or_else(|| {
            self.preferred_host
                .as_ref()
                .filter(|target| target.host == host)
                .map(|target| target.scheme)
                .unwrap_or(AccessScheme::Https)
        });
        self.resolved_access(
            &PreferredHost {
                host: host.into(),
                scheme,
            },
            listeners,
        )
        .scheme
    }

    fn access_origin(&self, listeners: &[ListenerAddress]) -> String {
        let host = self
            .preferred_host
            .as_ref()
            .map(|target| target.host.clone())
            .unwrap_or_else(|| self.authority());
        let target = PreferredHost {
            scheme: self.access_scheme(&host, listeners),
            host,
        };
        let target = self.resolved_access(&target, listeners);
        format!("{}://{}/", target.scheme.as_str(), target.host)
    }

    fn access_target(
        &self,
        target: &PreferredHost,
        listeners: &[ListenerAddress],
    ) -> Result<PreferredHost, Error> {
        let host = validate_authority(&target.host)
            .map_err(|message| Error::new("access-host-invalid", "target.host", message))?;
        if !self.effective_hosts().contains(&host) {
            return Err(Error::new(
                "access-host-untrusted",
                "target.host",
                "请选择已应用的 Host；新增地址需先应用白名单",
            ));
        }
        let target = PreferredHost {
            host,
            scheme: target.scheme,
        };
        if self.resolved_access(&target, listeners).scheme != target.scheme {
            return Err(Error::new(
                "access-scheme-invalid",
                "target.scheme",
                "本机监听地址仅支持 HTTP",
            ));
        }
        Ok(PreferredHost {
            scheme: self.access_scheme(&target.host, listeners),
            host: target.host,
        })
    }

    fn select_access(
        &mut self,
        target: &PreferredHost,
        listeners: &[ListenerAddress],
    ) -> Result<(), Error> {
        let host = validate_authority(&target.host)
            .map_err(|message| Error::new("access-host-invalid", "target.host", message))?;
        if !self.effective_hosts().contains(&host) {
            return Err(Error::new(
                "access-host-untrusted",
                "target.host",
                "请选择已应用的 Host；新增地址需先应用白名单",
            ));
        }
        let requested = PreferredHost {
            host: host.clone(),
            scheme: target.scheme,
        };
        if self.resolved_access(&requested, listeners).scheme != requested.scheme {
            return Err(Error::new(
                "access-scheme-invalid",
                "target.scheme",
                "本机监听地址仅支持 HTTP",
            ));
        }
        // Protocol changes only affect the shared access origin. Persist them
        // with the selection so the running listener and DSH process stay put.
        if host != self.authority() {
            self.host_schemes.insert(host, requested.scheme);
        }
        let target = self.access_target(target, listeners)?;
        self.preferred_host = (target.host != self.authority()).then_some(target);
        Ok(())
    }

    /// Sharing can use any active Host without changing the saved selection.
    /// The desktop, readiness checks, and firewall keep the LAN listener.
    fn connection_url(
        &self,
        backend_url: &str,
        target: Option<&PreferredHost>,
        listeners: &[ListenerAddress],
    ) -> Result<String, Error> {
        check_ready(self, backend_url).map_err(Error::from)?;
        let origin = if let Some(target) = target {
            let target = self.access_target(target, listeners)?;
            let resolved = self.resolved_access(&target, listeners);
            format!("{}://{}/", resolved.scheme.as_str(), resolved.host)
        } else {
            self.access_origin(listeners)
        };
        let backend = tauri::Url::parse(backend_url)
            .map_err(|_| Error::from("DSH 就绪地址无效".to_string()))?;
        let mut url = tauri::Url::parse(&origin)
            .map_err(|_| Error::new("access-host-invalid", "target.host", "访问 Host 无效"))?;
        url.set_path(backend.path());
        url.set_query(backend.query());
        url.set_fragment(backend.fragment());
        Ok(url.into())
    }

    pub fn validate(self, addresses: &[LanAddress]) -> Result<Self, Error> {
        let mut config = self.validate_fields()?;
        if config.enabled && !addresses.iter().any(|a| a.address == config.bind_address) {
            return Err(Error::new(
                "address-unavailable",
                "bindAddress",
                "所选局域网 IPv4 已不可用，请刷新并重新选择网卡",
            ));
        }
        let listeners = config.listen_addresses(addresses);
        if listeners.iter().any(|listener| listener.port == 0) {
            return Err(Error::new(
                "listen-port-invalid",
                "trustedHosts",
                "本机监听端口须为 1–65535",
            ));
        }
        config.host_schemes = config
            .trusted_hosts
            .iter()
            .map(|host| (host.clone(), config.access_scheme(host, &listeners)))
            .collect();
        if let Some(preferred) = config.preferred_host.clone() {
            let scheme = config.access_scheme(&preferred.host, &listeners);
            config.preferred_host.as_mut().unwrap().scheme = scheme;
        }
        Ok(config)
    }

    /// Keep a live saved choice; DHCP or a network change can invalidate its IP
    /// between launches. Only startup may replace it, not an explicit apply.
    fn for_startup(self, addresses: &[LanAddress]) -> Result<Self, Error> {
        // Invalid settings must still fail closed, even if an adapter is found.
        let mut config = self.validate_fields()?;
        if config.enabled && !addresses.iter().any(|a| a.address == config.bind_address) {
            let address = addresses.first().ok_or_else(|| {
                Error::new(
                    "address-unavailable",
                    "bindAddress",
                    "未检测到可用的局域网 IPv4，仅以本机模式启动",
                )
            })?;
            config.bind_address.clone_from(&address.address);
        }
        config.validate(addresses)
    }

    fn validate_fields(mut self) -> Result<Self, Error> {
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
        // The automatic LAN entry is never stored as an editable extra Host.
        let authority = self.authority();
        let mut seen = BTreeSet::from([authority.clone()]);
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
        if let Some(preferred) = &mut self.preferred_host {
            preferred.host = validate_authority(&preferred.host).map_err(|message| {
                Error::new("preferred-host-invalid", "preferredHost", message)
            })?;
            if preferred.host == authority {
                self.preferred_host = None;
            } else if !self.trusted_hosts.contains(&preferred.host) {
                return Err(Error::new(
                    "preferred-host-untrusted",
                    "preferredHost",
                    "请选择 Host 白名单中的访问地址",
                ));
            }
        }
        if self.host_schemes.len() > MAX_HOSTS {
            return Err(Error::new(
                "hosts-limit",
                "hostSchemes",
                "最多添加 32 个 Host",
            ));
        }
        let mut schemes = BTreeMap::new();
        for (host, scheme) in std::mem::take(&mut self.host_schemes) {
            let host = validate_authority(&host)
                .map_err(|message| Error::new("host-invalid", "hostSchemes", message))?;
            if self.trusted_hosts.contains(&host) {
                schemes.insert(host, scheme);
            }
        }
        for host in &self.trusted_hosts {
            schemes.entry(host.clone()).or_insert_with(|| {
                self.preferred_host
                    .as_ref()
                    .filter(|target| target.host == *host)
                    .map(|target| target.scheme)
                    .unwrap_or(AccessScheme::Https)
            });
        }
        self.host_schemes = schemes;
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
pub(crate) fn caller(window: &WebviewWindow, claimed: Identity) -> Result<(), Error> {
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
        "permissions": ["allow-desktop-locale", "allow-remote-control", "allow-window-controls", "allow-clipboard", "allow-edit-shortcut", "allow-folder-focus", "allow-workspace-directory", "allow-session-export", "allow-attachment-images", "core:app:allow-version"]
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
    listeners: Vec<ListenerAddress>,
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
    let listeners = if lan {
        s.process
            .as_ref()
            .map(|p| p.listeners.clone())
            .unwrap_or_default()
    } else {
        vec![]
    };
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
                .map(|config| config.access_origin(&listeners))
        } else {
            None
        },
        listeners,
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
    if !config.enabled {
        return Ok(());
    }
    precheck_listeners(config, current, &lan_addresses()?)
}
fn precheck_listeners(
    config: &Config,
    current: Option<&Config>,
    addresses: &[LanAddress],
) -> Result<(), Error> {
    let current = current
        .map(|config| config.listen_addresses(addresses))
        .unwrap_or_default();
    for listener in config.listen_addresses(addresses) {
        if current.contains(&listener) {
            continue;
        }
        TcpListener::bind((listener.address.as_str(), listener.port)).map_err(|_| {
            Error::new(
                "port-unavailable",
                "port",
                format!(
                    "监听地址 {}:{} 不可用（可能被其他程序占用），请更换端口或移除对应 Host",
                    listener.address, listener.port
                ),
            )
        })?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReply {
    operation_id: u64,
    changed: bool,
}

pub(crate) struct ApplyingGuard(pub(crate) Shared);
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
    let mut saved = Config::default();
    let validated = config_path(app).and_then(|path| {
        let config = load(&path)?;
        saved = config.clone();
        let addresses = if config.enabled {
            lan_addresses()?
        } else {
            vec![]
        };
        let config = config.for_startup(&addresses)?;
        precheck(&config, None)?;
        if config != saved {
            save(&path, &config).map_err(|_| {
                Error::new(
                    "config-write",
                    "",
                    "保存自动调整的远程控制配置失败，仅以本机模式启动",
                )
            })?;
            saved = config.clone();
        }
        Ok(config)
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
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
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
pub fn remote_select_connection(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    target: PreferredHost,
) -> Result<Status, Error> {
    caller(&window, identity)?;
    let path = config_path(&app)?;
    {
        let shared = app.state::<Shared>();
        let mut s = shared
            .lock()
            .map_err(|_| Error::from("后台状态不可用".to_string()))?;
        if self::identity(&s) != identity {
            return Err(Error::from("页面已变化，请重试".to_string()));
        }
        if s.remote.applying || !matches!(s.phase, Phase::Running { .. }) {
            return Err(Error::from("局域网服务尚未就绪".to_string()));
        }
        let mut active = s
            .remote
            .active
            .clone()
            .filter(|c| c.enabled)
            .ok_or_else(|| Error::from("局域网服务尚未就绪".to_string()))?;
        let listeners = s
            .process
            .as_ref()
            .map(|p| p.listeners.as_slice())
            .unwrap_or_default();
        active.select_access(&target, listeners)?;
        let mut saved = s.remote.saved.clone();
        saved.select_access(&target, listeners)?;
        if saved != s.remote.saved {
            save(&path, &saved)?;
        }
        s.remote.saved = saved;
        s.remote.active = Some(active);
    }
    remote_status(window, identity)
}

#[tauri::command]
pub fn remote_connection_info(
    window: WebviewWindow,
    identity: Identity,
    target: Option<PreferredHost>,
) -> Result<ConnectionInfo, Error> {
    caller(&window, identity)?;
    let shared = window.state::<Shared>();
    let s = shared
        .lock()
        .map_err(|_| Error::from("后台状态不可用".to_string()))?;
    if s.remote.applying {
        return Err(Error::from("局域网服务尚未就绪".to_string()));
    }
    let config = s
        .remote
        .active
        .as_ref()
        .filter(|c| c.enabled)
        .ok_or_else(|| Error::from("局域网服务尚未就绪".to_string()))?;
    let Phase::Running { url, .. } = &s.phase else {
        return Err(Error::from("局域网服务尚未就绪".to_string()));
    };
    let listeners = s
        .process
        .as_ref()
        .map(|p| p.listeners.as_slice())
        .unwrap_or_default();
    let url = config.connection_url(url, target.as_ref(), listeners)?;
    let code = qrcode::QrCode::new(url.as_bytes())
        .map_err(|_| Error::from("二维码生成失败".to_string()))?;
    Ok(ConnectionInfo {
        url,
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
pub fn firewall_help(config: &Config, listeners: &[ListenerAddress]) -> FirewallHelp {
    let fallback = config.listen_addresses(&[]);
    let listeners = if listeners.is_empty() {
        &fallback
    } else {
        listeners
    };
    let mut add = vec![];
    let mut remove = vec![];
    for listener in listeners {
        if !listener
            .address
            .parse::<Ipv4Addr>()
            .is_ok_and(|ip| ip.is_private())
        {
            continue;
        }
        let name = format!("DSH-LAN-{}-{}", listener.address, listener.port);
        add.push(format!("New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress '{}' -LocalPort {} -Profile Private -RemoteAddress LocalSubnet", listener.address, listener.port));
        remove.push(format!("Get-NetFirewallRule -DisplayName '{name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"));
    }
    FirewallHelp {
        add: add.join("\n"),
        remove: remove.join("\n"),
    }
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
    let listeners = s
        .process
        .as_ref()
        .map(|p| p.listeners.as_slice())
        .unwrap_or_default();
    Ok(firewall_help(config, listeners))
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
    fn startup_keeps_the_saved_address_when_multiple_adapters_are_available() {
        let mut available = vec![LanAddress {
            name: "Ethernet".into(),
            address: "10.0.0.2".into(),
        }];
        available.extend(addresses());
        let expected = config().validate(&available).unwrap();
        assert_eq!(config().for_startup(&available).unwrap(), expected);
    }
    #[test]
    fn startup_replaces_a_stale_or_empty_address_without_changing_other_settings() {
        let expected = config().validate(&addresses()).unwrap();
        for address in ["192.168.1.170", "10.255.255.254", ""] {
            let mut saved = config();
            saved.bind_address = address.into();
            // Applying an explicit selection still requires a live address.
            assert_eq!(
                saved.clone().validate(&addresses()).unwrap_err().code,
                "address-unavailable"
            );
            let selected = saved.for_startup(&addresses()).unwrap();
            assert_eq!(selected, expected);
            assert_eq!(selected.effective_hosts()[0], "192.168.1.20:3080");
        }
    }
    #[test]
    fn startup_without_adapters_fails_but_disabled_lan_keeps_its_saved_choice() {
        let error = config().for_startup(&[]).unwrap_err();
        assert_eq!(error.code, "address-unavailable");
        assert_eq!(error.field, "bindAddress");
        let mut disabled = config().validate(&addresses()).unwrap();
        disabled.enabled = false;
        disabled.bind_address = "192.168.1.170".into();
        for available in [vec![], addresses()] {
            assert_eq!(disabled.clone().for_startup(&available).unwrap(), disabled);
        }
    }
    #[test]
    fn startup_does_not_repair_malformed_settings_by_selecting_an_adapter() {
        for address in ["0.0.0.0", "127.0.0.1", "8.8.8.8", "::1", "invalid"] {
            let mut bad = config();
            bad.bind_address = address.into();
            assert_eq!(
                bad.for_startup(&addresses()).unwrap_err().code,
                "address-invalid"
            );
        }
        let mut bad = config();
        bad.version = 2;
        assert_eq!(
            bad.for_startup(&addresses()).unwrap_err().code,
            "config-version"
        );
        let mut bad = config();
        bad.port = 0;
        assert_eq!(
            bad.for_startup(&addresses()).unwrap_err().code,
            "port-invalid"
        );
        let mut bad = config();
        bad.trusted_hosts = vec!["*".into()];
        assert_eq!(
            bad.for_startup(&addresses()).unwrap_err().code,
            "host-invalid"
        );
    }
    #[test]
    fn old_settings_use_lan_and_a_preferred_host_round_trips() {
        let legacy = serde_json::json!({
            "version": 1, "enabled": true, "bindAddress": "192.168.1.20",
            "port": 3080, "trustedHosts": ["desktop.local:443"]
        });
        let mut c: Config = serde_json::from_value(legacy).unwrap();
        assert_eq!(c.preferred_host, None);
        assert!(serde_json::to_value(&c)
            .unwrap()
            .get("preferredHost")
            .is_none());
        c.preferred_host = Some(PreferredHost {
            host: "DESKTOP.local:443".into(),
            scheme: AccessScheme::Https,
        });
        let c = c.validate(&addresses()).unwrap();
        assert_eq!(c.preferred_host.as_ref().unwrap().host, "desktop.local:443");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-control.json");
        save(&path, &c).unwrap();
        assert_eq!(load(&path).unwrap(), c);
    }
    #[test]
    fn access_selection_persists_without_changing_hosts_or_listeners() {
        let mut config = config().validate(&addresses()).unwrap();
        let hosts = config.effective_hosts();
        let listeners = config.listen_addresses(&addresses());
        let target = PreferredHost {
            host: "DESKTOP.local:443".into(),
            scheme: AccessScheme::Https,
        };
        config.select_access(&target, &listeners).unwrap();
        assert_eq!(
            config.preferred_host.as_ref().unwrap().host,
            "desktop.local:443"
        );
        assert_eq!(config.effective_hosts(), hosts);
        assert_eq!(config.listen_addresses(&addresses()), listeners);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-control.json");
        save(&path, &config).unwrap();
        let mut restored = load(&path).unwrap().for_startup(&addresses()).unwrap();
        assert_eq!(
            restored.access_origin(&listeners),
            "https://desktop.local:443/"
        );
        for (target, code) in [
            (
                PreferredHost {
                    host: "unlisted.example.com".into(),
                    scheme: AccessScheme::Https,
                },
                "access-host-untrusted",
            ),
            (
                PreferredHost {
                    host: config.authority(),
                    scheme: AccessScheme::Https,
                },
                "access-scheme-invalid",
            ),
        ] {
            assert_eq!(
                restored
                    .select_access(&target, &listeners)
                    .unwrap_err()
                    .code,
                code
            );
            assert_eq!(restored, config);
        }
        restored
            .select_access(
                &PreferredHost {
                    host: config.authority(),
                    scheme: AccessScheme::Http,
                },
                &listeners,
            )
            .unwrap();
        assert_eq!(restored.preferred_host, None);
        assert_eq!(restored.listen_addresses(&addresses()), listeners);
        save(&path, &restored).unwrap();
        assert_eq!(load(&path).unwrap().preferred_host, None);
    }
    #[test]
    fn per_host_protocols_migrate_persist_and_follow_the_selected_host() {
        let legacy = serde_json::json!({
            "version": 1, "enabled": true, "bindAddress": "192.168.1.20",
            "port": 3080, "trustedHosts": ["desktop.local", "remote.example.com", "localhost"],
            "preferredHost": { "host": "desktop.local", "scheme": "http" }
        });
        let mut config = serde_json::from_value::<Config>(legacy)
            .unwrap()
            .validate(&addresses())
            .unwrap();
        assert_eq!(config.host_schemes["desktop.local"], AccessScheme::Http);
        assert_eq!(
            config.host_schemes["remote.example.com"],
            AccessScheme::Https
        );
        assert_eq!(config.host_schemes["localhost"], AccessScheme::Http);
        let listeners = config.listen_addresses(&addresses());
        let backend = "http://127.0.0.1:3080/?token=fixture";
        for (host, supplied, origin) in [
            (
                "desktop.local",
                AccessScheme::Https,
                "https://desktop.local/",
            ),
            (
                "remote.example.com",
                AccessScheme::Http,
                "http://remote.example.com/",
            ),
            ("localhost", AccessScheme::Http, "http://localhost:3080/"),
        ] {
            let target = PreferredHost {
                host: host.into(),
                scheme: supplied,
            };
            config.select_access(&target, &listeners).unwrap();
            assert_eq!(config.access_origin(&listeners), origin);
            assert_eq!(
                config
                    .connection_url(backend, Some(&target), &listeners)
                    .unwrap(),
                format!("{origin}?token=fixture")
            );
            assert_eq!(
                config.connection_url(backend, None, &listeners).unwrap(),
                format!("{origin}?token=fixture")
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-control.json");
        save(&path, &config).unwrap();
        let mut restored = load(&path).unwrap().for_startup(&addresses()).unwrap();
        assert_eq!(restored, config);
        restored
            .host_schemes
            .insert("desktop.local".into(), AccessScheme::Https);
        restored
            .host_schemes
            .insert("localhost".into(), AccessScheme::Https);
        restored.preferred_host = Some(PreferredHost {
            host: "desktop.local".into(),
            scheme: AccessScheme::Http,
        });
        let mut restored = restored.validate(&addresses()).unwrap();
        assert_eq!(restored.access_origin(&listeners), "https://desktop.local/");
        assert_eq!(
            restored.preferred_host.as_ref().unwrap().scheme,
            AccessScheme::Https
        );
        assert_eq!(restored.host_schemes["localhost"], AccessScheme::Http);
        restored
            .trusted_hosts
            .retain(|host| host != "remote.example.com");
        let restored = restored.validate(&addresses()).unwrap();
        assert!(!restored.host_schemes.contains_key("remote.example.com"));
        assert_eq!(restored.listen_addresses(&addresses()), listeners);
    }
    #[test]
    fn host_protocol_settings_validate_keys_and_reject_unknown_protocols() {
        let mut config = config();
        config
            .host_schemes
            .insert("DESKTOP.local:80".into(), AccessScheme::Http);
        config
            .host_schemes
            .insert("removed.example.com".into(), AccessScheme::Http);
        let mut config = config.validate(&addresses()).unwrap();
        assert_eq!(config.host_schemes["desktop.local:80"], AccessScheme::Http);
        assert!(!config.host_schemes.contains_key("removed.example.com"));
        let mut invalid = serde_json::to_value(&config).unwrap();
        invalid["hostSchemes"]["desktop.local:80"] = serde_json::json!("file");
        assert!(serde_json::from_value::<Config>(invalid).is_err());
        config
            .host_schemes
            .insert("https://desktop.local".into(), AccessScheme::Http);
        assert_eq!(
            config.validate(&addresses()).unwrap_err().code,
            "host-invalid"
        );
    }
    #[test]
    fn local_whitelist_entries_add_and_remove_only_their_own_listeners() {
        let available = vec![
            LanAddress {
                address: "192.168.1.20".into(),
                name: "Ethernet".into(),
            },
            LanAddress {
                address: "192.168.1.21".into(),
                name: "Wi-Fi".into(),
            },
        ];
        let mut config = Config {
            trusted_hosts: [
                "127.0.0.1",
                "localhost",
                "127.0.0.1:4080",
                "192.168.1.21:5080",
                "192.168.1.20",
                "203.0.113.10",
                "remote.example.com",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            ..config()
        }
        .validate(&available)
        .unwrap();
        let expected: Vec<ListenerAddress> = [
            ("192.168.1.20", 3080),
            ("127.0.0.1", 3080),
            ("127.0.0.1", 4080),
            ("192.168.1.21", 5080),
        ]
        .into_iter()
        .map(|(address, port)| ListenerAddress {
            address: address.into(),
            port,
        })
        .collect();
        assert_eq!(config.listen_addresses(&available), expected);
        config.trusted_hosts.retain(|host| host != "127.0.0.1");
        assert_eq!(
            config.listen_addresses(&available),
            expected,
            "localhost still owns the same listener"
        );
        config.trusted_hosts.retain(|host| host != "localhost");
        assert_eq!(
            config.listen_addresses(&available),
            expected,
            "the desktop keeps its loopback listener without a whitelist entry"
        );
        config.trusted_hosts.clear();
        assert_eq!(
            config.listen_addresses(&available),
            vec![expected[0].clone(), expected[1].clone()]
        );
        config.enabled = false;
        assert!(config.listen_addresses(&available).is_empty());
    }
    #[test]
    fn local_links_use_the_listening_port_and_http_without_changing_host_permissions() {
        let config = Config {
            trusted_hosts: vec!["127.0.0.1".into(), "localhost:4080".into()],
            preferred_host: Some(PreferredHost {
                host: "127.0.0.1".into(),
                scheme: AccessScheme::Https,
            }),
            ..config()
        }
        .validate(&addresses())
        .unwrap();
        let listeners = config.listen_addresses(&addresses());
        assert_eq!(
            config.preferred_host.as_ref().unwrap().scheme,
            AccessScheme::Http
        );
        assert_eq!(config.trusted_hosts, ["127.0.0.1", "localhost:4080"]);
        let backend = "http://127.0.0.1:3080/?token=fixture%2Bsecret%3D&keep=x#return";
        assert_eq!(config.access_origin(&listeners), "http://127.0.0.1:3080/");
        assert_eq!(
            config.connection_url(backend, None, &listeners).unwrap(),
            "http://127.0.0.1:3080/?token=fixture%2Bsecret%3D&keep=x#return"
        );
        let target = PreferredHost {
            host: "localhost:4080".into(),
            scheme: AccessScheme::Http,
        };
        assert_eq!(
            config
                .connection_url(backend, Some(&target), &listeners)
                .unwrap(),
            "http://localhost:4080/?token=fixture%2Bsecret%3D&keep=x#return"
        );
        let invalid = PreferredHost {
            scheme: AccessScheme::Https,
            ..target
        };
        assert_eq!(
            config
                .connection_url(backend, Some(&invalid), &listeners)
                .unwrap_err()
                .code,
            "access-scheme-invalid"
        );
        let invalid_port = Config {
            trusted_hosts: vec!["localhost:0".into()],
            preferred_host: None,
            ..config
        };
        assert_eq!(
            invalid_port.validate(&addresses()).unwrap_err().code,
            "listen-port-invalid"
        );
    }
    #[test]
    fn adding_a_listener_checks_its_port_even_when_the_main_listener_is_unchanged() {
        let main = TcpListener::bind("127.0.0.1:0").unwrap();
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let current = Config {
            bind_address: "127.0.0.1".into(),
            port: main.local_addr().unwrap().port(),
            trusted_hosts: vec![],
            ..config()
        };
        let changed = Config {
            trusted_hosts: vec![format!(
                "127.0.0.1:{}",
                occupied.local_addr().unwrap().port()
            )],
            ..current.clone()
        };
        assert_eq!(
            precheck_listeners(&changed, Some(&current), &[])
                .unwrap_err()
                .code,
            "port-unavailable"
        );
        assert!(precheck_listeners(&current, Some(&current), &[]).is_ok());
        drop(occupied);
        assert!(precheck_listeners(&changed, Some(&current), &[]).is_ok());
    }
    #[test]
    fn preferred_host_must_match_an_existing_allowlist_entry() {
        for host in ["outside.example", "desktop.local", "desktop.local:8080"] {
            let mut c = config();
            c.preferred_host = Some(PreferredHost {
                host: host.into(),
                scheme: AccessScheme::Https,
            });
            assert_eq!(
                c.validate(&addresses()).unwrap_err().code,
                "preferred-host-untrusted"
            );
        }
        for host in [
            "https://desktop.local",
            "desktop.local/path",
            "user@desktop.local",
            "desktop.local?token=x",
        ] {
            let mut c = config();
            c.preferred_host = Some(PreferredHost {
                host: host.into(),
                scheme: AccessScheme::Https,
            });
            assert_eq!(
                c.validate(&addresses()).unwrap_err().code,
                "preferred-host-invalid"
            );
        }
        let mut invalid_scheme = serde_json::to_value(config()).unwrap();
        invalid_scheme["preferredHost"] =
            serde_json::json!({ "host": "desktop.local:443", "scheme": "file" });
        assert!(serde_json::from_value::<Config>(invalid_scheme).is_err());
    }
    #[test]
    fn preferred_link_preserves_credentials_and_uses_its_own_scheme_and_port() {
        let backend = "http://127.0.0.1:3080/?token=fixture%2Bsecret%3D&keep=a%2Fb#return";
        for (scheme, host, origin) in [
            (
                AccessScheme::Https,
                "remote.example.com",
                "https://remote.example.com/",
            ),
            (
                AccessScheme::Http,
                "desktop.local:8080",
                "http://desktop.local:8080/",
            ),
            (
                AccessScheme::Https,
                "remote.example.com:8443",
                "https://remote.example.com:8443/",
            ),
            (
                AccessScheme::Http,
                "desktop.local:80",
                "http://desktop.local/",
            ),
        ] {
            let c = Config {
                trusted_hosts: vec![host.into()],
                preferred_host: Some(PreferredHost {
                    host: host.into(),
                    scheme,
                }),
                ..config()
            }
            .validate(&addresses())
            .unwrap();
            let url = c.connection_url(backend, None, &[]).unwrap();
            assert_eq!(
                url,
                format!("{origin}?token=fixture%2Bsecret%3D&keep=a%2Fb#return")
            );
            assert_eq!(c.authority(), "192.168.1.20:3080");
            assert_eq!(c.effective_hosts(), ["192.168.1.20:3080", host]);
            assert!(check_ready(&c, backend).is_ok());
            assert!(check_ready(&c, &url).is_err());
            assert_eq!(
                c.connection_url("http://127.0.0.1:3080/?token=next-launch", None, &[])
                    .unwrap(),
                format!("{origin}?token=next-launch")
            );
        }
        assert_eq!(
            config().connection_url(backend, None, &[]).unwrap(),
            "http://192.168.1.20:3080/?token=fixture%2Bsecret%3D&keep=a%2Fb#return"
        );
    }
    #[test]
    fn every_active_host_can_share_the_current_login_without_changing_the_default() {
        let config = Config {
            trusted_hosts: vec!["first.example.com".into(), "second.example.com:8443".into()],
            preferred_host: Some(PreferredHost {
                host: "first.example.com".into(),
                scheme: AccessScheme::Https,
            }),
            ..config()
        }
        .validate(&addresses())
        .unwrap();
        let backend = "http://127.0.0.1:3080/?token=fixture%2Bsecret%3D&keep=a%2Fb#return";
        let original = config.clone();
        for (host, scheme, origin) in [
            (
                "first.example.com",
                AccessScheme::Https,
                "https://first.example.com/",
            ),
            (
                "SECOND.example.com:8443",
                AccessScheme::Https,
                "https://second.example.com:8443/",
            ),
            (
                "second.example.com:8443",
                AccessScheme::Http,
                "https://second.example.com:8443/",
            ),
            (
                "192.168.1.20:3080",
                AccessScheme::Http,
                "http://192.168.1.20:3080/",
            ),
        ] {
            let target = PreferredHost {
                host: host.into(),
                scheme,
            };
            assert_eq!(
                config.connection_url(backend, Some(&target), &[]).unwrap(),
                format!("{origin}?token=fixture%2Bsecret%3D&keep=a%2Fb#return")
            );
        }
        assert_eq!(config, original);
        assert_eq!(
            config.connection_url(backend, None, &[]).unwrap(),
            "https://first.example.com/?token=fixture%2Bsecret%3D&keep=a%2Fb#return"
        );
    }
    #[test]
    fn connection_targets_require_an_active_exact_host_and_a_valid_scheme() {
        let config = config().validate(&addresses()).unwrap();
        let backend = "http://127.0.0.1:3080/?token=fixture";
        for (host, code) in [
            ("unlisted.example.com", "access-host-untrusted"),
            ("desktop.local", "access-host-untrusted"),
            ("desktop.local:8443", "access-host-untrusted"),
            ("192.168.1.21:3080", "access-host-untrusted"),
            ("https://desktop.local", "access-host-invalid"),
            ("desktop.local?token=x", "access-host-invalid"),
            ("user@desktop.local", "access-host-invalid"),
        ] {
            let target = PreferredHost {
                host: host.into(),
                scheme: AccessScheme::Https,
            };
            assert_eq!(
                config
                    .connection_url(backend, Some(&target), &[])
                    .unwrap_err()
                    .code,
                code
            );
        }
        let target = PreferredHost {
            host: config.authority(),
            scheme: AccessScheme::Https,
        };
        assert_eq!(
            config
                .connection_url(backend, Some(&target), &[])
                .unwrap_err()
                .code,
            "access-scheme-invalid"
        );
        assert!(serde_json::from_value::<PreferredHost>(serde_json::json!({
            "host": "desktop.local:443", "scheme": "file"
        }))
        .is_err());
        assert!(config
            .connection_url("http://192.168.1.21:3080/?token=fixture", None, &[])
            .is_err());
    }
    #[test]
    fn automatic_lan_host_cannot_be_duplicated_and_follows_the_adapter() {
        let mut c = config();
        let old_authority = c.authority();
        c.trusted_hosts.push(old_authority.clone());
        c.preferred_host = Some(PreferredHost {
            host: old_authority.clone(),
            scheme: AccessScheme::Http,
        });
        let mut c = c.validate(&addresses()).unwrap();
        assert_eq!(c.preferred_host, None);
        assert!(!c.trusted_hosts.contains(&old_authority));
        c.port = 4080;
        let c = c
            .for_startup(&[LanAddress {
                name: "Wi-Fi".into(),
                address: "192.168.1.89".into(),
            }])
            .unwrap();
        assert_eq!(c.access_origin(&[]), "http://192.168.1.89:4080/");
        assert_eq!(c.effective_hosts()[0], "192.168.1.89:4080");
        assert!(!c.effective_hosts().contains(&old_authority));
    }
    #[test]
    fn custom_preference_survives_adapter_changes_and_removal_requires_lan_selection() {
        let mut c = config();
        c.preferred_host = Some(PreferredHost {
            host: "desktop.local:443".into(),
            scheme: AccessScheme::Https,
        });
        let mut c = c
            .for_startup(&[LanAddress {
                name: "Wi-Fi".into(),
                address: "192.168.1.89".into(),
            }])
            .unwrap();
        assert_eq!(c.preferred_host.as_ref().unwrap().host, "desktop.local:443");
        c.trusted_hosts.clear();
        let available = [LanAddress {
            name: "Wi-Fi".into(),
            address: "192.168.1.89".into(),
        }];
        assert_eq!(
            c.clone().validate(&available).unwrap_err().code,
            "preferred-host-untrusted"
        );
        c.preferred_host = None;
        let c = c.validate(&available).unwrap();
        assert_eq!(c.effective_hosts(), ["192.168.1.89:3080"]);
        assert_eq!(
            c.connection_url("http://127.0.0.1:3080/?token=fixture", None, &[])
                .unwrap(),
            "http://192.168.1.89:3080/?token=fixture"
        );
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
        assert!(check_ready(&c, "http://127.0.0.1:3080/?token=x").is_ok());
        for bad in ["http://192.168.1.20:3080/", "http://127.0.0.1:3081/", "https://127.0.0.1:3080/", "http://user@127.0.0.1:3080/"] {
            assert!(check_ready(&c, bad).is_err());
        }
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
        let help = firewall_help(&config(), &[]);
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
    fn firewall_help_covers_all_lan_listeners_without_opening_loopback_to_the_network() {
        let listeners = vec![
            ListenerAddress {
                address: "192.168.1.20".into(),
                port: 3080,
            },
            ListenerAddress {
                address: "192.168.1.21".into(),
                port: 4080,
            },
            ListenerAddress {
                address: "127.0.0.1".into(),
                port: 3080,
            },
        ];
        let help = firewall_help(&config(), &listeners);
        assert_eq!(help.add.lines().count(), 2);
        assert_eq!(help.remove.lines().count(), 2);
        assert!(help
            .add
            .contains("-LocalAddress '192.168.1.21' -LocalPort 4080"));
        assert!(!help.add.contains("127.0.0.1"));
        assert!(help
            .add
            .lines()
            .all(|line| line.contains("-Profile Private -RemoteAddress LocalSubnet")));
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
