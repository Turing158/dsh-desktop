//! Durable, bounded UI recovery packages. Old page/backend identities never
//! enter this format; attaching a package requires a new host-issued identity.
use std::{io::{self, Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::ui_snapshot::{UiPayload, UiSnapshot, MAX_SNAPSHOT_BYTES};
use tauri::{AppHandle, Manager, WebviewWindow};

const SCHEMA: u32 = 1;
const MAX_BYTES: usize = MAX_SNAPSHOT_BYTES + 8192;
const MAX_PACKAGES: usize = 64;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub data_root_fingerprint: String,
    pub profile: String,
    pub runtime_version: String,
}
impl Binding {
    pub fn new(data_root: &Path, profile: &str, runtime_version: &str) -> Self {
        // A local binding, not an exported path or a portable filesystem target.
        Self { data_root_fingerprint: format!("{:x}", Sha256::digest(data_root.as_os_str().to_string_lossy().as_bytes())), profile: profile.into(), runtime_version: runtime_version.into() }
    }
    fn valid(&self) -> bool {
        self.data_root_fingerprint.len() == 64 && self.data_root_fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
            && self.profile == "web" && semver::Version::parse(&self.runtime_version).is_ok()
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub schema: u32,
    pub recovery_id: uuid::Uuid,
    pub created_at: u64,
    pub binding: Binding,
    pub payload_hash: String,
    pub payload: UiPayload,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub drafts_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_frontend_version: Option<String>,
}
#[derive(Clone)]
pub struct Handle { pub id: uuid::Uuid, pub binding: Binding }
struct BackgroundSlot {handle:Handle,document:crate::remote_control::Identity}
#[derive(Default)]
struct BackgroundState {slot:Option<BackgroundSlot>,last_saved:Option<(crate::remote_control::Identity,u64)>}
#[derive(Default)]
pub struct BackgroundCheckpoints(Mutex<BackgroundState>);
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct CheckpointResult {pub recovery_id:Option<uuid::Uuid>,pub saved_at:u64}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub recovery_id: uuid::Uuid,
    pub created_at: u64,
    pub runtime_version: String,
    pub draft_count: usize,
    pub provider_count: usize,
    pub drafts_only: bool,
    pub can_restore: bool,
    pub has_terminal_state: bool,
    pub reason_code: Option<&'static str>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing { pub entries: Vec<Entry>, pub unreadable: usize }
fn has_terminal_state(payload:&UiPayload)->bool {payload.dialogs.iter().any(|dialog|dialog.id=="desktop-terminal")}
fn cold_payload(mut payload:UiPayload,skip_terminal_state:bool)->Result<(UiPayload,bool),String> {
    let has_terminal=has_terminal_state(&payload);
    if has_terminal && !skip_terminal_state {return Err("snapshot-terminal-cold-unavailable".into())}
    if has_terminal {
        payload.dialogs.retain(|dialog|dialog.id!="desktop-terminal");
        // The omitted tabs cannot own the restored right-side panel.
        payload.layout.rightbar=None;payload.layout.panel=None;
    }
    Ok((payload,has_terminal))
}
pub struct RecoveryStore { root: PathBuf }
impl RecoveryStore {
    pub fn new(root: PathBuf) -> Self { Self { root } }
    pub fn persist(&self, snapshot: &UiSnapshot, binding: Binding) -> io::Result<uuid::Uuid> {
        if !binding.valid() { return Err(invalid("recovery-binding")); }
        let payload = snapshot.wire().map_err(|_| invalid("recovery-assets"))?.payload;
        payload.validate().map_err(|_| invalid("recovery-payload"))?;
        let payload_hash = hash(&payload)?;
        let package = Package { schema: SCHEMA, recovery_id: uuid::Uuid::new_v4(), created_at: crate::maintenance::now_ms(), binding, payload_hash, payload, drafts_only:false, restore_frontend_version: None };
        let bytes = serde_json::to_vec(&package)?;
        if bytes.len() > MAX_BYTES { return Err(invalid("recovery-size")); }
        std::fs::create_dir_all(&self.root)?;
        // Unresolved packages are never evicted to make room. Include malformed
        // JSON files in the budget so corrupt materials remain bounded too.
        self.ensure_capacity(bytes.len() as u64, MAX_PACKAGES, MAX_TOTAL_BYTES)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(self.path(package.recovery_id)).map_err(|e| e.error)?;
        Ok(package.recovery_id)
    }
    fn persist_drafts(&self,payload:UiPayload,binding:Binding,previous:Option<&Handle>)->io::Result<uuid::Uuid> {
        validate_drafts(&payload).map_err(invalid)?;
        if !binding.valid() || payload.frontend_version!=binding.runtime_version {return Err(invalid("recovery-binding"))}
        let previous=previous.filter(|handle|self.path(handle.id).exists());
        if let Some(handle)=previous {
            let package=self.load(handle.id,&binding)?;
            if !package.drafts_only || handle.binding!=binding {return Err(invalid("recovery-checkpoint-conflict"))}
        }
        let id=previous.map(|handle|handle.id).unwrap_or_else(uuid::Uuid::new_v4);
        let package=Package {schema:SCHEMA,recovery_id:id,created_at:crate::maintenance::now_ms(),payload_hash:hash(&payload)?,payload,binding,drafts_only:true,restore_frontend_version:None};
        let bytes=serde_json::to_vec(&package)?;
        if bytes.len()>MAX_BYTES {return Err(invalid("recovery-size"))}
        std::fs::create_dir_all(&self.root)?;
        if previous.is_some() {
            let old=std::fs::metadata(self.path(id))?.len();
            self.ensure_capacity((bytes.len() as u64).saturating_sub(old),MAX_PACKAGES+1,MAX_TOTAL_BYTES)?;
            crate::maintenance::atomic_json(&self.path(id),&package)?;
        } else {
            self.ensure_capacity(bytes.len() as u64,MAX_PACKAGES,MAX_TOTAL_BYTES)?;
            let mut file=tempfile::NamedTempFile::new_in(&self.root)?;
            file.write_all(&bytes)?;file.as_file().sync_all()?;
            file.persist_noclobber(self.path(id)).map_err(|e|e.error)?;
        }
        Ok(id)
    }
    pub fn load(&self, id: uuid::Uuid, expected: &Binding) -> io::Result<Package> {
        let package = self.read(id)?;
        if &package.binding != expected { return Err(invalid("recovery-binding")); }
        Ok(package)
    }
    fn read(&self, id: uuid::Uuid) -> io::Result<Package> {
        let path = self.path(id);
        let info = std::fs::symlink_metadata(&path)?;
        if !info.is_file() || info.file_type().is_symlink() || info.len() > MAX_BYTES as u64 { return Err(invalid("recovery-size")); }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_BYTES { return Err(invalid("recovery-size")); }
        let package: Package = serde_json::from_slice(&bytes)?;
        if package.schema != SCHEMA || package.recovery_id != id || !package.binding.valid()
            || package.restore_frontend_version.as_ref().is_some_and(|v| semver::Version::parse(v).is_err()) { return Err(invalid("recovery-binding")); }
        package.payload.validate().map_err(|_| invalid("recovery-payload"))?;
        if package.drafts_only {validate_drafts(&package.payload).map_err(invalid)?;}
        if package.payload_hash != hash(&package.payload)? { return Err(invalid("recovery-integrity")); }
        Ok(package)
    }
    pub fn list(&self, expected: Option<&Binding>) -> io::Result<Listing> {
        let mut result = Listing::default();
        let entries = match std::fs::read_dir(&self.root) { Ok(entries) => entries, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(result), Err(e) => return Err(e) };
        for entry in entries {
            let Ok(entry) = entry else { result.unreadable += 1; continue };
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
            let Some(id) = path.file_stem().and_then(|v| v.to_str()).and_then(|v| uuid::Uuid::parse_str(v).ok()) else { result.unreadable += 1; continue };
            match self.read(id) {
                Ok(package) => {
                    let reason = match expected {
                        None => Some("recovery-backend-unavailable"),
                        Some(binding) => compatible(&package, binding).err(),
                    };
                    result.entries.push(Entry { recovery_id: id, created_at: package.created_at, runtime_version: package.binding.runtime_version,
                        draft_count: package.payload.drafts.iter().filter(|d| !d.text.is_empty() || !d.attachment_keys.is_empty()).count(),
                        provider_count: package.payload.dialogs.len(), drafts_only:package.drafts_only, has_terminal_state:has_terminal_state(&package.payload), can_restore: reason.is_none(), reason_code: reason });
                }
                Err(_) => result.unreadable += 1,
            }
        }
        result.entries.sort_by_key(|e| std::cmp::Reverse(e.created_at));
        Ok(result)
    }
    // Cross-version recovery remains unavailable until the update contract is
    // verified; retain the tested adapter for that later transaction.
    #[allow(dead_code)]
    pub fn permit_version(&self, handle: &Handle, version: &str) -> io::Result<()> {
        if semver::Version::parse(version).is_err() { return Err(invalid("recovery-version")); }
        let mut package = self.load(handle.id, &handle.binding)?;
        package.restore_frontend_version = Some(version.into());
        crate::maintenance::atomic_json(&self.path(handle.id), &package)
    }
    // The caller must first receive the necessary restore acknowledgement with
    // its new identity. Failed or incomplete restores retain the sole package.
    pub fn acknowledge(&self, id: uuid::Uuid, binding: &Binding) -> io::Result<()> {
        self.load(id, binding)?;
        std::fs::remove_file(self.path(id))
    }
    fn path(&self, id: uuid::Uuid) -> PathBuf { self.root.join(format!("{id}.json")) }
    fn ensure_capacity(&self, incoming: u64, max_packages: usize, max_total: u64) -> io::Result<()> {
        let mut count = 0;
        let mut total = incoming;
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            count += 1;
            let info = std::fs::symlink_metadata(entry.path())?;
            if !info.is_file() || info.file_type().is_symlink() { return Err(invalid("recovery-capacity-unverified")); }
            total = total.checked_add(info.len()).ok_or_else(|| invalid("recovery-capacity"))?;
            if count >= max_packages || total > max_total { return Err(invalid("recovery-capacity")); }
        }
        if total > max_total { return Err(invalid("recovery-capacity")); }
        Ok(())
    }
}
fn hash(payload: &UiPayload) -> io::Result<String> { Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(payload)?))) }
fn invalid(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, code) }
fn validate_drafts(payload:&UiPayload)->Result<(),&'static str> {
    payload.validate().map_err(|_|"recovery-payload")?;
    if payload.page.kind!="dsh" || !payload.dialogs.is_empty() || !payload.scrolls.is_empty() || !payload.assets.iter().all(|asset|payload.drafts.iter().any(|draft|draft.attachment_keys.contains(&asset.key)))
        || payload.page.session_id.is_some() || payload.page.workspace_id.is_some()
        || payload.layout.sidebar!=0.0 || payload.layout.narrow_expanded || payload.layout.rightbar.is_some() || payload.layout.panel.is_some()
        || payload.drafts.iter().any(|draft|!draft.editor.is_null() || draft.selection.is_some()) {return Err("recovery-checkpoint-scope")}
    Ok(())
}

fn compatible(package: &Package, current: &Binding) -> Result<(), &'static str> {
    if package.binding.data_root_fingerprint != current.data_root_fingerprint || package.binding.profile != current.profile { return Err("recovery-binding"); }
    if package.binding.runtime_version != current.runtime_version && package.restore_frontend_version.as_ref() != Some(&current.runtime_version) { return Err("recovery-version"); }
    Ok(())
}
pub fn store(app: &AppHandle) -> Result<RecoveryStore, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR") { return Ok(RecoveryStore::new(PathBuf::from(root).join("maintenance/recovery"))); }
    Ok(RecoveryStore::new(app.path().app_data_dir().map_err(|_| "recovery-directory")?.join("maintenance/recovery")))
}
fn binding(state: &crate::state::AppState) -> Result<Binding, String> {
    let observed = state.storage.as_ref().filter(|s| s.backend_instance == state.ui.backend_instance).ok_or("recovery-storage-unavailable")?;
    let version = state.runtime.as_ref().and_then(|r| r.version.as_deref()).ok_or("recovery-version")?;
    let root = &observed.roots.profile_home;
    let profile = &observed.roots.profile_directory;
    let mut result = Binding::new(root, "web", version);
    let normalize = |path: &Path| path.to_string_lossy().replace('/', "\\").trim_start_matches("\\\\?\\").to_lowercase();
    let normalized = format!("{}\0{}", normalize(root), normalize(profile));
    result.data_root_fingerprint = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    Ok(result)
}
pub fn persist(app: &AppHandle, snapshot: &UiSnapshot) -> Result<Handle, String> {
    let binding = { let shared = app.state::<crate::state::Shared>(); let state = shared.lock().map_err(|_| "recovery-state")?; binding(&state)? };
    if snapshot.payload.frontend_version != binding.runtime_version { return Err("recovery-version".into()); }
    let id = store(app)?.persist(snapshot, binding.clone()).map_err(|_| "recovery-save-failed")?;
    Ok(Handle { id, binding })
}
#[tauri::command]
pub async fn desktop_draft_checkpoint(window:WebviewWindow,identity:crate::remote_control::Identity,payload:UiPayload)->Result<CheckpointResult,String> {
    crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
    validate_drafts(&payload).map_err(String::from)?;
    let app=window.app_handle().clone();
    let lease=app.state::<crate::maintenance::MaintenanceCoordinator>().begin(crate::maintenance::Kind::Backup)?;
    let shared=app.state::<crate::state::Shared>().inner().clone();
    let (current,guard)={let mut state=shared.lock().map_err(|_|"recovery-state")?;
        if state.remote.applying || state.boot_in_progress || state.ui.busy() || state.ui.snapshot.is_some() {return Err("maintenance-busy".into())}
        let binding=binding(&state)?;state.remote.applying=true;
        (binding,crate::remote_control::ApplyingGuard(shared.clone()))};
    if payload.frontend_version!=current.runtime_version {return Err("recovery-version".into())}
    tauri::async_runtime::spawn_blocking(move|| {
        let _lease=lease;let _guard=guard;
        let manager=app.state::<BackgroundCheckpoints>();let mut state=manager.0.lock().map_err(|_|"recovery-state")?;
        let now=crate::maintenance::now_ms();
        let same=state.slot.as_ref().filter(|s|s.document==identity && s.handle.binding==current);
        if state.last_saved.is_some_and(|(document,at)|document==identity && now.saturating_sub(at)<30_000) {return Err("recovery-checkpoint-throttled".into())}
        crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
        {let state=shared.lock().map_err(|_|"recovery-state")?;
            if crate::remote_control::identity(&state)!=identity {return Err("recovery-stale-document".into())}}
        let store=store(&app)?;
        let has_content=payload.drafts.iter().any(|draft|!draft.text.is_empty() || draft.semantic.is_some() || !draft.attachment_keys.is_empty());
        let id=if has_content {
            Some(store.persist_drafts(payload,current.clone(),same.map(|s|&s.handle)).map_err(|_|"recovery-save-failed")?)
        } else {
            if let Some(previous)=same {if store.path(previous.handle.id).exists() {
                let package=store.load(previous.handle.id,&current).map_err(|_|"recovery-save-failed")?;
                if !package.drafts_only {return Err("recovery-checkpoint-conflict".into())}
                store.acknowledge(previous.handle.id,&current).map_err(|_|"recovery-save-failed")?;
            }}
            None
        };
        state.slot=id.map(|id|BackgroundSlot {handle:Handle {id,binding:current},document:identity});
        state.last_saved=Some((identity,now));
        Ok(CheckpointResult {recovery_id:id,saved_at:now})
    }).await.map_err(|_|"recovery-worker")?
}
#[tauri::command]
pub async fn desktop_recovery_list(window: WebviewWindow, identity: Option<crate::remote_control::Identity>) -> Result<Listing, String> {
    let url = window.url().map_err(|_| "recovery-origin")?;
    if !matches!(window.label(), "main" | "diagnostics") { return Err("recovery-origin".into()); }
    if !crate::ui_snapshot::is_app_document(window.app_handle(), &url) {
        crate::remote_control::caller(&window, identity.ok_or("recovery-identity")?).map_err(|e| e.message)?;
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = { let shared = app.state::<crate::state::Shared>(); let state = shared.lock().map_err(|_| "recovery-state")?;
            if matches!(state.phase, crate::state::Phase::Running { .. }) { binding(&state).ok() } else { None } };
        store(&app)?.list(current.as_ref()).map_err(|_| "recovery-read-failed".into())
    }).await.map_err(|_| "recovery-worker")?
}
#[tauri::command]
pub async fn desktop_recovery_restore(window: WebviewWindow, identity: crate::remote_control::Identity, recovery_id: uuid::Uuid, skip_terminal_state:Option<bool>) -> Result<(), String> {
    crate::remote_control::caller(&window, identity).map_err(|e| e.message)?;
    let app = window.app_handle().clone();
    let lease = app.state::<crate::maintenance::MaintenanceCoordinator>().begin(crate::maintenance::Kind::Restore)?;
    let shared = app.state::<crate::state::Shared>().inner().clone();
    let _guard = { let mut state = shared.lock().map_err(|_| "recovery-state")?;
        if state.remote.applying || state.boot_in_progress || state.ui.busy() || state.ui.snapshot.is_some() { return Err("maintenance-busy".into()); }
        state.remote.applying = true; crate::remote_control::ApplyingGuard(shared.clone()) };
    let (current, source) = { let state = shared.lock().map_err(|_| "recovery-state")?; (binding(&state)?, state.ui.identity()) };
    let work_app = app.clone();
    let (mut snapshot, handle, lease) = tauri::async_runtime::spawn_blocking(move || {
        let package = store(&work_app)?.read(recovery_id).map_err(|_| "recovery-read-failed")?;
        compatible(&package, &current).map_err(String::from)?;
        let (payload,retained_terminal_state)=cold_payload(package.payload,skip_terminal_state.unwrap_or(false))?;
        let handle = Handle { id: recovery_id, binding: package.binding };
        let lease = lease.durable(&work_app)?;
        let progress = lease.progress();
        progress.checkpoint(recovery_id, &handle.binding.runtime_version)?;
        progress.update(crate::maintenance::Stage::Restoring, "cold-recovery-verified")?;
        let mut snapshot = UiSnapshot::capture(payload, source)?;
        snapshot.restore_frontend_version = package.restore_frontend_version;
        snapshot.cold_recovery = true;
        snapshot.retained_terminal_state = retained_terminal_state;
        snapshot.drafts_only = package.drafts_only;
        Ok::<_, String>((snapshot, handle, lease))
    }).await.map_err(|_| "recovery-worker")??;
    crate::remote_control::caller(&window, identity).map_err(|e| e.message)?;
    { let mut state = shared.lock().map_err(|_| "recovery-state")?;
        if crate::remote_control::identity(&state) != identity || state.ui.busy() || state.ui.snapshot.is_some() { return Err("maintenance-busy".into()); }
        let issued = state.ui.transition(crate::ui_snapshot::UiPhase::Restoring);
        snapshot.source = issued; snapshot.snapshot_id = issued.operation_id;
        state.ui.recovery = Some(handle); state.ui.snapshot = Some(std::sync::Arc::new(snapshot));
        state.ui.recovery_lease = Some(lease);
        state.remote.restore_instance = Some(issued.backend_instance);
    }
    crate::ui_snapshot::refresh_bridge(&window);
    let operation = shared.lock().map_err(|_| "recovery-state")?.ui.operation_id;
    crate::minimal::watch_recovery(&app, operation);
    Ok(())
}
#[tauri::command]
pub async fn desktop_recovery_defer(window: WebviewWindow, identity: crate::remote_control::Identity) -> Result<(), String> {
    crate::remote_control::caller(&window, identity).map_err(|e| e.message)?;
    let app = window.app_handle();
    let (snapshot, lease) = { let shared = app.state::<crate::state::Shared>(); let mut state = shared.lock().map_err(|_| "recovery-state")?;
        if state.ui.phase != crate::ui_snapshot::UiPhase::RestoreFailed || !state.ui.snapshot.as_ref().is_some_and(|s| s.cold_recovery) { return Err("maintenance-busy".into()); }
        state.ui.transition(crate::ui_snapshot::UiPhase::Active); state.ui.last_error = None;
        state.ui.recovery = None; state.remote.restore_instance = None;
        (state.ui.snapshot.take(), state.ui.recovery_lease.take()) };
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(lease) = &lease { let _ = lease.progress().failed("recovery-deferred"); }
        drop(snapshot); drop(lease);
        crate::diagnostics::record(&worker_app, "recovery", "deferred");
    }).await.map_err(|_| "recovery-worker")?;
    crate::ui_snapshot::refresh_bridge(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_terminal_state_requires_explicit_skip_and_keeps_the_original_package() {
        let dir=tempfile::tempdir().unwrap();let store=RecoveryStore::new(dir.path().join("recovery"));
        let binding=Binding::new(dir.path(),"web","0.2.1-rc.2");
        let mut payload=draft_payload("saved draft");
        payload.layout.rightbar=Some(320.0);payload.layout.panel=Some("terminal".into());
        payload.dialogs.push(crate::ui_snapshot::Dialog {id:"desktop-terminal".into(),version:1,data:serde_json::json!({"sessions":[{"terminalId":"old"}],"dock":{},"sidebar":[]})});
        payload.dialogs.push(crate::ui_snapshot::Dialog {id:"desktop-file-editor".into(),version:1,data:serde_json::json!({"drafts":[]})});
        let snapshot=UiSnapshot::capture(payload.clone(),crate::ui_snapshot::Identity {operation_id:1,window_generation:1,document_generation:1,backend_instance:1}).unwrap();
        let id=store.persist(&snapshot,binding.clone()).unwrap();let original=std::fs::read(store.path(id)).unwrap();
        assert!(store.list(Some(&binding)).unwrap().entries[0].has_terminal_state);
        assert_eq!(cold_payload(payload.clone(),false).unwrap_err(),"snapshot-terminal-cold-unavailable");
        let (partial,retained)=cold_payload(payload,true).unwrap();assert!(retained);
        assert_eq!(partial.drafts[0].text,"saved draft");assert_eq!(partial.dialogs.len(),1);
        assert_eq!(partial.dialogs[0].id,"desktop-file-editor");assert_eq!(partial.layout.panel,None);assert_eq!(partial.layout.rightbar,None);
        assert_eq!(std::fs::read(store.path(id)).unwrap(),original);
        assert!(store.read(id).unwrap().payload.dialogs.iter().any(|dialog|dialog.id=="desktop-terminal"));
        assert!(!cold_payload(draft_payload("only draft"),true).unwrap().1);
    }
    fn draft_payload(text:&str)->UiPayload {
        let mut payload=UiPayload::boot();payload.page.kind="dsh".into();payload.frontend_version="0.2.1-rc.2".into();
        payload.drafts.push(crate::ui_snapshot::Draft {session_id:"session-test".into(),text:text.into(),semantic:None,editor:serde_json::Value::Null,selection:None,attachment_keys:vec![],revision:1,session_updated_at:Some(1),view:None});
        payload
    }
    #[test]
    fn draft_checkpoints_replace_only_the_current_page_package_and_preserve_other_recovery_materials() {
        let root=tempfile::tempdir().unwrap();let store=RecoveryStore::new(root.path().join("recovery"));let binding=Binding::new(root.path(),"web","0.2.1-rc.2");
        let first=store.persist_drafts(draft_payload("first"),binding.clone(),None).unwrap();let handle=Handle {id:first,binding:binding.clone()};
        let maintenance=UiSnapshot::capture(draft_payload("maintenance"),crate::ui_snapshot::Identity {operation_id:1,window_generation:1,document_generation:1,backend_instance:1}).unwrap();
        let other=store.persist(&maintenance,binding.clone()).unwrap();
        assert_eq!(store.persist_drafts(draft_payload("second"),binding.clone(),Some(&handle)).unwrap(),first);
        assert_eq!(store.read(first).unwrap().payload.drafts[0].text,"second");assert!(store.read(first).unwrap().drafts_only);
        assert_eq!(store.read(other).unwrap().payload.drafts[0].text,"maintenance");assert!(!store.read(other).unwrap().drafts_only);
        let incompatible=Handle {id:other,binding:binding.clone()};
        assert!(store.persist_drafts(draft_payload("bad"),binding.clone(),Some(&incompatible)).is_err());
        let new_page=store.persist_drafts(draft_payload("new page"),binding.clone(),None).unwrap();assert_ne!(new_page,first);
        store.acknowledge(new_page,&binding).unwrap();assert!(store.path(first).exists());assert!(store.path(other).exists());
        let mut layout=draft_payload("invalid");layout.layout.sidebar=300.0;
        assert!(store.persist_drafts(layout,binding.clone(),Some(&handle)).is_err());assert_eq!(store.read(first).unwrap().payload.drafts[0].text,"second");
        let listing=serde_json::to_string(&store.list(Some(&binding)).unwrap()).unwrap();assert!(listing.contains("draftsOnly"));assert!(!listing.contains("maintenance"));
    }
    #[test]
    fn capacity_exhaustion_retains_every_unresolved_package() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().into());
        std::fs::write(dir.path().join("broken.json"), "broken").unwrap();
        assert!(store.ensure_capacity(4, 1, 100).is_err());
        assert!(store.ensure_capacity(4, 2, 9).is_err());
        assert!(store.ensure_capacity(4, 2, 10).is_ok());
        assert_eq!(std::fs::read_to_string(dir.path().join("broken.json")).unwrap(), "broken");
    }
    #[test]
    fn listing_redacts_payload_and_versions_require_explicit_permission() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().join("recovery"));
        let binding = Binding::new(dir.path(), "web", "0.2.1-rc.2");
        let snapshot = UiSnapshot::capture(UiPayload::boot(), crate::ui_snapshot::Identity { operation_id: 1, window_generation: 1, document_generation: 1, backend_instance: 1 }).unwrap();
        let id = store.persist(&snapshot, binding.clone()).unwrap();
        let mut target = binding.clone(); target.runtime_version = "0.2.2".into();
        let listing = store.list(Some(&target)).unwrap();
        assert!(!listing.entries[0].can_restore);
        assert_eq!(listing.entries[0].reason_code, Some("recovery-version"));
        let metadata = serde_json::to_string(&listing).unwrap();
        assert!(!metadata.contains("dataRootFingerprint"));
        assert!(!metadata.contains("payload"));
        store.permit_version(&Handle { id, binding: binding.clone() }, "0.2.2").unwrap();
        assert!(store.list(Some(&target)).unwrap().entries[0].can_restore);
        target.data_root_fingerprint = "0".repeat(64);
        assert!(!store.list(Some(&target)).unwrap().entries[0].can_restore);
        std::fs::write(store.root.join("bad.json"), "bad").unwrap();
        assert_eq!(store.list(None).unwrap().unreadable, 1);
        assert!(store.path(id).is_file());
    }
    #[test]
    fn packages_survive_owner_drop_but_refuse_another_root_and_modified_text() {
        let dir = tempfile::tempdir().unwrap();
        let binding = Binding::new(dir.path(), "web", "0.2.1-rc.2");
        let mut payload = UiPayload::boot();
        payload.page.kind = "dsh".into();
        payload.drafts.push(crate::ui_snapshot::Draft { session_id: "test-session".into(), text: "未保存的中文草稿".into(), semantic: None, editor: serde_json::json!({}), selection: None, attachment_keys: vec![], revision: 2, session_updated_at: Some(12), view: None });
        let snapshot = UiSnapshot::capture(payload, crate::ui_snapshot::Identity { operation_id: 1, window_generation: 2, document_generation: 3, backend_instance: 4 }).unwrap();
        let store = RecoveryStore::new(dir.path().join("recovery"));
        let id = store.persist(&snapshot, binding.clone()).unwrap();
        drop(snapshot); drop(store);
        let store = RecoveryStore::new(dir.path().join("recovery"));
        assert_eq!(store.load(id, &binding).unwrap().payload.drafts[0].text, "未保存的中文草稿");
        let wrong = Binding::new(&dir.path().join("other-home"), "web", "0.2.1-rc.2");
        assert!(store.load(id, &wrong).is_err());
        let text = std::fs::read_to_string(store.path(id)).unwrap();
        assert!(!text.contains("backendInstance"));
        std::fs::write(store.path(id), text.replace("未保存的中文草稿", "修改后的中文草稿")).unwrap();
        assert!(store.load(id, &binding).is_err());
        assert!(store.acknowledge(id, &binding).is_err());
        assert!(store.path(id).is_file());
    }
    #[test]
    fn a_valid_acknowledgement_removes_only_the_named_package() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().join("recovery"));
        let binding = Binding::new(dir.path(), "web", "0.2.1-rc.2");
        let snapshot = UiSnapshot::capture(UiPayload::boot(), crate::ui_snapshot::Identity { operation_id: 1, window_generation: 1, document_generation: 1, backend_instance: 1 }).unwrap();
        let first = store.persist(&snapshot, binding.clone()).unwrap();
        let retained = store.persist(&snapshot, binding.clone()).unwrap();
        store.acknowledge(first, &binding).unwrap();
        assert!(store.load(retained, &binding).is_ok());
        assert!(store.load(first, &binding).is_err());
    }
}
