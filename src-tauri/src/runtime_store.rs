//! Immutable dependency trees and atomic startup selection. Data migration and
//! automatic version rollback remain separate, unavailable operations.
use std::{collections::HashSet, fs::{self, File}, io::{self, Read, Write}, path::{Path, PathBuf}, process::Command, time::Duration};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use crate::dsh::{DshSource, Runtime};

const MAX_INVENTORY: u64 = 48 * 1024 * 1024;
const MAX_FILES: usize = 200_000;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ManagedRuntime {
    pub id: String,
    pub fingerprint: String,
    pub committed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32, id: String, version: String, architecture: String,
    node_hash: String,
    entry: String, fingerprint: String, inventory_hash: String,
    file_count: usize, total_bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Selection {
    schema: u32, active: String, previous: Option<String>,
    fingerprint: String, verified_at: u64, backend_ready: bool, ui_ready: bool,
}
#[derive(Serialize, Deserialize)]
struct Inventory { schema: u32, fingerprint: String, files: Vec<InventoryFile>, #[serde(rename="totalBytes")] total_bytes: u64 }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryFile { path: String, size: u64, sha256: String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Prepared { version: String, entry: String, fingerprint: String, file_count: usize, total_bytes: u64 }

fn invalid(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, code) }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn is_digest(value: &str) -> bool {value.len()==64 && value.bytes().all(|b| b.is_ascii_hexdigit())}
fn file_hash(path: &Path) -> io::Result<String> {
    plain(path,false)?;
    let mut file=File::open(path)?; let mut hash=Sha256::new(); let mut buffer=[0u8;64*1024];
    loop {let n=file.read(&mut buffer)?;if n==0 {break;}hash.update(&buffer[..n]);}
    Ok(format!("{:x}",hash.finalize()))
}
fn id_valid(value: &str) -> bool { !value.is_empty() && value.len()<=180 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b)) && value!="." && value!=".." }
fn relative_valid(value: &str) -> bool {
    !value.is_empty() && value.len()<2048 && !value.contains(['\\', ':']) && value.split('/').all(|p|!p.is_empty() && p!="." && p!=".." && !p.ends_with(['.', ' ']))
}
fn plain(path: &Path, directory: bool) -> io::Result<()> {
    let info=fs::symlink_metadata(path)?;
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if info.file_attributes() & 0x400 != 0 { return Err(invalid("runtime-linked-path")); } }
    if info.file_type().is_symlink() || if directory {!info.is_dir()} else {!info.is_file()} {return Err(invalid("runtime-linked-path"));}
    Ok(())
}
fn plain_ancestors(path: &Path) -> io::Result<()> {
    if !path.is_absolute() || path.components().any(|c| matches!(c,std::path::Component::ParentDir|std::path::Component::CurDir)) {return Err(invalid("runtime-root-invalid"));}
    for p in path.ancestors() { if p.is_absolute() { plain(p,true)?; } }
    Ok(())
}
fn read(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    plain(path,false)?;
    let mut file=File::open(path)?;
    if file.metadata()?.len()>max {return Err(invalid("runtime-record-size"));}
    let mut bytes=Vec::new(); Read::by_ref(&mut file).take(max+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>max {return Err(invalid("runtime-record-size"));}
    Ok(bytes)
}
pub fn directory(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    #[cfg(debug_assertions)]
    if let Some(root)=std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {return Ok(PathBuf::from(root).join("runtime"));}
    app.path().app_data_dir().map(|root|root.join("runtime")).map_err(|_|"runtime-store-unavailable".into())
}
pub fn install_directory(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    let root=directory(app)?; ensure(&root).map_err(|_|"runtime-store-unavailable")?;
    let record=root.join("install-prefix.json");
    let id=if record.try_exists().map_err(|_|"runtime-store-unavailable")? {
        serde_json::from_slice::<uuid::Uuid>(&read(&record,1024).map_err(|_|"runtime-install-record-invalid")?).map_err(|_|"runtime-install-record-invalid")?
    } else {
        let id=uuid::Uuid::new_v4(); crate::maintenance::atomic_json(&record,&id).map_err(|_|"runtime-install-record-save-failed")?; id
    };
    let prefix=root.join("installing").join(id.to_string());
    for p in prefix.ancestors().filter(|p|p.is_absolute()) {
        if p.try_exists().map_err(|_|"runtime-store-unavailable")? {plain(p,true).map_err(|_|"runtime-linked-path")?;}
    }
    fs::create_dir_all(&prefix).map_err(|_|"runtime-store-unavailable")?;
    plain_ancestors(&prefix).map_err(|_|"runtime-linked-path")?;
    Ok(prefix)
}
fn ensure(root: &Path) -> io::Result<()> {
    for p in root.join("versions").ancestors().filter(|p|p.is_absolute()) {
        if p.try_exists()? {plain(p,true)?;}
    }
    fs::create_dir_all(root.join("versions"))?;
    plain_ancestors(&root.join("versions"))
}
fn manifest(root: &Path, id: &str) -> io::Result<Manifest> {
    if !id_valid(id) {return Err(invalid("runtime-id-invalid"));}
    let directory=root.join("versions").join(id);
    plain_ancestors(&directory)?;
    let m: Manifest=serde_json::from_slice(&read(&directory.join("manifest.json"),16*1024)?)?;
    if m.schema!=1 || m.id!=id || m.architecture!=std::env::consts::ARCH || semver::Version::parse(&m.version).is_err()
        || !relative_valid(&m.entry) || !m.entry.ends_with("/lib/bin.js") || !is_digest(&m.fingerprint) || !is_digest(&m.inventory_hash) || !is_digest(&m.node_hash)
        || m.file_count==0 || m.file_count>MAX_FILES || m.total_bytes>MAX_BYTES {return Err(invalid("runtime-manifest-invalid"));}
    Ok(m)
}
fn verify(root: &Path, m: &Manifest) -> io::Result<PathBuf> {
    let directory=root.join("versions").join(&m.id);
    let raw=read(&directory.join("inventory.json"),MAX_INVENTORY)?;
    if digest(&raw)!=m.inventory_hash {return Err(invalid("runtime-inventory-changed"));}
    let inventory: Inventory=serde_json::from_slice(&raw)?;
    if inventory.schema!=1 || inventory.fingerprint!=m.fingerprint || inventory.files.len()!=m.file_count || inventory.total_bytes!=m.total_bytes
        || digest(&serde_json::to_vec(&inventory.files)?)!=m.fingerprint {return Err(invalid("runtime-inventory-invalid"));}
    let tree=directory.join("tree"); plain_ancestors(&tree)?;
    let mut expected=HashSet::new(); let mut total=0u64;
    for item in &inventory.files {
        if !relative_valid(&item.path) || !is_digest(&item.sha256) || !expected.insert(item.path.to_ascii_lowercase()) {return Err(invalid("runtime-inventory-invalid"));}
        total=total.checked_add(item.size).filter(|n|*n<=MAX_BYTES).ok_or_else(||invalid("runtime-size-budget"))?;
    }
    if total!=m.total_bytes || !expected.contains(&m.entry.to_ascii_lowercase()) {return Err(invalid("runtime-inventory-invalid"));}
    fn walk(root: &Path, path: &Path, depth: usize, expected: &mut HashSet<String>) -> io::Result<()> {
        if depth>80 {return Err(invalid("runtime-depth-budget"));}
        plain(path,true)?;
        for row in fs::read_dir(path)? {
            let path=row?.path(); let info=fs::symlink_metadata(&path)?;
            if info.is_dir() {walk(root,&path,depth+1,expected)?;} else {
                plain(&path,false)?;
                let name=path.strip_prefix(root).map_err(|_|invalid("runtime-linked-path"))?.to_string_lossy().replace('\\',"/").to_ascii_lowercase();
                if !expected.remove(&name) {return Err(invalid("runtime-tree-changed"));}
            }
        }
        Ok(())
    }
    walk(&tree,&tree,0,&mut expected)?;
    if !expected.is_empty() {return Err(invalid("runtime-tree-changed"));}
    for item in &inventory.files {
        let path=tree.join(&item.path); plain(&path,false)?;
        let mut file=File::open(path)?; if file.metadata()?.len()!=item.size {return Err(invalid("runtime-tree-changed"));}
        let mut hash=Sha256::new(); let mut buffer=[0u8;64*1024]; let mut size=0u64;
        loop {let n=file.read(&mut buffer)?;if n==0 {break;} size+=n as u64; if size>item.size {return Err(invalid("runtime-tree-changed"));} hash.update(&buffer[..n]);}
        if size!=item.size || format!("{:x}",hash.finalize())!=item.sha256 {return Err(invalid("runtime-tree-changed"));}
    }
    Ok(tree.join(&m.entry))
}
fn load_selection(root: &Path) -> io::Result<Option<Selection>> {
    let path=root.join("selection.json");
    if !path.try_exists()? {return Ok(None);}
    plain_ancestors(root)?;
    let s: Selection=serde_json::from_slice(&read(&path,16*1024)?)?;
    if s.schema!=1 || !id_valid(&s.active) || s.previous.as_ref().is_some_and(|id|!id_valid(id) || id==&s.active) || !is_digest(&s.fingerprint)
        || s.verified_at==0 || !s.backend_ready || !s.ui_ready {return Err(invalid("runtime-selection-invalid"));}
    Ok(Some(s))
}
pub fn selected(root: &Path, node: &Path) -> io::Result<Option<Runtime>> {
    let Some(s)=load_selection(root)? else {return Ok(None)};
    let m=manifest(root,&s.active)?;
    if file_hash(node)?!=m.node_hash {return Err(invalid("runtime-node-changed"));}
    if s.fingerprint!=m.fingerprint {return Err(invalid("runtime-selection-changed"));}
    let entry=verify(root,&m)?;
    Ok(Some(runtime(node,entry,&m,true)))
}
fn runtime(node: &Path, entry: PathBuf, m: &Manifest, committed: bool) -> Runtime {
    Runtime {node_exe:node.into(),dsh_bin:entry,source:DshSource::Managed,version:Some(m.version.clone()),
        managed:Some(ManagedRuntime {id:m.id.clone(),fingerprint:m.fingerprint.clone(),committed})}
}
pub fn resolve(app: &tauri::AppHandle, node: &Path) -> Result<Option<Runtime>,String> {
    resolve_at(&directory(app)?,node,||crate::diagnostics::record(app,"runtime","selection-rejected"))
}
fn resolve_at(root: &Path, node: &Path, rejected: impl FnOnce()) -> Result<Option<Runtime>,String> {
    // Invalid overrides retain legacy discovery behavior; valid pins always win.
    if let Some(path)=std::env::var_os(crate::dsh::ENV_DSH).map(PathBuf::from).filter(|p|p.is_file()) {
        return Ok(Some(Runtime {node_exe:node.into(),dsh_bin:path,source:DshSource::Configured,version:None,managed:None}));
    }
    match selected(root,node) {
        Ok(Some(runtime))=>return Ok(Some(runtime)),
        Ok(None)=>{},
        Err(_)=>rejected(),
    }
    if let Some((entry,source))=crate::dsh::resolve_dsh(false) {return Ok(Some(Runtime {node_exe:node.into(),dsh_bin:entry,source,version:None,managed:None}));}
    pending(root,node).map_err(|_|"runtime-pending-invalid".into())
}
fn pending(root: &Path, node: &Path) -> io::Result<Option<Runtime>> {
    let path=root.join("first-install.json");
    if !path.try_exists()? {return Ok(None);}
    let id: String=serde_json::from_slice(&read(&path,1024)?)?;
    let m=manifest(root,&id)?;
    if file_hash(node)?!=m.node_hash {return Err(invalid("runtime-node-changed"));}
    let entry=verify(root,&m)?;
    Ok(Some(runtime(node,entry,&m,false)))
}

/// Freeze an actual package before any running backend is stopped. The original
/// tree stays intact. Failed/incomplete stages remain unselected for inspection.
pub fn freeze(app: &tauri::AppHandle, node: &Path, source: &Path) -> Result<Runtime,String> {
    let helper=crate::patch_file(app)?.parent().ok_or("runtime-helper-missing")?.join("runtime-store/prepare.mjs");
    freeze_at(&directory(app)?,node,source,&helper)
}

pub fn candidate_directory(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    candidate_directory_at(&directory(app)?)
}
fn candidate_directory_at(root: &Path) -> Result<PathBuf,String> {
    ensure(root).map_err(|_|"runtime-store-unavailable")?;
    let directory=root.join("candidates").join(uuid::Uuid::new_v4().to_string());
    for p in directory.ancestors().filter(|p|p.is_absolute()) {
        if p.try_exists().map_err(|_|"runtime-store-unavailable")? {plain(p,true).map_err(|_|"runtime-linked-path")?;}
    }
    fs::create_dir_all(&directory).map_err(|_|"runtime-candidate-stage-unavailable")?;
    plain_ancestors(&directory).map_err(|_|"runtime-linked-path")?;
    Ok(directory)
}

/// Publish a verified tree without changing selection or first-install intent.
pub fn freeze_candidate(app: &tauri::AppHandle,node: &Path,prefix: &Path,version: &str) -> Result<Runtime,String> {
    let helper=crate::patch_file(app)?.parent().ok_or("runtime-helper-missing")?.join("runtime-store/prepare.mjs");
    let root=directory(app)?;
    freeze_candidate_at(&root,node,prefix,version,&helper)
}
fn freeze_candidate_at(root: &Path,node: &Path,prefix: &Path,version: &str,helper: &Path) -> Result<Runtime,String> {
    crate::npm::candidate_argv(prefix,version)?;
    plain_ancestors(prefix).map_err(|_|"runtime-linked-path")?;
    if prefix.parent()!=Some(root.join("candidates").as_path()) {return Err("runtime-candidate-binding".into());}
    let entry=prefix.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    let found=candidate_version(node,&entry,prefix)?;
    if found.trim_start_matches('v')!=version {return Err("runtime-candidate-version-mismatch".into());}
    let result=freeze_at_context(root,node,entry.parent().and_then(Path::parent).ok_or("runtime-candidate-binding")?,helper,Some(prefix))?;
    if result.version.as_deref()!=Some(version) {return Err("runtime-candidate-version-mismatch".into());}
    Ok(result)
}
fn candidate_version(node:&Path,entry:&Path,prefix:&Path)->Result<String,String> {
    let mut command=Command::new(node);
    command.arg(crate::dsh::node_script_path(entry)).arg("--version").current_dir(prefix)
        .env("DSH_HOME",prefix.join("probe-home")).env("NARB_NATIVE_CACHE_DIR",prefix.join("native-cache"))
        .env_remove("DSH_DESKTOP_DSH_BIN");
    crate::dsh_update::output(&mut command,"candidate-version",crate::dsh::VERSION_PROBE_TIMEOUT)
        .map_err(|_|"runtime-candidate-version-unavailable".into())
}

/// A retained Profile has a separate binding from the immutable runtime tree.
/// This read-only check neither selects a version nor certifies data migration.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ProfileVerification {
    schema: u32,
    fingerprint: String,
    bundle_count: usize,
    module_count: usize,
    retained_packages: usize,
    data_migration: String,
}

/// Reusable by candidate preparation. Keep the old backend running throughout
/// this call; callers must repeat the binding check before a later switch.
pub fn verify_profile(app: &tauri::AppHandle, source: &Runtime, target: &Runtime,
    roots: &crate::data_inventory::ProviderRoots, overlays: &[PathBuf]) -> Result<ProfileVerification,String> {
    let helper=crate::patch_file(app)?.parent().ok_or("runtime-helper-missing")?.join("runtime-store/profile.mjs");
    verify_profile_at(&directory(app)?,&helper,source,target,roots,overlays)
}

fn verify_profile_at(root: &Path, helper: &Path, source: &Runtime, target: &Runtime,
    roots: &crate::data_inventory::ProviderRoots, overlays: &[PathBuf]) -> Result<ProfileVerification,String> {
    if !roots.valid() || source.node_exe!=target.node_exe || source.version!=target.version
        || source.version.is_none() || source.dsh_bin==target.dsh_bin || overlays.len()>32 || overlays.iter().any(|p|!p.is_absolute()) {
        return Err("runtime-profile-binding".into());
    }
    let anchor=source.dsh_bin.parent().and_then(Path::parent).ok_or("runtime-profile-binding")?.join("package.json");
    if fs::canonicalize(&anchor).map_err(|_|"runtime-profile-binding")?!=fs::canonicalize(&roots.install_anchor).map_err(|_|"runtime-profile-binding")? {
        return Err("runtime-profile-binding".into());
    }
    let managed=target.managed.as_ref().ok_or("runtime-unmanaged")?;
    let m=manifest(root,&managed.id).map_err(|_|"runtime-manifest-invalid")?;
    if m.fingerprint!=managed.fingerprint || m.version!=target.version.as_deref().unwrap_or("")
        || file_hash(&target.node_exe).map_err(|_|"runtime-node-unavailable")?!=m.node_hash
        || verify(root,&m).map_err(|_|"runtime-tree-changed")?!=target.dsh_bin {return Err("runtime-profile-binding".into());}
    ensure(root).map_err(|_|"runtime-store-unavailable")?;
    let mut request=tempfile::Builder::new().prefix(".profile-check-").suffix(".json").tempfile_in(root).map_err(|_|"runtime-profile-request")?;
    // This private request has no readers until the helper starts. Replacing an
    // open NamedTempFile fails on Windows; keep its ownership and write in place.
    serde_json::to_writer(&mut request,&serde_json::json!({"sourceEntry":source.dsh_bin,"targetEntry":target.dsh_bin,
        "home":roots.profile_home,"profileDirectory":roots.profile_directory,"overlays":overlays,
        "telemetryDisabledEnv":std::env::var("DSH_TELEMETRY_DISABLED").ok()})).map_err(|_|"runtime-profile-request")?;
    request.write_all(b"\n").and_then(|_|request.as_file().sync_all()).map_err(|_|"runtime-profile-request")?;
    let mut command=Command::new(&source.node_exe);
    command.arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(request.path()));
    let text=crate::dsh_update::output(&mut command,"runtime-profile-check",Duration::from_secs(60))?;
    let result:ProfileVerification=serde_json::from_str(&text).map_err(|_|"runtime-profile-response")?;
    if result.schema!=1 || !is_digest(&result.fingerprint) || result.bundle_count>256 || result.module_count>8192
        || result.retained_packages>MAX_FILES || result.data_migration!="unverified" {return Err("runtime-profile-response".into());}
    Ok(result)
}
fn freeze_at(root: &Path, node: &Path, source: &Path, helper: &Path) -> Result<Runtime,String> {
    freeze_at_context(root,node,source,helper,None)
}
fn freeze_at_context(root: &Path,node:&Path,source:&Path,helper:&Path,candidate:Option<&Path>)->Result<Runtime,String> {
    ensure(root).map_err(|_|"runtime-store-unavailable")?;
    let stage=root.join("versions").join(format!(".preparing-{}",uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|_|"runtime-stage-unavailable")?;
    let request=stage.join("request.json");
    crate::maintenance::atomic_json(&request,&serde_json::json!({"source":source,"destination":stage.join("tree")})).map_err(|_|"runtime-stage-unavailable")?;
    let mut cmd=Command::new(node);
    cmd.arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(&request));
    let text=crate::dsh_update::output(&mut cmd,"runtime-freeze",Duration::from_secs(600))?;
    let prepared:Prepared=serde_json::from_str(&text).map_err(|_|"runtime-preparation-invalid")?;
    let id=format!("{}-{}-{}-{}",prepared.version,std::env::consts::ARCH,prepared.fingerprint,uuid::Uuid::new_v4());
    let m=Manifest {schema:1,id:id.clone(),version:prepared.version,architecture:std::env::consts::ARCH.into(),entry:prepared.entry,node_hash:file_hash(node).map_err(|_|"runtime-node-unavailable")?,
        fingerprint:prepared.fingerprint,inventory_hash:digest(&read(&stage.join("inventory.json"),MAX_INVENTORY).map_err(|_|"runtime-preparation-invalid")?),
        file_count:prepared.file_count,total_bytes:prepared.total_bytes};
    crate::maintenance::atomic_json(&stage.join("manifest.json"),&m).map_err(|_|"runtime-manifest-save-failed")?;
    // No existing version is overwritten, even when its package version matches.
    fs::rename(&stage,root.join("versions").join(&id)).map_err(|_|"runtime-publish-failed")?;
    let m=manifest(root,&id).map_err(|_|"runtime-manifest-invalid")?;
    let entry=verify(root,&m).map_err(|_|"runtime-tree-invalid")?;
    let reported=if let Some(prefix)=candidate {candidate_version(node,&entry,prefix)?}
        else {crate::dsh::probe_version(node,&entry).ok_or("runtime-version-unavailable")?};
    if reported.trim_start_matches('v')!=m.version {return Err("runtime-version-mismatch".into());}
    Ok(runtime(node,entry,&m,false))
}
pub fn remember_first_install(app: &tauri::AppHandle, runtime: &Runtime) -> Result<(),String> {
    let managed=runtime.managed.as_ref().ok_or("runtime-unmanaged")?;
    let root=directory(app)?;
    if load_selection(&root).map_err(|_|"runtime-selection-invalid")?.is_some() {return Err("runtime-selection-already-exists".into());}
    crate::maintenance::atomic_json(&root.join("first-install.json"),&managed.id).map_err(|_|"runtime-pending-save-failed".into())
}
fn commit_first(root: &Path, runtime: &Runtime) -> io::Result<()> {
    let managed=runtime.managed.as_ref().ok_or_else(||invalid("runtime-unmanaged"))?;
    let id:String=serde_json::from_slice(&read(&root.join("first-install.json"),1024)?)?;
    let m=manifest(root,&id)?;
    if id!=managed.id || m.fingerprint!=managed.fingerprint || root.join("versions").join(&id).join("tree").join(&m.entry)!=runtime.dsh_bin || runtime.version.as_deref()!=Some(&m.version) {return Err(invalid("runtime-pending-changed"));}
    if load_selection(root)?.is_some() {return Err(invalid("runtime-selection-already-exists"));}
    let selection=Selection {schema:1,active:managed.id.clone(),previous:None,fingerprint:managed.fingerprint.clone(),verified_at:crate::maintenance::now_ms(),backend_ready:true,ui_ready:true};
    crate::maintenance::atomic_json(&root.join("selection.json"),&selection)?;
    // A stale pending reference is harmless after selection committed.
    let _=fs::remove_file(root.join("first-install.json"));
    Ok(())
}

/// The native backend readiness check alone cannot commit a first install.
/// This acknowledgement comes from the desktop bridge after its adapter mounts.
#[tauri::command]
pub async fn desktop_runtime_ready(window: tauri::WebviewWindow, identity: crate::remote_control::Identity) -> Result<(),String> {
    crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
    let app=window.app_handle().clone(); let shared=app.state::<crate::state::Shared>().inner().clone();
    let runtime={
        let s=shared.lock().map_err(|_|"runtime-state")?;
        if !s.ui.loaded || s.ui.snapshot.is_some() || s.ui.phase!=crate::ui_snapshot::UiPhase::Active {return Err("runtime-ui-not-ready".into());}
        match s.runtime.as_ref().filter(|r|r.managed.as_ref().is_some_and(|m|!m.committed)) {Some(r)=>r.clone(),None=>return Ok(())}
    };
    tauri::async_runtime::spawn_blocking(move || {
        // The page can mount just before the boot worker releases its lease.
        // Keep this single acknowledgement pending briefly instead of losing it.
        let coordinator=app.state::<crate::maintenance::MaintenanceCoordinator>();
        let deadline=std::time::Instant::now()+Duration::from_secs(2);
        let _lease=loop {
            match coordinator.begin(crate::maintenance::Kind::Install) {
                Ok(lease)=>break lease,
                Err(error) if error=="maintenance-busy" && std::time::Instant::now()<deadline => {
                    crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error)=>return Err(error),
            }
        };
        // Disk verification runs outside AppState. Recheck the caller immediately
        // before publication, including a backend that exited during hashing.
        let root=directory(&app)?;
        let m=manifest(&root,&runtime.managed.as_ref().unwrap().id).map_err(|_|"runtime-manifest-invalid")?;
        if file_hash(&runtime.node_exe).map_err(|_|"runtime-node-unavailable")?!=m.node_hash {return Err("runtime-node-changed".into());}
        verify(&root,&m).map_err(|_|"runtime-tree-changed")?;
        if crate::dsh::probe_version(&runtime.node_exe,&runtime.dsh_bin).as_deref().map(|v|v.trim_start_matches('v'))!=runtime.version.as_deref() {return Err("runtime-version-mismatch".into());}
        crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
        {
            let s=shared.lock().map_err(|_|"runtime-state")?;
            if s.ui.snapshot.is_some() || s.ui.phase!=crate::ui_snapshot::UiPhase::Active || s.runtime.as_ref().map(|r|&r.dsh_bin)!=Some(&runtime.dsh_bin) {return Err("runtime-ui-not-ready".into());}
        }
        commit_first(&root,&runtime).map_err(|_|"runtime-selection-save-failed")?;
        if let Ok(mut s)=shared.lock() {
            if let Some(current)=s.runtime.as_mut().filter(|r|r.dsh_bin==runtime.dsh_bin) {if let Some(m)=&mut current.managed {m.committed=true;}}
        }
        crate::diagnostics::record(&app,"runtime","first-install-committed");
        Ok(())
    }).await.map_err(|_|"runtime-worker")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path, id: &str, node: &Path) -> Runtime {
        let dir=root.join("versions").join(id); let tree=dir.join("tree");
        fs::create_dir_all(tree.join("node_modules/@deepseek-ai/dsh/lib")).unwrap();
        let entry="node_modules/@deepseek-ai/dsh/lib/bin.js";
        let content=b"fixture"; fs::write(tree.join(entry),content).unwrap();
        let files=vec![InventoryFile {path:entry.into(),size:content.len() as u64,sha256:digest(content)}];
        let fingerprint=digest(&serde_json::to_vec(&files).unwrap());
        let inv=Inventory {schema:1,fingerprint:fingerprint.clone(),files,total_bytes:content.len() as u64};
        let bytes=serde_json::to_vec(&inv).unwrap(); fs::write(dir.join("inventory.json"),&bytes).unwrap();
        let m=Manifest {schema:1,id:id.into(),version:"0.2.1-rc.2".into(),architecture:std::env::consts::ARCH.into(),node_hash:file_hash(node).unwrap(),
            entry:entry.into(),fingerprint,inventory_hash:digest(&bytes),file_count:1,total_bytes:content.len() as u64};
        crate::maintenance::atomic_json(&dir.join("manifest.json"),&m).unwrap();
        runtime(node,tree.join(entry),&m,false)
    }
    fn select(root: &Path, r: &Runtime) {
        let m=r.managed.as_ref().unwrap();
        crate::maintenance::atomic_json(&root.join("selection.json"),&Selection {schema:1,active:m.id.clone(),previous:None,fingerprint:m.fingerprint.clone(),verified_at:1,backend_ready:true,ui_ready:true}).unwrap();
    }
    #[test]
    fn pending_first_install_requires_commit_and_preserves_other_versions() {
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path().join("runtime");let node=std::env::current_exe().unwrap();
        let a=fixture(&root,"fixture-a",&node);let b=fixture(&root,"fixture-b",&node);
        assert!(selected(&root,&node).unwrap().is_none());
        crate::maintenance::atomic_json(&root.join("first-install.json"),&a.managed.as_ref().unwrap().id).unwrap();
        assert!(!pending(&root,&node).unwrap().unwrap().managed.unwrap().committed);
        assert!(commit_first(&root,&b).is_err());
        commit_first(&root,&a).unwrap();
        let chosen=selected(&root,&node).unwrap().unwrap();
        assert_eq!(chosen.dsh_bin,a.dsh_bin); assert!(chosen.managed.unwrap().committed);
        assert!(b.dsh_bin.is_file());assert!(!root.join("first-install.json").exists());
        assert!(commit_first(&root,&b).is_err());
    }
    #[test]
    fn selection_rejects_changed_tree_inventory_node_and_unconfirmed_health() {
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path().join("runtime");let node=std::env::current_exe().unwrap();
        let a=fixture(&root,"fixture-a",&node);select(&root,&a);
        let path=a.dsh_bin.clone();fs::write(&path,b"changed").unwrap();assert!(selected(&root,&node).is_err());
        fs::write(&path,b"fixture").unwrap();
        fs::write(path.parent().unwrap().join("extra.js"),b"extra").unwrap();assert!(selected(&root,&node).is_err());
        fs::remove_file(path.parent().unwrap().join("extra.js")).unwrap();
        assert!(selected(&root,&node).unwrap().is_some());
        let other=tmp.path().join("different-node.exe");fs::write(&other,b"different").unwrap();assert!(selected(&root,&other).is_err());
        let mut s=load_selection(&root).unwrap().unwrap();s.ui_ready=false;crate::maintenance::atomic_json(&root.join("selection.json"),&s).unwrap();assert!(selected(&root,&node).is_err());
        select(&root,&a);
        fs::write(root.join("versions/fixture-a/inventory.json"),b"{}").unwrap();assert!(selected(&root,&node).is_err());
    }
    #[test]
    fn invalid_ids_cannot_escape_the_store() {
        let tmp=tempfile::tempdir().unwrap();
        for id in ["..","../outside","C:/outside","\\outside",""] {assert!(manifest(tmp.path(),id).is_err());}
        for path in ["../bin.js","/bin.js","C:bin.js","a\\b","a/../b","a./b"] {assert!(!relative_valid(path));}
    }
    #[test]
    fn startup_keeps_pin_then_managed_then_legacy_order() {
        const CHILD:&str="DSH_RUNTIME_STORE_LOOKUP_TEST";
        if let Some(root)=std::env::var_os(CHILD) {
            let root=PathBuf::from(root);let node=std::env::current_exe().unwrap();let store=root.join("runtime");
            let managed=fixture(&store,"fixture-managed",&node);select(&store,&managed);
            let global=crate::dsh::global_dsh_bin().unwrap();fs::create_dir_all(global.parent().unwrap()).unwrap();fs::write(&global,b"global").unwrap();
            assert_eq!(resolve_at(&store,&node,||{}).unwrap().unwrap().source,DshSource::Managed);
            let pin=PathBuf::from(std::env::var_os(crate::dsh::ENV_DSH).unwrap());fs::write(&pin,b"pin").unwrap();
            assert_eq!(resolve_at(&store,&node,||panic!("pin must bypass selection")).unwrap().unwrap().source,DshSource::Configured);
            fs::remove_file(pin).unwrap();fs::write(&managed.dsh_bin,b"bad").unwrap();
            assert_eq!(resolve_at(&store,&node,||{}).unwrap().unwrap().dsh_bin,global);
            return;
        }
        let root=tempfile::tempdir().unwrap();
        let output=Command::new(std::env::current_exe().unwrap()).args(["--exact","runtime_store::tests::startup_keeps_pin_then_managed_then_legacy_order","--nocapture"])
            .env(CHILD,root.path()).env("APPDATA",root.path()).env(crate::dsh::ENV_DSH,root.path().join("pinned.js")).output().unwrap();
        assert!(output.status.success(),"{}\n{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
    }
    #[test]
    fn candidate_freeze_preserves_selection_and_never_becomes_pending_first_install() {
        let node=crate::dsh::resolve_node().expect("Node is required for candidate verification");
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path().join("runtime");
        let previous=fixture(&root,"fixture-previous",&node);select(&root,&previous);
        let selection=fs::read(root.join("selection.json")).unwrap();
        let prefix=candidate_directory_at(&root).unwrap();
        let package=prefix.join("node_modules/@deepseek-ai/dsh");fs::create_dir_all(package.join("lib")).unwrap();
        fs::write(package.join("package.json"),br#"{"name":"@deepseek-ai/dsh","version":"0.2.2-test.1"}"#).unwrap();
        fs::write(package.join("lib/bin.js"),"if (!process.env.DSH_HOME.endsWith('probe-home')) process.exit(1);process.stdout.write('0.2.2-test.1')").unwrap();
        let helper=Path::new(env!("CARGO_MANIFEST_DIR")).join("../dsh-plugin/runtime-store/prepare.mjs");
        assert_eq!(freeze_candidate_at(&root,&node,&prefix,"0.2.2-test.2",&helper).unwrap_err(),"runtime-candidate-version-mismatch");
        let candidate=freeze_candidate_at(&root,&node,&prefix,"0.2.2-test.1",&helper).unwrap();
        assert_eq!(candidate.version.as_deref(),Some("0.2.2-test.1"));assert_ne!(candidate.dsh_bin,previous.dsh_bin);
        assert_eq!(fs::read(root.join("selection.json")).unwrap(),selection);assert!(!root.join("first-install.json").exists());
        assert_eq!(selected(&root,&node).unwrap().unwrap().dsh_bin,previous.dsh_bin);
        assert!(package.join("lib/bin.js").is_file());
    }
    #[test]
    fn profile_preflight_reads_private_request_and_rejects_changed_bindings() {
        let node=crate::dsh::resolve_node().expect("Node is required for native helper verification");
        let tmp=tempfile::tempdir().unwrap();let root=tmp.path().join("runtime");
        let target=fixture(&root,"fixture-target",&node);
        let mut source=target.clone();source.source=DshSource::Configured;source.managed=None;
        source.dsh_bin=tmp.path().join("source/lib/bin.js");
        fs::create_dir_all(source.dsh_bin.parent().unwrap()).unwrap();
        fs::write(&source.dsh_bin,b"source").unwrap();
        let anchor=tmp.path().join("source/package.json");fs::write(&anchor,b"{}").unwrap();
        let home=tmp.path().join("home");let dir=home.join("profiles/web");fs::create_dir_all(&dir).unwrap();
        let roots=crate::data_inventory::ProviderRoots {schema:1,profile_home:home.clone(),profile_directory:dir,
            session_root:home.clone(),session_schema:Some(4),session_flush:true,attachment_root:None,install_anchor:anchor,
            desktop_preferences:None,plugin_intent:None,profile_switches:None,upstream_settings:None,credential_classification:None};
        let helper=tmp.path().join("helper.mjs");
        fs::write(&helper,r#"import {readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
if (!request.sourceEntry.endsWith('bin.js') || !request.targetEntry.endsWith('bin.js') || !request.profileDirectory || request.overlays.length) process.exit(1);
process.stdout.write(JSON.stringify({schema:1,fingerprint:'a'.repeat(64),bundleCount:2,moduleCount:3,retainedPackages:0,dataMigration:'unverified'}));"#).unwrap();
        let verified=verify_profile_at(&root,&helper,&source,&target,&roots,&[]).unwrap();
        assert_eq!(verified.module_count,3);assert!(!root.join("selection.json").exists());
        assert!(fs::read_dir(&root).unwrap().all(|row|!row.unwrap().file_name().to_string_lossy().starts_with(".profile-check-")));
        let mut wrong=roots.clone();wrong.install_anchor=helper.clone();
        assert_eq!(verify_profile_at(&root,&helper,&source,&target,&wrong,&[]).unwrap_err(),"runtime-profile-binding");
        let mut changed=target.clone();changed.managed.as_mut().unwrap().fingerprint="b".repeat(64);
        assert_eq!(verify_profile_at(&root,&helper,&source,&changed,&roots,&[]).unwrap_err(),"runtime-profile-binding");
        fs::write(&target.dsh_bin,b"changed").unwrap();
        assert_eq!(verify_profile_at(&root,&helper,&source,&target,&roots,&[]).unwrap_err(),"runtime-tree-changed");
    }
    #[test]
    fn native_freeze_uses_shipped_helper_and_preserves_original_dependency_tree() {
        let Some(node)=crate::dsh::resolve_node() else {return};
        let tmp=tempfile::tempdir().unwrap();let source=tmp.path().join("source/node_modules/@deepseek-ai/dsh");
        fs::create_dir_all(source.join("lib")).unwrap();
        fs::create_dir_all(tmp.path().join("source/node_modules/peer")).unwrap();
        fs::write(source.join("package.json"),br#"{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2","peerDependencies":{"peer":"1"}}"#).unwrap();
        fs::write(source.join("lib/bin.js"),"process.stdout.write('0.2.1-rc.2')").unwrap();
        fs::write(tmp.path().join("source/node_modules/peer/package.json"),br#"{"name":"peer","version":"1.0.0"}"#).unwrap();
        let helper=Path::new(env!("CARGO_MANIFEST_DIR")).join("../dsh-plugin/runtime-store/prepare.mjs");
        let root=tmp.path().join("runtime");let a=freeze_at(&root,&node,&source,&helper).unwrap();
        let b=freeze_at(&root,&node,&source,&helper).unwrap();
        assert_ne!(a.dsh_bin,b.dsh_bin);assert_eq!(a.managed.as_ref().unwrap().fingerprint,b.managed.as_ref().unwrap().fingerprint);
        assert!(source.join("lib/bin.js").is_file());assert!(a.dsh_bin.is_file());assert!(selected(&root,&node).unwrap().is_none());
        fs::write(source.join("package.json"),br#"{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2","dependencies":{"absent":"1"}}"#).unwrap();
        assert!(freeze_at(&root,&node,&source,&helper).is_err());assert!(a.dsh_bin.is_file());
    }
    #[test]
    #[cfg(windows)]
    fn junctions_are_rejected_before_store_writes() {
        let tmp=tempfile::tempdir().unwrap();let outside=tmp.path().join("outside");let link=tmp.path().join("link");fs::create_dir(&outside).unwrap();
        let Some(node)=crate::dsh::resolve_node() else {return};
        let status=Command::new(node).args(["-e","require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')"]).arg(&outside).arg(&link).status().unwrap();
        assert!(status.success());
        assert!(ensure(&link).is_err());assert!(!outside.join("versions").exists());
    }
}
