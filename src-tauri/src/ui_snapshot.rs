//! Versioned, bounded UI data. Chat history and browser credentials never belong here.
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_SNAPSHOT_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
pub const REQUIRED: &[&str] = &[
    "page",
    "drafts",
    "attachments",
    "selection",
    "scroll",
    "layout",
    "dialogs",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum UiPhase {
    #[default]
    Active,
    Capturing,
    Destroying,
    Minimal,
    Restoring,
    RestoreFailed,
    Exiting,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShowAction {
    Wait,
    Focus,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub operation_id: u64,
    pub window_generation: u64,
    pub document_generation: u64,
    pub backend_instance: u64,
}

pub struct UiState {
    pub enabled: bool,
    pub phase: UiPhase,
    pub operation_id: u64,
    pub window_generation: u64,
    pub document_generation: u64,
    pub backend_instance: u64,
    pub loaded: bool,
    pub document_url: Option<tauri::Url>,
    pub snapshot: Option<Arc<UiSnapshot>>,
    pub geometry: Option<WindowGeometry>,
    pub focus_requested: bool,
    pub last_error: Option<String>,
    pub started: Instant,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            // Keep the shipping behavior until the real DSH + installer matrix passes.
            enabled: std::env::var("DSH_DESKTOP_WEBVIEW_RESTORE").as_deref() == Ok("1"),
            phase: UiPhase::Active,
            operation_id: 0,
            window_generation: 0,
            document_generation: 0,
            backend_instance: 0,
            loaded: false,
            document_url: None,
            snapshot: None,
            geometry: None,
            focus_requested: false,
            last_error: None,
            started: Instant::now(),
        }
    }
}
impl UiState {
    pub fn identity(&self) -> Identity {
        Identity {
            operation_id: self.operation_id,
            window_generation: self.window_generation,
            document_generation: self.document_generation,
            backend_instance: self.backend_instance,
        }
    }
    pub fn matches(&self, identity: Identity) -> bool {
        self.identity() == identity && self.phase != UiPhase::Exiting
    }
    /// Native window disposal does not depend on a booting backend's generation.
    /// Page IPC still uses the full identity above.
    pub fn owns_destruction(&self, identity: Identity) -> bool {
        self.phase == UiPhase::Destroying
            && self.operation_id == identity.operation_id
            && self.window_generation == identity.window_generation
            && self.document_generation == identity.document_generation
    }
    pub fn transition(&mut self, phase: UiPhase) -> Identity {
        if self.phase == UiPhase::Exiting {
            return self.identity();
        }
        self.operation_id += 1;
        self.phase = phase;
        self.started = Instant::now();
        self.identity()
    }
    pub fn busy(&self) -> bool {
        matches!(
            self.phase,
            UiPhase::Capturing | UiPhase::Destroying | UiPhase::Restoring | UiPhase::Exiting
        )
    }
    pub fn request_show(&mut self, missing: bool) -> ShowAction {
        if self.phase == UiPhase::Exiting {
            return ShowAction::Wait;
        }
        self.focus_requested = true;
        match self.phase {
            UiPhase::Destroying => ShowAction::Wait,
            UiPhase::Restoring => ShowAction::Focus,
            UiPhase::Capturing => {
                self.transition(UiPhase::Active);
                ShowAction::Focus
            }
            UiPhase::Minimal | UiPhase::RestoreFailed => {
                self.last_error = None;
                self.transition(UiPhase::Restoring);
                ShowAction::Restore
            }
            UiPhase::Active if missing => {
                self.transition(UiPhase::Restoring);
                ShowAction::Restore
            }
            _ => ShowAction::Focus,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub kind: String,
    pub route: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub start: usize,
    pub end: usize,
    pub focused: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub session_id: String,
    pub text: String,
    pub editor: Value,
    pub selection: Option<Selection>,
    pub attachment_keys: Vec<String>,
    pub revision: u64,
    pub view: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub key: String,
    pub name: String,
    pub media_type: String,
    pub last_modified: u64,
    pub size: usize,
    pub data: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub sidebar: f64,
    pub narrow_expanded: bool,
    pub rightbar: Option<f64>,
    pub panel: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScrollPosition {
    pub session_id: String,
    pub anchor: Option<String>,
    pub offset: f64,
    pub following: bool,
    pub scroll_top: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dialog {
    pub id: String,
    pub version: u32,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPayload {
    pub schema_version: u32,
    pub frontend_version: String,
    pub page: Page,
    pub drafts: Vec<Draft>,
    pub assets: Vec<Asset>,
    pub layout: Layout,
    pub scrolls: Vec<ScrollPosition>,
    pub dialogs: Vec<Dialog>,
    pub capabilities: Vec<String>,
    pub blocked: Vec<String>,
    pub session_storage: BTreeMap<String, String>,
}
impl UiPayload {
    pub fn boot() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            frontend_version: "boot-v1".into(),
            page: Page {
                kind: "boot".into(),
                route: "/".into(),
                ..Default::default()
            },
            drafts: vec![],
            assets: vec![],
            layout: Layout::default(),
            scrolls: vec![],
            dialogs: vec![],
            capabilities: REQUIRED.iter().map(|s| s.to_string()).collect(),
            blocked: vec![],
            session_storage: BTreeMap::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err("snapshot-version".into());
        }
        if serde_json::to_vec(self).map_err(|_| "snapshot-json")?.len() > MAX_SNAPSHOT_BYTES {
            return Err("snapshot-too-large".into());
        }
        if !self.blocked.is_empty()
            || REQUIRED
                .iter()
                .any(|c| !self.capabilities.iter().any(|v| v == c))
        {
            return Err("snapshot-incomplete".into());
        }
        if !matches!(self.page.kind.as_str(), "boot" | "dsh") || self.frontend_version.len() > 80 {
            return Err("snapshot-page".into());
        }
        if !self.page.route.starts_with('/')
            || self.page.route.starts_with("//")
            || self.page.route.contains('?')
            || self.page.route.len() > 2048
        {
            return Err("snapshot-route".into());
        }
        if self.drafts.len() > 128
            || self.assets.len() > 32
            || self.dialogs.len() > 8
            || self.scrolls.len() > 128
        {
            return Err("snapshot-count".into());
        }
        // No required sessionStorage keys exist in the currently audited DSH adapter.
        if !self.session_storage.is_empty() {
            return Err("snapshot-storage-unsupported".into());
        }
        let valid_id =
            |id: &str| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control);
        if self
            .page
            .session_id
            .iter()
            .chain(self.page.workspace_id.iter())
            .any(|id| !valid_id(id))
        {
            return Err("snapshot-id".into());
        }
        let mut ids = HashSet::new();
        let mut assets = HashSet::new();
        let mut total = 0usize;
        for asset in &self.assets {
            if !valid_id(&asset.key)
                || !assets.insert(&asset.key)
                || asset.name.len() > 512
                || asset.media_type.len() > 128
            {
                return Err("snapshot-asset".into());
            }
            total = total.checked_add(asset.size).ok_or("snapshot-asset-size")?;
            if total > MAX_ATTACHMENT_BYTES {
                return Err("snapshot-asset-size".into());
            }
            let bytes = STANDARD
                .decode(&asset.data)
                .map_err(|_| "snapshot-asset-base64")?;
            if bytes.len() != asset.size {
                return Err("snapshot-asset-size".into());
            }
        }
        for draft in &self.drafts {
            if !valid_id(&draft.session_id)
                || !ids.insert(&draft.session_id)
                || draft.text.len() > 512 * 1024
            {
                return Err("snapshot-draft".into());
            }
            if draft
                .attachment_keys
                .iter()
                .any(|key| !assets.contains(key))
            {
                return Err("snapshot-asset-missing".into());
            }
            if let Some(s) = &draft.selection {
                if s.start > s.end || s.end > draft.text.encode_utf16().count() {
                    return Err("snapshot-selection".into());
                }
            }
            bounded_json(&draft.editor, 0)?;
        }
        if self.page.kind == "boot"
            && (!self.drafts.is_empty() || !self.assets.is_empty() || !self.dialogs.is_empty())
        {
            return Err("snapshot-boot-content".into());
        }
        for value in [self.layout.sidebar, self.layout.rightbar.unwrap_or(0.0)] {
            if !value.is_finite() || !(0.0..=20000.0).contains(&value) {
                return Err("snapshot-layout".into());
            }
        }
        for scroll in &self.scrolls {
            if !valid_id(&scroll.session_id)
                || scroll.anchor.as_ref().is_some_and(|s| !valid_id(s))
                || !scroll.offset.is_finite()
                || !scroll.scroll_top.is_finite()
                || scroll.offset.abs() > 1e8
                || !(0.0..=1e9).contains(&scroll.scroll_top)
            {
                return Err("snapshot-scroll".into());
            }
        }
        for dialog in &self.dialogs {
            if !matches!(
                dialog.id.as_str(),
                "title-bar" | "desktop-terminal" | "desktop-changes" | "desktop-file-editor"
            ) || dialog.version != 1
            {
                return Err("snapshot-dialog-unsupported".into());
            }
            bounded_json(&dialog.data, 0)?;
        }
        Ok(())
    }
}

fn bounded_json(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("snapshot-depth".into());
    }
    match value {
        Value::Array(items) => {
            if items.len() > 10000 {
                return Err("snapshot-fields".into());
            }
            for item in items {
                bounded_json(item, depth + 1)?;
            }
        }
        Value::Object(items) => {
            if items.len() > 128 {
                return Err("snapshot-fields".into());
            }
            for (key, item) in items {
                if key.len() > 256 {
                    return Err("snapshot-key".into());
                }
                bounded_json(item, depth + 1)?;
            }
        }
        Value::String(text) if text.len() > 512 * 1024 => return Err("snapshot-string".into()),
        _ => {}
    }
    Ok(())
}

struct StoredAsset {
    path: PathBuf,
    size: usize,
    digest: Vec<u8>,
}
struct SnapshotFiles {
    dir: PathBuf,
    assets: BTreeMap<String, StoredAsset>,
}
impl Drop for SnapshotFiles {
    fn drop(&mut self) {
        // Paths are created here from numeric indexes, never from client names.
        for asset in self.assets.values() {
            let _ = std::fs::remove_file(&asset.path);
        }
        let _ = std::fs::remove_dir(&self.dir);
    }
}
pub struct UiSnapshot {
    pub snapshot_id: u64,
    pub source: Identity,
    pub captured_at: u64,
    pub payload: UiPayload,
    files: Option<SnapshotFiles>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWire {
    snapshot_id: u64,
    source: Identity,
    captured_at: u64,
    payload: UiPayload,
}
impl UiSnapshot {
    /// Validate and stage on a worker before acknowledging that destruction is safe.
    pub fn capture(mut payload: UiPayload, source: Identity) -> Result<Self, String> {
        payload.validate()?;
        let captured_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut files = None;
        if !payload.assets.is_empty() {
            let dir = std::env::temp_dir().join(format!(
                "dsh-ui-{}-{}-{captured_at}",
                std::process::id(),
                source.operation_id
            ));
            std::fs::create_dir(&dir).map_err(|_| "snapshot-stage-create")?;
            let mut held = SnapshotFiles {
                dir,
                assets: BTreeMap::new(),
            };
            for (index, asset) in payload.assets.iter_mut().enumerate() {
                let bytes = STANDARD
                    .decode(&asset.data)
                    .map_err(|_| "snapshot-asset-base64")?;
                let path = held.dir.join(index.to_string());
                let digest = Sha256::digest(&bytes).to_vec();
                held.assets.insert(
                    asset.key.clone(),
                    StoredAsset {
                        path: path.clone(),
                        size: bytes.len(),
                        digest: digest.clone(),
                    },
                );
                std::fs::write(&path, &bytes).map_err(|_| "snapshot-stage-write")?;
                if Sha256::digest(std::fs::read(&path).map_err(|_| "snapshot-stage-read")?)
                    .as_slice()
                    != digest
                {
                    return Err("snapshot-stage-integrity".into());
                }
                asset.data.clear();
            }
            files = Some(held);
        }
        Ok(Self {
            snapshot_id: source.operation_id,
            source,
            captured_at,
            payload,
            files,
        })
    }
    pub fn wire(&self) -> Result<SnapshotWire, String> {
        let mut payload = self.payload.clone();
        if let Some(files) = &self.files {
            for asset in &mut payload.assets {
                let stored = files
                    .assets
                    .get(&asset.key)
                    .ok_or("snapshot-asset-missing")?;
                let bytes = std::fs::read(&stored.path).map_err(|_| "snapshot-stage-read")?;
                if bytes.len() != stored.size || Sha256::digest(&bytes).as_slice() != stored.digest
                {
                    return Err("snapshot-stage-integrity".into());
                }
                asset.data = STANDARD.encode(bytes);
            }
        }
        Ok(SnapshotWire {
            snapshot_id: self.snapshot_id,
            source: self.source,
            captured_at: self.captured_at,
            payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub monitor: Option<String>,
    pub maximized: bool,
}
pub fn record_geometry(window: &WebviewWindow, generation: u64) {
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let normal = if !maximized && !minimized {
        window
            .outer_position()
            .ok()
            .zip(window.inner_size().ok())
            .map(|(position, size)| WindowGeometry {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale: window.scale_factor().unwrap_or(1.0),
                monitor: window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .and_then(|m| m.name().cloned()),
                maximized,
            })
    } else {
        None
    };
    if let Ok(mut guard) = window.state::<crate::state::Shared>().lock() {
        if guard.ui.window_generation != generation || guard.ui.phase == UiPhase::Exiting {
            return;
        }
        if let Some(normal) = normal {
            guard.ui.geometry = Some(normal);
        }
        if !minimized {
            if let Some(geometry) = &mut guard.ui.geometry {
                geometry.maximized = maximized;
            }
        }
    };
}
pub fn apply_geometry(window: &WebviewWindow, saved: &WindowGeometry) -> tauri::Result<()> {
    let monitors = window.available_monitors()?;
    let monitor = monitors
        .iter()
        .find(|m| m.name() == saved.monitor.as_ref())
        .or(monitors.first());
    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        let ratio = monitor.scale_factor() / saved.scale.max(0.25);
        let width = ((saved.width as f64 * ratio).round() as u32).clamp(1, work.size.width.max(1));
        let height =
            ((saved.height as f64 * ratio).round() as u32).clamp(1, work.size.height.max(1));
        let x = saved.x.clamp(
            work.position.x,
            work.position
                .x
                .saturating_add((work.size.width - width) as i32),
        );
        let y = saved.y.clamp(
            work.position.y,
            work.position
                .y
                .saturating_add((work.size.height - height) as i32),
        );
        window.set_min_size(Some(tauri::PhysicalSize::new(
            width.min(900),
            height.min(600),
        )))?;
        window.set_size(tauri::PhysicalSize::new(width, height))?;
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    if saved.maximized {
        window.maximize()?;
    }
    Ok(())
}

/// Whether a URL is served by this app's own bundle in a **packaged** build.
///
/// The custom protocol is the packaged answer only. A development run serves the
/// same page from the Tauri CLI's built-in server instead, which is a loopback
/// HTTP origin - so anything asking "is this our own page" wants
/// [`is_app_document`] rather than this.
pub fn is_local(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
}

/// Whether a URL is the document **this build** serves for itself.
///
/// Two builds, two answers. A packaged app serves its own page over the `tauri`
/// protocol, which [`is_local`] recognises. `tauri dev` serves it from the CLI's
/// built-in server, whose origin is the configured `devUrl` - Tauri's own
/// `is_local_url` accepts that origin, which is precisely why the ACL resolves
/// `[local]` grants for it. A stricter answer here therefore does not tighten
/// security; it silently refuses every command the boot page makes, because the
/// ACL gate in `remote_control::current_invocation` reads this to decide whether
/// the page that called may use the grant it was given.
///
/// Matched by **origin against the configured dev URL**, never by "is loopback":
/// loopback is also where the DSH server and every other local tool lives, and
/// the onboarding permissions install software. A different port is a different
/// document.
pub fn is_app_document(app: &AppHandle, url: &tauri::Url) -> bool {
    is_app_origin(app.config().build.dev_url.as_ref(), url)
}

/// The rule behind [`is_app_document`], without an app handle, so it can be
/// asserted directly in a unit test.
fn is_app_origin(dev_url: Option<&tauri::Url>, url: &tauri::Url) -> bool {
    is_local(url) || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

pub fn allowed_origin(app: &AppHandle, url: &tauri::Url, phase: &crate::state::Phase) -> bool {
    allowed_origin_with(is_app_document(app, url), url, phase)
}

/// [`allowed_origin`] with the "our own document" answer already decided.
fn allowed_origin_with(app_document: bool, url: &tauri::Url, phase: &crate::state::Phase) -> bool {
    if app_document {
        return true;
    }
    let crate::state::Phase::Running { url: running, .. } = phase else {
        return false;
    };
    running.parse::<tauri::Url>().is_ok_and(|expected| {
        matches!(expected.scheme(), "http" | "https") && url.origin() == expected.origin()
    })
}

/// Tauri checks the requesting frame's real origin before dispatch. The global
/// invocation guard also rejects grants left over from previous backend origins.
pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|_| "snapshot-origin")?;
    let capability = serde_json::json!({
        "identifier": format!("ui-snapshot-backend-{instance}"),
        "windows": ["main"], "local": false,
        "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] },
        "permissions": ["allow-ui-snapshot"]
    });
    app.add_capability(capability.to_string())
        .map_err(|_| "snapshot-permission".into())
}
fn validate_caller(window: &WebviewWindow, identity: Identity) -> Result<(), String> {
    let url = window.url().map_err(|_| "snapshot-origin")?;
    let shared = window.state::<crate::state::Shared>();
    let guard = shared.lock().map_err(|_| "snapshot-state")?;
    if window.label() != "main" || !allowed_origin(window.app_handle(), &url, &guard.phase) {
        return Err("snapshot-origin".into());
    }
    if (!guard.ui.enabled && guard.remote.restore_instance.is_none())
        || !guard.ui.loaded
        || !guard.ui.matches(identity)
    {
        return Err("snapshot-stale".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn submit_ui_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    payload: Option<UiPayload>,
    error: Option<String>,
) -> Result<(), String> {
    validate_caller(&window, identity)?;
    if let Some(error) = error {
        crate::minimal::capture_failed(&app, identity, safe_error(&error));
        return Ok(());
    }
    let payload = payload.ok_or("snapshot-missing")?;
    // A remote page cannot disguise unsaved business state as a boot snapshot.
    if payload.page.kind == "boot"
        && !is_app_document(&app, &window.url().map_err(|_| "snapshot-origin")?)
    {
        return Err("snapshot-page".into());
    }
    let result =
        tauri::async_runtime::spawn_blocking(move || UiSnapshot::capture(payload, identity))
            .await
            .map_err(|_| "snapshot-worker")?;
    validate_caller(&window, identity)?;
    match result {
        Ok(snapshot) => crate::minimal::captured(&app, identity, Arc::new(snapshot)),
        Err(error) => {
            crate::minimal::capture_failed(&app, identity, &error);
            Err(error)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReply {
    pub identity: Identity,
    pub phase: UiPhase,
    pub snapshot: Option<SnapshotWire>,
}
#[tauri::command]
pub async fn request_ui_restore(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    retry: bool,
) -> Result<RestoreReply, String> {
    validate_caller(&window, identity)?;
    if retry {
        crate::minimal::show(&app);
    }
    let (current, phase, snapshot) = {
        let shared = app.state::<crate::state::Shared>();
        let guard = shared.lock().map_err(|_| "snapshot-state")?;
        (
            guard.ui.identity(),
            guard.ui.phase,
            guard.ui.snapshot.clone(),
        )
    };
    let snapshot = if phase == UiPhase::Restoring {
        let snapshot = snapshot.ok_or("snapshot-missing")?;
        if snapshot.payload.page.kind != "boot"
            && snapshot.source.backend_instance != current.backend_instance
            && app
                .state::<crate::state::Shared>()
                .lock()
                .map_err(|_| "snapshot-state")?
                .remote
                .restore_instance
                != Some(current.backend_instance)
        {
            crate::minimal::restore_failed(&app, current.operation_id, "snapshot-backend-changed");
            return Err("snapshot-backend-changed".into());
        }
        let result = tauri::async_runtime::spawn_blocking(move || snapshot.wire())
            .await
            .map_err(|_| "snapshot-worker")?;
        match result {
            Ok(wire) => Some(wire),
            Err(error) => {
                crate::minimal::restore_failed(&app, current.operation_id, &error);
                return Err(error);
            }
        }
    } else {
        None
    };
    validate_caller(&window, current)?;
    Ok(RestoreReply {
        identity: current,
        phase,
        snapshot,
    })
}

#[tauri::command]
pub fn finish_ui_restore(
    app: AppHandle,
    window: WebviewWindow,
    identity: Identity,
    snapshot_id: u64,
    restored: Vec<String>,
    error: Option<String>,
) -> Result<(), String> {
    validate_caller(&window, identity)?;
    crate::minimal::restored(
        &app,
        identity,
        snapshot_id,
        &restored,
        error.as_deref().map(safe_error),
    )
}

fn safe_error(error: &str) -> &str {
    if !error.is_empty()
        && error.len() <= 80
        && error
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        error
    } else {
        "snapshot-adapter-error"
    }
}

pub fn initialization_script(app: &AppHandle, generation: u64, restoring: bool) -> String {
    let smoke = cfg!(debug_assertions) && std::env::var_os("DSH_DESKTOP_SMOKE_DIR").is_some();
    fn source(name: &str, embedded: &str) -> String {
        if cfg!(debug_assertions) {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../dsh-plugin/ui-state")
                .join(name);
            if let Ok(source) = std::fs::read_to_string(path) {
                return source;
            }
        }
        embedded.into()
    }
    // The origin this build serves its own page from, which the bridge cannot
    // work out for itself: the packaged protocol check does not cover the
    // development server. `null` in a packaged build, where the protocol check
    // is already the whole answer.
    let app_origin = app
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|url| url.origin().ascii_serialization());
    format!(
        "window.__DSH_UI_BOOT__ = {{windowGeneration:{generation},restoring:{restoring},smoke:{smoke},appOrigin:{}}};\n{}\n{}",
        serde_json::to_string(&app_origin).unwrap_or_else(|_| "null".into()),
        source("bridge.js", include_str!("../../dsh-plugin/ui-state/bridge.js")),
        source("adapter.js", include_str!("../../dsh-plugin/ui-state/adapter.js")),
    )
}
pub fn refresh_bridge(window: &WebviewWindow) {
    let packet = {
        let shared = window.state::<crate::state::Shared>();
        let Ok(guard) = shared.lock() else {
            return;
        };
        if !guard.ui.loaded {
            return;
        }
        let version = match &guard.phase {
            crate::state::Phase::Running { version, .. } => version.as_deref(),
            _ => None,
        };
        serde_json::json!({ "identity":guard.ui.identity(), "phase":guard.ui.phase, "error":guard.ui.last_error, "frontendVersion":version })
    };
    let _ = window.eval(&format!("window.__DSH_UI_STATE__?.configure({packet});"));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn show_cancels_capture_but_waits_for_disposal_and_merges_retries() {
        let mut state = UiState::default();
        let capturing = state.transition(UiPhase::Capturing);
        assert_eq!(state.request_show(false), ShowAction::Focus);
        assert!(!state.matches(capturing));
        let destroying = state.transition(UiPhase::Destroying);
        assert_eq!(state.request_show(false), ShowAction::Wait);
        assert!(state.focus_requested);
        assert!(state.owns_destruction(destroying));
        state.backend_instance += 1; // boot completed while the window was being disposed
        assert!(state.owns_destruction(destroying));
        assert!(!state.matches(destroying)); // never relax the page IPC identity
        state.transition(UiPhase::Minimal);
        assert_eq!(state.request_show(true), ShowAction::Restore);
        let operation = state.operation_id;
        assert_eq!(state.request_show(true), ShowAction::Focus);
        assert_eq!(state.operation_id, operation);
        state.transition(UiPhase::RestoreFailed);
        assert_eq!(state.request_show(false), ShowAction::Restore);
        assert!(state.operation_id > operation);
    }
    #[test]
    fn exit_is_absorbing_and_old_window_events_cannot_own_new_disposal() {
        let mut state = UiState::default();
        assert_eq!(state.request_show(true), ShowAction::Restore);
        let previous = state.transition(UiPhase::Destroying);
        state.window_generation += 1;
        assert!(!state.owns_destruction(previous));
        state.transition(UiPhase::Exiting);
        assert_eq!(state.request_show(true), ShowAction::Wait);
        state.transition(UiPhase::Active);
        assert_eq!(state.phase, UiPhase::Exiting);
        assert!(!state.matches(state.identity()));
    }
    #[test]
    fn origin_matches_the_running_port_not_any_loopback_server() {
        let phase = crate::state::Phase::Running {
            url: "http://127.0.0.1:1234/?token=secret".into(),
            version: None,
        };
        assert!(allowed_origin_with(
            false,
            &"http://127.0.0.1:1234/session".parse().unwrap(),
            &phase
        ));
        for bad in [
            "http://127.0.0.1:1235/",
            "https://127.0.0.1:1234/",
            "http://localhost:1234/",
            "https://example.com/",
        ] {
            assert!(!allowed_origin_with(false, &bad.parse().unwrap(), &phase));
        }
    }

    /// The regression this file exists to prevent, stated as the rule it broke.
    ///
    /// `tauri dev` loads the window from the CLI's built-in server. The boot page
    /// therefore arrives from a loopback HTTP origin, and while that origin was
    /// not recognised as the app's own, the ACL gate refused every command it
    /// made: the phase never left "正在检查运行环境…", the card kept the static
    /// markup with no spinner, and the window looked hung.
    #[test]
    fn the_development_server_is_the_apps_own_document() {
        let url = |text: &str| text.parse::<tauri::Url>().unwrap();
        let dev = url("http://127.0.0.1:1430/");

        // The boot page as `tauri dev` serves it, and any path inside it.
        assert!(is_app_origin(Some(&dev), &url("http://127.0.0.1:1430/")));
        assert!(is_app_origin(
            Some(&dev),
            &url("http://127.0.0.1:1430/index.html")
        ));
        // The packaged protocol still counts, with or without a dev URL.
        assert!(is_app_origin(Some(&dev), &url("http://tauri.localhost/")));
        assert!(is_app_origin(None, &url("tauri://localhost/")));

        // A different origin is a different document. The DSH server the window
        // navigates to lives on loopback too, and it must never inherit the
        // onboarding's install permissions.
        for other in [
            "http://127.0.0.1:1431/",
            "http://127.0.0.1:3080/",
            "http://localhost:1430/",
            "https://127.0.0.1:1430/",
            "http://127.0.0.1.evil.example:1430/",
        ] {
            assert!(
                !is_app_origin(Some(&dev), &url(other)),
                "{other} is not this app's own document"
            );
        }
        // A packaged build has no dev URL at all, so loopback is never ours.
        assert!(!is_app_origin(None, &url("http://127.0.0.1:1430/")));
    }

    /// The boot page is the case that has to pass *during* startup, when no
    /// backend is running yet and the other origin rule is still closed - and the
    /// DSH server's own origin is the case that must not borrow its access.
    #[test]
    fn the_boot_page_is_allowed_before_a_backend_exists() {
        let url = |text: &str| text.parse::<tauri::Url>().unwrap();
        let dev = url("http://127.0.0.1:1430/");

        // Our own page, before any backend exists.
        let boot = url("http://127.0.0.1:1430/");
        assert!(allowed_origin_with(
            is_app_origin(Some(&dev), &boot),
            &boot,
            &crate::state::Phase::Probing
        ));

        // The DSH server on another loopback port is a different document, so it
        // does not inherit the `[local]` onboarding grants...
        let backend = url("http://127.0.0.1:3080/");
        assert!(!is_app_origin(Some(&dev), &backend));
        // ...and while it is not the running backend, no origin rule admits it.
        assert!(!allowed_origin_with(
            false,
            &backend,
            &crate::state::Phase::Probing
        ));

        // Once it is the running backend, its own origin rule admits exactly it.
        let running = crate::state::Phase::Running {
            url: "http://127.0.0.1:3080/?token=secret".into(),
            version: None,
        };
        assert!(allowed_origin_with(
            false,
            &url("http://127.0.0.1:3080/anything"),
            &running
        ));
        assert!(!allowed_origin_with(
            false,
            &url("http://127.0.0.1:3081/"),
            &running
        ));
    }
    #[test]
    fn stale_responses_do_not_match_new_operation_document_or_backend() {
        let mut state = UiState::default();
        let old = state.transition(UiPhase::Capturing);
        assert!(state.matches(old));
        state.transition(UiPhase::Active);
        assert!(!state.matches(old));
        let old = state.identity();
        state.document_generation += 1;
        assert!(!state.matches(old));
        let old = state.identity();
        state.backend_instance += 1;
        assert!(!state.matches(old));
        let old = state.identity();
        state.transition(UiPhase::Exiting);
        assert!(!state.matches(old));
    }
    #[test]
    fn unsupported_incomplete_and_oversized_snapshots_are_rejected() {
        let mut payload = UiPayload::boot();
        assert!(payload.validate().is_ok());
        payload.capabilities.pop();
        assert!(payload.validate().is_err());
        payload = UiPayload::boot();
        payload.blocked.push("form".into());
        assert!(payload.validate().is_err());
        payload = UiPayload::boot();
        payload.schema_version += 1;
        assert!(payload.validate().is_err());
        payload = UiPayload::boot();
        payload.page.route = "/?token=private".into();
        assert!(payload.validate().is_err());
    }
    #[test]
    fn terminal_provider_is_supported_without_accepting_unknown_snapshot_providers() {
        let mut payload = UiPayload::boot();
        payload.page.kind = "dsh".into();
        payload.dialogs.push(Dialog { id: "desktop-terminal".into(), version: 1, data: serde_json::json!({"sessions":[],"dock":{},"sidebar":[]}) });
        assert!(payload.validate().is_ok());
        payload.dialogs[0].id = "unknown-provider".into();
        assert_eq!(payload.validate().unwrap_err(), "snapshot-dialog-unsupported");
    }
    #[test]
    fn changes_provider_is_supported_only_at_its_known_schema_version() {
        let mut payload = UiPayload::boot();
        payload.page.kind = "dsh".into();
        payload.dialogs.push(Dialog {
            id: "desktop-changes".into(),
            version: 1,
            data: serde_json::json!({"sides": []}),
        });
        assert!(payload.validate().is_ok());
        payload.dialogs[0].version = 2;
        assert_eq!(payload.validate().unwrap_err(), "snapshot-dialog-unsupported");
    }
    #[test]
    fn file_editor_drafts_require_the_supported_provider_version() {
        let mut payload = UiPayload::boot();
        payload.page.kind = "dsh".into();
        payload.dialogs.push(Dialog {
            id: "desktop-file-editor".into(),
            version: 1,
            data: serde_json::json!({"drafts": [], "sides": []}),
        });
        assert!(payload.validate().is_ok());
        payload.dialogs[0].version = 2;
        assert_eq!(payload.validate().unwrap_err(), "snapshot-dialog-unsupported");
    }
    #[test]
    fn staged_attachments_survive_repeated_reads_and_are_removed_on_commit() {
        let mut payload = UiPayload::boot();
        payload.page.kind = "dsh".into();
        payload.assets.push(Asset {
            key: "a".into(),
            name: "../../never-a-path".into(),
            media_type: "text/plain".into(),
            last_modified: 1,
            size: 5,
            data: STANDARD.encode(b"hello"),
        });
        let snapshot = UiSnapshot::capture(payload, UiState::default().identity()).unwrap();
        let dir = snapshot.files.as_ref().unwrap().dir.clone();
        assert_eq!(
            snapshot.wire().unwrap().payload.assets[0].data,
            STANDARD.encode(b"hello")
        );
        assert_eq!(
            snapshot.wire().unwrap().payload.assets[0].data,
            STANDARD.encode(b"hello")
        );
        std::fs::write(dir.join("0"), b"bad").unwrap();
        assert!(snapshot.wire().is_err());
        drop(snapshot);
        assert!(!dir.exists());
    }
}
