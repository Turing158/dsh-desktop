//! Locating and driving the DeepSeek Harness runtime.
//!
//! The desktop app does not reimplement DSH; it locates the user's runtime,
//! boots `dsh web` as a child process, and embeds the URL it prints. This module
//! owns three concerns: finding `node` and `dsh`, speaking the child's stdout
//! protocol, and shutting the child tree down cleanly.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Environment variable overriding the `node` executable, for unusual installs.
pub const ENV_NODE: &str = "DSH_DESKTOP_NODE";
/// Environment variable overriding the `dsh` entry script, for unusual installs.
pub const ENV_DSH: &str = "DSH_DESKTOP_DSH";

/// The stdout marker the host plugin writes; keep in sync with `desktop-notify.mjs`.
pub const NOTIFY_MARKER: &str = "__DSH_NOTIFY__";

/// The stdout marker reporting the app's appearance preference; keep in sync with
/// `desktop-ui.mjs`.
pub const THEME_MARKER: &str = "__DSH_THEME__";

/// The `dsh web:` readiness line, printed once after the loader tree settles.
const READY_PREFIX: &str = "dsh web:";

/// Minimum Node major version DSH can run on.
///
/// `@deepseek-ai/cordis-plugin-loader` bails out of its internal loader hook
/// below Node 22 (`if (major < 22) return`), which DSH needs to resolve bare
/// plugin specifiers. Anything older cannot boot the web profile.
pub const MIN_NODE_MAJOR: u32 = 22;

/// How long a one-shot probe (`--version`) may take before it is killed.
pub const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// How the runtime was found, so the UI can explain the situation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DshSource {
    /// Explicit user configuration.
    Configured,
    /// An immutable dependency tree selected and verified by the desktop host.
    Managed,
    /// The app's own private install prefix.
    Private,
    /// A pre-existing global npm install.
    Global,
}

/// A located runtime: what to execute and how it was chosen.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Runtime {
    pub node_exe: PathBuf,
    pub dsh_bin: PathBuf,
    pub source: DshSource,
    /// Version reported by `node bin.js --version`, when it could be read.
    pub version: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub managed: Option<crate::runtime_store::ManagedRuntime>,
}

/// One parsed line of child stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum ChildEvent {
    /// The authenticated GUI URL. Navigation may begin.
    Ready(String),
    /// A notification the host plugin reported.
    Notify(NotifyPayload),
    /// The app's appearance preference, reported by the UI overlay plugin.
    Theme(ThemeReport),
    /// Complete live agent activity from the title-bar host, independent of the UI.
    UpdateActivity(Option<bool>),
    Capability(crate::compatibility::Observation),
    Storage(crate::data_inventory::ProviderRoots),
    /// A line of ordinary output, kept for logs and error reporting.
    Log(String),
    /// The child exited with this code.
    Exited(i32),
}

/// The appearance preference the web app is running with.
///
/// Read from the app's own `ui-theme` settings namespace, so the native title bar
/// follows whatever the user chose inside DSH rather than a guess made here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Light,
    Dark,
    /// Follow the operating system. Also the theme plugin's own schema default,
    /// so both sides agree before the first report arrives.
    #[default]
    System,
}

/// The wire shape of a theme report.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct ThemeReport {
    pub preference: ThemePreference,
}

/// A notification request from the DSH host plugin.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NotifyPayload {
    /// `question` or `task-end`.
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, rename = "sessionId")]
    pub session_id: String,
}

impl NotifyPayload {
    /// A failure immediately after completion is a distinct notification.
    pub fn dedupe_key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.session_id,
            self.kind,
            self.reason.as_deref().unwrap_or("")
        )
    }
}

/// Parse one stdout line from the child.
///
/// Returns `None` for lines that carry nothing actionable, so ordinary logger
/// noise costs nothing.
pub fn parse_line(line: &str) -> Option<ChildEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("__DSH_CAPABILITY__ ") {
        if rest.len() > 4096 { return None; }
        let report: crate::compatibility::Observation = serde_json::from_str(rest).ok()?;
        return report.valid().then_some(ChildEvent::Capability(report));
    }
    if let Some(rest) = trimmed.strip_prefix("__DSH_STORAGE__ ") {
        if rest.len() > 12_288 { return None; }
        let report: crate::data_inventory::ProviderRoots = serde_json::from_str(rest).ok()?;
        return report.valid().then_some(ChildEvent::Storage(report));
    }

    if let Some(rest) = trimmed.strip_prefix("__DSH_UPDATE_ACTIVITY__ ") {
        #[derive(serde::Deserialize)]
        struct Activity { running: Option<bool> }
        let running = serde_json::from_str::<Activity>(rest).ok().and_then(|report| report.running);
        return Some(ChildEvent::UpdateActivity(running));
    }

    // The notification marker is checked first: a notification body could in
    // principle contain the readiness prefix, and the reverse is not possible.
    if let Some(rest) = trimmed
        .find(NOTIFY_MARKER)
        .map(|at| &trimmed[at + NOTIFY_MARKER.len()..])
    {
        if let Ok(payload) = serde_json::from_str::<NotifyPayload>(rest.trim()) {
            return Some(ChildEvent::Notify(payload));
        }
        // A malformed notification is logged, never fatal.
        return Some(ChildEvent::Log(trimmed.to_string()));
    }

    // Appearance reports share the notification channel's shape and its
    // tolerance: an unparsable report leaves the window on its previous colors
    // rather than failing the launch.
    if let Some(rest) = trimmed
        .find(THEME_MARKER)
        .map(|at| &trimmed[at + THEME_MARKER.len()..])
    {
        if let Ok(report) = serde_json::from_str::<ThemeReport>(rest.trim()) {
            return Some(ChildEvent::Theme(report));
        }
        return Some(ChildEvent::Log(trimmed.to_string()));
    }

    if let Some(url) = extract_ready_url(trimmed) {
        return Some(ChildEvent::Ready(url));
    }

    Some(ChildEvent::Log(trimmed.to_string()))
}

/// Pull the GUI URL out of a `dsh web:` readiness line.
///
/// The line has the shape `dsh web: http://127.0.0.1:PORT/?token=…` and may
/// carry a trailing ` (LAN: http://… )` segment, which is dropped: the loopback
/// URL is the one this app embeds.
pub fn extract_ready_url(line: &str) -> Option<String> {
    let at = line.find(READY_PREFIX)?;
    let rest = line[at + READY_PREFIX.len()..].trim_start();
    let candidate = rest.split_whitespace().next()?;
    let url = candidate.trim_end_matches([')', ',', ';']);
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Whether a path looks like an executable we can run.
fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// Join a Windows `PATH`-style string into candidate files with the given names.
fn executable_names(base: &str) -> Vec<PathBuf> {
    let mut names = vec![base.to_string()];
    if Path::new(base).extension().is_none() {
        names.push(format!("{base}.exe"));
    }
    names.into_iter().map(PathBuf::from).collect()
}

/// Search `PATH` for an executable, mirroring the platform's own lookup.
pub fn find_on_path(executable: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in executable_names(executable) {
            let candidate = dir.join(name);
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Absolute path of this app's private runtime prefix.
///
/// Installing here rather than into the global npm prefix is deliberate: a
/// global `npm install -g` reconciles the entire shared prefix and would remove
/// or replace unrelated tools the user already has installed.
pub fn private_prefix() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("DeepseekHarness").join("runtime"))
}

/// Where a private install would put the `dsh` entry script.
pub fn private_dsh_bin() -> Option<PathBuf> {
    Some(
        private_prefix()?
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
    )
}

/// The global npm prefix, read from `%APPDATA%\npm` (npm's default on Windows).
pub fn global_prefix() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("npm"))
}

/// Where a global install puts the `dsh` entry script.
pub fn global_dsh_bin() -> Option<PathBuf> {
    Some(
        global_prefix()?
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
    )
}

/// Locate the `node` executable.
///
/// Order: explicit environment override, then `PATH`, then the standard
/// installer location, which a `PATH`-less launcher (a shortcut, a scheduled
/// task) may still need.
pub fn resolve_node() -> Option<PathBuf> {
    if cfg!(feature = "offline") {
        if let Some(node) = crate::bundled_runtime::node() { return Some(node); }
        if !crate::bundled_runtime::allows_system_node() { return None; }
    }
    if let Some(explicit) = std::env::var_os(ENV_NODE) {
        let path = PathBuf::from(explicit);
        if is_file(&path) {
            return Some(path);
        }
    }
    if let Some(found) = find_on_path("node") {
        return Some(found);
    }
    for base in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(root) = std::env::var_os(base) {
            let candidate = PathBuf::from(root).join("nodejs").join("node.exe");
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Read `node --version` and extract the major number.
pub fn node_major(node_exe: &Path) -> Option<u32> {
    let output = Command::new(node_exe)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let major = text.trim().trim_start_matches('v').split('.').next()?;
    major.parse().ok()
}

/// Locate the DSH entry script.
///
/// Order matters: an explicit override, then the app's own install, then an
/// existing global install. Preferring the private install keeps the app
/// self-consistent once the user has chosen a version, while the global
/// fallback avoids duplicating a runtime the user already has.
pub fn resolve_dsh(prefer_private: bool) -> Option<(PathBuf, DshSource)> {
    if let Some(explicit) = std::env::var_os(ENV_DSH) {
        let path = PathBuf::from(explicit);
        if is_file(&path) {
            return Some((path, DshSource::Configured));
        }
    }

    let private = private_dsh_bin();
    let global = global_dsh_bin();
    let ordered = if prefer_private {
        [(private, DshSource::Private), (global, DshSource::Global)]
    } else {
        [(global, DshSource::Global), (private, DshSource::Private)]
    };

    for (candidate, source) in ordered {
        if let Some(path) = candidate {
            if is_file(&path) {
                return Some((path, source));
            }
        }
    }
    None
}

/// Read the DSH version from an entry script without booting a profile.
///
/// Bounded by [`VERSION_PROBE_TIMEOUT`]: a misconfigured `dsh` (or a stand-in
/// that does not implement `--version`) would otherwise leave this probe
/// waiting forever and the app stuck on its boot page. A timeout yields `None`,
/// which is harmless — the version is only ever shown to the user.
pub fn dsh_version(node_exe: &Path, dsh_bin: &Path) -> Option<String> {
    probe_version(node_exe, dsh_bin)
}

/// Run `<node> <script> --version` with a timeout, returning the trimmed output.
///
/// The child is always reaped, including on timeout, so a wedged probe cannot
/// become an orphan process.
pub fn probe_version(node_exe: &Path, script: &Path) -> Option<String> {
    let mut child = Command::new(node_exe)
        .arg(script)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags_no_window()
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + VERSION_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut text = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut text);
                }
                let version = text.trim().to_string();
                return (!version.is_empty()).then_some(version);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The request-header budget, in bytes, given to the `dsh` child.
///
/// 1 MiB, matching the ceiling Chromium enforces: a larger value would be
/// meaningless because the browser refuses first, and it is far above the ~16 KiB
/// default that DSH's combined plugin-bundle URL overflows once the desktop app
/// adds its own plugins.
const MAX_HTTP_HEADER_SIZE: usize = 1024 * 1024;

/// Build the `NODE_OPTIONS` value for the `dsh` child.
///
/// The user's own `NODE_OPTIONS` is preserved and this flag appended, because
/// overwriting it would silently discard settings the user needs (a custom
/// `--require`, an increased heap for a large session). A later flag wins in Node,
/// so appending also means the value here takes effect even if the user set their
/// own `--max-http-header-size`.
///
/// @param inherited - the current `NODE_OPTIONS`, if any.
/// @returns the value to pass to the child.
fn node_options_with_header_size(inherited: Option<&str>) -> String {
    let flag = format!("--max-http-header-size={MAX_HTTP_HEADER_SIZE}");
    match inherited.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => format!("{existing} {flag}"),
        None => flag,
    }
}

/// The exact argv for `dsh web`, minus the executable and entry script.
///
/// `--patch` is a launcher flag, so it must precede the web app's own flags: the
/// launcher hands everything after its first unrecognized token to the app, and
/// `web --no-open … --patch …` therefore fails with "unknown option '--patch'".
/// This is a free function so the ordering is pinned by a test.
fn web_args(patch_file: &Path, config: &crate::remote_control::Config) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = [
        // `web` selects the profile; the launcher's own flags follow it.
        std::ffi::OsString::from("web"),
        std::ffi::OsString::from("--patch"),
        patch_file.as_os_str().to_os_string(),
        // From here on the arguments belong to the web app.
        std::ffi::OsString::from("--no-open"),
    ]
    .into();
    if config.enabled {
        args.extend([
            "--host".into(),
            config.bind_address.clone().into(),
            "--port".into(),
            config.port.to_string().into(),
        ]);
        for host in config.effective_hosts() {
            args.extend(["--trusted-host".into(), host.into()]);
        }
    } else {
        args.extend(["--port".into(), "0".into()]);
    }
    args
}

/// A running `dsh web` child, its job object, and its output stream.
pub struct DshProcess {
    child: Child,
    /// Exact local sockets requested from this backend, published only after readiness.
    pub listeners: Vec<crate::remote_control::ListenerAddress>,
    _plugin_boot: tempfile::NamedTempFile,
    /// Kept alive so the job outlives the child handle: dropping it kills the tree.
    _job: crate::winjob::JobObject,
    /// The output stream, handed to its single consumer by [`DshProcess::take_events`].
    events: Option<Receiver<ChildEvent>>,
    /// Child stderr, kept for diagnostics.
    stderr: Arc<Mutex<Vec<String>>>,
}

impl DshProcess {
    /// Spawn `dsh web` and begin streaming its output as [`ChildEvent`]s.
    ///
    /// The child binds an OS-assigned port (`--port 0`), never opens a browser
    /// (`--no-open`, which would fight this app's window), and receives the
    /// notification overlay through `--patch`.
    pub fn spawn(
        runtime: &Runtime,
        patch_file: &Path,
        config: &crate::remote_control::Config,
        changes_dir: &Path,
    ) -> std::io::Result<Self> {
        let job = crate::winjob::JobObject::new()?;

        let plugin_file = changes_dir.parent().unwrap_or(changes_dir).join("desktop-plugins.json");
        let plugin_boot = crate::builtin_plugins::boot_patch(&plugin_file)?;
        prepare_profile_plugins(runtime, patch_file, plugin_boot.path())?;
        let mut args = web_args(patch_file, config);
        // Both launcher overlays must precede the first web-app option.
        args.splice(3..3, ["--patch".into(), plugin_boot.path().as_os_str().to_os_string()]);

        let listeners = if config.enabled {
            let addresses = crate::remote_control::lan_addresses()
                .map_err(|error| std::io::Error::other(error.message))?;
            config.listen_addresses(&addresses)
        } else {
            vec![]
        };

        let mut child = Command::new(&runtime.node_exe)
            .arg(&runtime.dsh_bin)
            .args(args)
            .env("DSH_DESKTOP_DSH_BIN", &runtime.dsh_bin)
            .env("DSH_DESKTOP_PLUGINS_FILE", &plugin_file)
            .env("DSH_DESKTOP_CHANGES_DIR", changes_dir)
            .env("DSH_DESKTOP_LISTENERS", serde_json::to_string(&listeners)?)
            // Node's default request-header budget is 16 KiB, and WebView2 spends
            // a surprising amount of it on a single script request. DSH loads its
            // client plugins as ONE combined URL — `/plugins/??a/client.js,b/…` —
            // which already measured 2518 characters before this app added
            // anything; each plugin path is another ~32.
            //
            // With the desktop app's two plugins the URL reached 2603 characters
            // and the server began answering 431 (Request Header Fields Too Large),
            // which the page surfaces only as "Failed to load plugins" — the whole
            // UI fails to mount, not just the new plugin.
            //
            // The 16 KiB default is not a shortage of URL room (2603 is far below
            // it) but of *total* header room: Chromium sends ~8 KB of
            // `sec-ch-ua`, Accept, and fetch-metadata headers per request, and Node
            // charges all of it to the same budget. Raising the budget is therefore
            // the correct fix rather than shortening the URL, because the URL grows
            // again with every plugin DSH or the user adds.
            //
            // 1 MiB matches the ceiling Chromium itself enforces; beyond that the
            // browser refuses regardless of what the server accepts.
            .env(
                "NODE_OPTIONS",
                node_options_with_header_size(std::env::var("NODE_OPTIONS").ok().as_deref()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_no_window()
            .spawn()?;

        // Adopt the child immediately: anything it spawns afterwards inherits
        // job membership, so the whole tree dies with this app.
        let assigned = crate::winjob::open_for_job(child.id()).and_then(|handle| {
            let result = job.assign(handle);
            unsafe { windows::Win32::Foundation::CloseHandle(handle) }.ok();
            result
        });
        if let Err(error) = assigned {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let (sender, events) = mpsc::channel();
        let stderr_lines = Arc::new(Mutex::new(Vec::new()));

        if let Some(stdout) = child.stdout.take() {
            spawn_stdout_reader(stdout, sender.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_reader(stderr, sender, Arc::clone(&stderr_lines));
        }

        Ok(Self {
            _plugin_boot: plugin_boot,
            child,
            listeners,
            _job: job,
            events: Some(events),
            stderr: stderr_lines,
        })
    }

    /// Take ownership of the child's event stream.
    ///
    /// There is exactly one receiver, so this succeeds once: the consumer that
    /// waits for readiness also keeps consuming for the process's lifetime.
    pub fn take_events(&mut self) -> Option<Receiver<ChildEvent>> {
        self.events.take()
    }

    /// The last few stderr lines, for an error screen.
    pub fn stderr_tail(&self, limit: usize) -> Vec<String> {
        let guard = self.stderr.lock().expect("stderr mutex poisoned");
        let start = guard.len().saturating_sub(limit);
        guard[start..].to_vec()
    }

    /// Stop the child and its tree.
    ///
    /// Killing the direct child is normally enough — the job object takes the
    /// descendants with it — but the kill is best-effort because the process may
    /// already be gone.
    pub fn shutdown(&mut self) {
        self._job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn stop_and_wait(&mut self) -> std::io::Result<()> {
        self.shutdown();
        self._job.wait_empty(std::time::Duration::from_secs(10))
    }
}

/// Resolve saved profile switches before any target plugin mounts. The helper
/// writes only the process-owned temporary patch, never a watched profile file.
fn prepare_profile_plugins(runtime: &Runtime, patch_file: &Path, boot_file: &Path) -> std::io::Result<()> {
    let helper = node_script_path(&patch_file.parent().unwrap().join("plugin-control").join("prepare-boot.mjs"));
    let mut child = Command::new(&runtime.node_exe)
        .arg(helper).arg(node_script_path(patch_file)).arg(node_script_path(boot_file))
        .env("DSH_DESKTOP_DSH_BIN", &runtime.dsh_bin)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
        .creation_flags_no_window().spawn()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    // Drain diagnostics while waiting so many stale entries cannot fill a pipe.
    let mut stderr = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let diagnostic = reader.join().unwrap_or_default();
                if !status.success() {
                    return Err(std::io::Error::other(format!("无法准备 DSH 插件设置：{diagnostic}")));
                }
                if !diagnostic.is_empty() { eprintln!("{diagnostic}"); }
                return Ok(());
            }
            Ok(None) if std::time::Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(result.err().unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "准备 DSH 插件设置超时")));
            }
        }
    }
}

// Tauri resource paths can carry Windows verbatim prefixes. Node's main-script
// resolver rejects those even though Rust can open them. Preserve OS strings.
pub(crate) fn node_script_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else { return path.to_path_buf() };
    let mut result = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = std::ffi::OsString::from("\\\\");
            root.push(server); root.push("\\"); root.push(share); root.push("\\");
            PathBuf::from(root)
        }
        _ => return path.to_path_buf(),
    };
    for component in components { if !matches!(component, Component::RootDir) { result.push(component.as_os_str()); } }
    result
}

impl Drop for DshProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Read stdout line by line, translating each line into an event.
fn spawn_stdout_reader(stdout: std::process::ChildStdout, sender: Sender<ChildEvent>) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(event) = parse_line(&line) {
                if sender.send(event).is_err() {
                    break;
                }
            }
        }
        let _ = sender.send(ChildEvent::Exited(-1));
    });
}

/// Drain stderr, retaining a bounded tail for diagnostics.
fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    sender: Sender<ChildEvent>,
    store: Arc<Mutex<Vec<String>>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Ok(mut guard) = store.lock() {
                // Bounded: a chatty child must not grow this without limit.
                if guard.len() >= 200 {
                    guard.remove(0);
                }
                guard.push(crate::remote_control::redact(&line));
            }
            let _ = sender.send(ChildEvent::Log(line));
        }
    });
}

/// Wait for the readiness URL, or give up after `timeout`.
///
/// Other events that arrive first are handed to `on_event`, so the caller can
/// log them (and show progress) while the tree boots. The receiver is borrowed,
/// so the same stream keeps being consumed afterwards.
pub fn await_ready(
    events: &Receiver<ChildEvent>,
    timeout: Duration,
    mut on_event: impl FnMut(ChildEvent),
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "等待 {} 秒仍未收到 dsh web 的就绪信息",
                timeout.as_secs()
            ));
        }
        match events.recv_timeout(remaining) {
            Ok(ChildEvent::Ready(url)) => return Ok(url),
            Ok(ChildEvent::Exited(code)) => {
                // The stdout reader reports -1 when the pipe closed without a
                // status; the process exit code is read separately in that case.
                return Err(if code >= 0 {
                    format!("dsh 进程已退出（退出码 {code}）")
                } else {
                    "dsh 进程已退出".to_string()
                });
            }
            Ok(other) => on_event(other),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "等待 {} 秒仍未收到 dsh web 的就绪信息",
                    timeout.as_secs()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("dsh 进程输出流已关闭".to_string());
            }
        }
    }
}

/// Extension trait adding the console-window suppression flag to `Command`.
pub trait CommandExt {
    /// Prevent a console window from flashing when the child starts.
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

impl CommandExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt as _;
        /// `CREATE_NO_WINDOW`: the child gets no console, so launching the app
        /// from a shortcut does not flash a terminal.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

/// Read an entire reader to a string, for one-shot command output.
#[cfg(test)]
#[allow(dead_code)]
pub fn read_to_string(mut reader: impl Read) -> std::io::Result<String> {
    let mut buffer = String::new();
    reader.read_to_string(&mut buffer)?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_dsh_lookup_also_works_with_bundled_node() {
        const CHILD: &str = "DSH_TEST_EXTERNAL_LOOKUP_ROOT";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = PathBuf::from(root);
            assert_eq!(resolve_dsh(false), None);

            let private = root.join("DeepseekHarness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js");
            let global = root.join("npm/node_modules/@deepseek-ai/dsh/lib/bin.js");
            let configured = root.join("configured.js");
            for path in [&private, &global, &configured] {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"test fixture").unwrap();
                let source = if path == &private { DshSource::Private }
                    else if path == &global { DshSource::Global }
                    else { DshSource::Configured };
                assert_eq!(resolve_dsh(false), Some((path.clone(), source)));
                if path == &global {
                    assert_eq!(resolve_dsh(true), Some((private.clone(), DshSource::Private)));
                }
            }
            return;
        }

        // Isolate APPDATA and the explicit override from other parallel tests
        // and from any real DSH installed on the developer's machine.
        let root = tempfile::tempdir().unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "dsh::tests::external_dsh_lookup_also_works_with_bundled_node", "--nocapture"])
            .env(CHILD, root.path())
            .env("APPDATA", root.path())
            .env(ENV_DSH, root.path().join("configured.js"))
            .output().unwrap();
        assert!(result.status.success(), "{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    }

    #[test]
    fn node_main_scripts_accept_tauri_resource_paths() {
        assert_eq!(node_script_path(Path::new(r"\\?\D:\app\plugin-control\prepare-boot.mjs")), PathBuf::from(r"D:\app\plugin-control\prepare-boot.mjs"));
        assert_eq!(node_script_path(Path::new(r"\\?\UNC\server\share\插件\prepare-boot.mjs")), PathBuf::from(r"\\server\share\插件\prepare-boot.mjs"));
        assert_eq!(node_script_path(Path::new(r"D:\app\prepare-boot.mjs")), PathBuf::from(r"D:\app\prepare-boot.mjs"));
    }

    #[test]
    fn parses_a_plain_readiness_line() {
        let line = "dsh web: http://127.0.0.1:43210/?token=abcDEF123";
        assert_eq!(
            parse_line(line),
            Some(ChildEvent::Ready(
                "http://127.0.0.1:43210/?token=abcDEF123".to_string()
            ))
        );
    }

    #[test]
    fn drops_the_lan_suffix_from_a_readiness_line() {
        let line =
            "dsh web: http://127.0.0.1:3080/?token=xyz (LAN: http://192.168.1.5:3080/?token=xyz)";
        let url = extract_ready_url(line).expect("url");
        assert_eq!(url, "http://127.0.0.1:3080/?token=xyz");
    }

    #[test]
    fn finds_the_readiness_line_among_log_noise() {
        // The announce is a console.log among logger output, so it must not be
        // assumed to be the first line.
        let line = "2026-01-01T00:00:00.000Z [loader] info apply plugin dsh-base";
        assert_eq!(
            parse_line(line).map(|e| matches!(e, ChildEvent::Log(_))),
            Some(true)
        );

        let ready = "dsh web: http://127.0.0.1:51234/?token=TOKEN";
        assert!(matches!(parse_line(ready), Some(ChildEvent::Ready(_))));
    }

    #[test]
    fn rejects_a_readiness_line_without_a_url() {
        assert_eq!(
            extract_ready_url("dsh web: opening the default browser"),
            None
        );
        assert_eq!(extract_ready_url("nothing to see"), None);
    }

    #[test]
    fn parses_a_question_notification() {
        let line = r#"__DSH_NOTIFY__ {"kind":"question","title":"DSH 需要你的选择","body":"选择模式","sessionId":"s-1"}"#;
        let event = parse_line(line).expect("event");
        match event {
            ChildEvent::Notify(payload) => {
                assert_eq!(payload.kind, "question");
                assert_eq!(payload.title, "DSH 需要你的选择");
                assert_eq!(payload.body, "选择模式");
                assert_eq!(payload.session_id, "s-1");
            }
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_task_end_notification_with_its_reason() {
        let line = r#"__DSH_NOTIFY__ {"kind":"task-end","title":"DSH 任务完成","body":"done","reason":"completed","sessionId":"s-2"}"#;
        match parse_line(line).expect("event") {
            ChildEvent::Notify(payload) => {
                assert_eq!(payload.kind, "task-end");
                assert_eq!(payload.reason.as_deref(), Some("completed"));
            }
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn a_malformed_notification_degrades_to_a_log_line() {
        let line = "__DSH_NOTIFY__ {this is not json";
        match parse_line(line) {
            Some(ChildEvent::Log(text)) => assert_eq!(text, line),
            other => panic!("expected a log line, got {other:?}"),
        }
    }

    #[test]
    fn ignores_blank_lines() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("   "), None);
    }

    #[test]
    fn launcher_flags_precede_app_flags() {
        // Regression guard: `dsh web --no-open --patch …` is rejected by the
        // launcher ("unknown option '--patch'"), which silently disables
        // notifications because the plugin never mounts.
        let args = web_args(
            Path::new("C:/app/desktop-notify.patch.yml"),
            &crate::remote_control::Config::default(),
        );
        let as_text: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        let patch_at = as_text
            .iter()
            .position(|a| a == "--patch")
            .expect("--patch present");
        let no_open_at = as_text
            .iter()
            .position(|a| a == "--no-open")
            .expect("--no-open present");

        assert_eq!(as_text[0], "web");
        assert_eq!(patch_at, 1, "web must be followed immediately by --patch");
        assert!(
            patch_at < no_open_at,
            "--patch (launcher) must come before --no-open (app): {as_text:?}"
        );
        // The patch path is passed through as its own argument.
        assert_eq!(as_text[patch_at + 1], "C:/app/desktop-notify.patch.yml");
        // The app's own flags carry their values.
        assert_eq!(as_text[no_open_at + 1], "--port");
        assert_eq!(as_text[no_open_at + 2], "0");
    }

    #[test]
    fn header_size_flag_is_added_when_node_options_absent() {
        let value = node_options_with_header_size(None);
        assert_eq!(value, "--max-http-header-size=1048576");
    }

    #[test]
    fn header_size_flag_is_appended_to_existing_node_options() {
        // The user's own options must survive: discarding them could remove a
        // --require their tooling depends on, or a raised heap limit.
        let value = node_options_with_header_size(Some("--max-old-space-size=4096"));
        assert_eq!(
            value,
            "--max-old-space-size=4096 --max-http-header-size=1048576"
        );
        // Appended last so it wins in Node, which takes the final occurrence.
        assert!(value.ends_with("--max-http-header-size=1048576"));
    }

    #[test]
    fn blank_node_options_do_not_leave_a_stray_space() {
        // An empty NODE_OPTIONS is common on Windows (set but unused); passing it
        // through would produce a leading space, which Node tolerates but which
        // makes the value harder to compare.
        assert_eq!(
            node_options_with_header_size(Some("")),
            "--max-http-header-size=1048576"
        );
        assert_eq!(
            node_options_with_header_size(Some("   ")),
            "--max-http-header-size=1048576"
        );
    }

    #[test]
    fn header_size_matches_chromium_ceiling() {
        // Above 1 MiB the browser refuses first, so a larger budget would be dead
        // configuration; far below it the 2603-character plugin URL that broke
        // loading would fit only by luck.
        assert_eq!(MAX_HTTP_HEADER_SIZE, 1024 * 1024);
        assert!(
            MAX_HTTP_HEADER_SIZE > 2603 * 4,
            "the budget must comfortably exceed the combined plugin-bundle URL"
        );
    }

    #[test]
    fn treats_unknown_output_as_log_lines() {
        match parse_line("some other message") {
            Some(ChildEvent::Log(text)) => assert_eq!(text, "some other message"),
            other => panic!("expected a log line, got {other:?}"),
        }
    }

    #[test]
    fn await_ready_returns_the_first_url() {
        let (sender, receiver) = mpsc::channel();
        sender.send(ChildEvent::Log("booting".into())).unwrap();
        sender
            .send(ChildEvent::Ready("http://127.0.0.1:1/?token=t".into()))
            .unwrap();

        let mut seen = Vec::new();
        let url = await_ready(&receiver, Duration::from_secs(5), |event| seen.push(event))
            .expect("ready");
        assert_eq!(url, "http://127.0.0.1:1/?token=t");
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn await_ready_fails_when_the_child_dies_first() {
        let (sender, receiver) = mpsc::channel();
        sender.send(ChildEvent::Exited(1)).unwrap();
        let error =
            await_ready(&receiver, Duration::from_secs(5), |_| {}).expect_err("should fail");
        assert!(error.contains("退出码 1"), "unexpected error: {error}");
    }

    #[test]
    fn await_ready_times_out() {
        let (_sender, receiver) = mpsc::channel::<ChildEvent>();
        let error =
            await_ready(&receiver, Duration::from_millis(50), |_| {}).expect_err("should time out");
        assert!(error.contains("仍未收到"), "unexpected error: {error}");
    }
}
