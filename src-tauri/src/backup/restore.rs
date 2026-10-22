//! Partial restore coordinator. Native-issued previews bind validated bytes to
//! one document and current revisions. The UI never supplies a filesystem path.
use std::{collections::BTreeMap, path::{Path,PathBuf}, process::Command, sync::{Arc,Mutex}};
use serde::Deserialize;
use tauri::{AppHandle,Manager,WebviewWindow};
use crate::{dsh::Runtime,maintenance::{Kind,Stage},remote_control::Identity,state::Shared,ui_snapshot::{UiPayload,UiSnapshot,UiPhase}};
use super::{format,transaction::{self,Transaction},Preview};

const PREVIEW_TTL:u64=10*60*1000;
struct Prepared {
    id:uuid::Uuid, expires:u64, identity:Identity, version:String,
    _verified:format::Verified,
    targets:BTreeMap<String,PathBuf>, before:BTreeMap<String,Option<Vec<u8>>>, after:BTreeMap<String,Vec<u8>>,
    roots:Roots, profile_binding:Option<String>,
}
struct Active { transaction:Transaction, runtime:Runtime, config:crate::remote_control::Config, profile_lease:Option<super::profile_lock::ProfileLease> }
#[derive(Default)]
pub struct RestoreManager { preview:Mutex<Option<Prepared>>, active:Mutex<Option<Active>> }
fn error(e:impl std::fmt::Display)->String {
    let value=e.to_string();
    if value.starts_with("backup-") && value.len()<160 && value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-') {value}
    else {"backup-restore-failed".into()}
}
fn helper(app:&AppHandle)->Result<PathBuf,String> {
    Ok(crate::patch_file(app)?.parent().ok_or("backup-provider-unavailable")?.join("desktop-maintenance/providers.mjs"))
}
fn host_root(app:&AppHandle)->Result<PathBuf,String> {
    #[cfg(debug_assertions)]
    if let Some(root)=std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {return Ok(PathBuf::from(root))}
    app.path().app_data_dir().map_err(|_|"backup-directory".into())
}
fn directory(app:&AppHandle)->Result<PathBuf,String> {Ok(host_root(app)?.join("maintenance/configuration"))}
fn provider(runtime:&Runtime,helper:&Path,request:&Path)->Result<String,String> {
    let mut command=Command::new(&runtime.node_exe);
    command.arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(request)).env("DSH_DESKTOP_DSH_BIN",&runtime.dsh_bin);
    crate::dsh_update::output(&mut command,"backup-provider",std::time::Duration::from_secs(15)).map_err(|message| {
        let code=message.rsplit_once('：').map(|(_,code)|code.trim()).unwrap_or("");
        if matches!(code,"backup-profile-unavailable"|"backup-profile-schema"|"backup-profile-version"|"backup-profile-target") {code.into()}
        else {"backup-provider-failed".into()}
    })
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Roots {desktop_preferences:PathBuf,plugin_intent:PathBuf,profile_switches:PathBuf,profile_home:PathBuf,profile_directory:PathBuf}
fn resolved(app:&AppHandle,runtime:&Runtime)->Result<Roots,String> {
    let staging=tempfile::tempdir().map_err(error)?;let request=staging.path().join("request.json");
    crate::maintenance::atomic_json(&request,&serde_json::json!({"mode":"resolve","pluginFile":host_root(app)?.join("desktop-plugins.json")})).map_err(error)?;
    serde_json::from_str(&provider(runtime,&helper(app)?,&request)?).map_err(|_|"backup-provider-invalid".into())
}
impl Roots {
    fn targets(&self)->BTreeMap<String,PathBuf> {BTreeMap::from([("desktop-preferences".into(),self.desktop_preferences.clone()),("plugin-intent".into(),self.plugin_intent.clone()),("profile-plugins".into(),self.profile_switches.clone())])}
    fn matches(&self,observed:&crate::data_inventory::ProviderRoots)->bool {
        let normalize=|path:&Path|path.to_string_lossy().replace('/',"\\").trim_start_matches("\\\\?\\").to_lowercase();
        normalize(&self.profile_home)==normalize(&observed.profile_home) && normalize(&self.profile_directory)==normalize(&observed.profile_directory)
            && observed.desktop_preferences.as_ref().is_some_and(|p|normalize(p)==normalize(&self.desktop_preferences))
            && observed.plugin_intent.as_ref().is_some_and(|p|normalize(p)==normalize(&self.plugin_intent))
            && observed.profile_switches.as_ref().is_some_and(|p|normalize(p)==normalize(&self.profile_switches))
    }
}
fn supported(component:&format::Component)->bool {
    matches!(component.id.as_str(),"desktop-preferences"|"plugin-intent"|"profile-plugins") && component.provider==component.id && component.logical_target==component.id
        && component.schema==1 && component.files.len()==1 && component.files[0].path==format!("components/{}/data.json",component.id)
        && component.files[0].size<=transaction::MAX_FILE
}
fn merge(runtime:&Runtime,helper:&Path,overlay:&Path,roots:&Roots,verified:&format::Verified,targets:&BTreeMap<String,PathBuf>) -> Result<(BTreeMap<String,Option<Vec<u8>>>,BTreeMap<String,Vec<u8>>,Option<String>),String> {
    let staging=tempfile::tempdir().map_err(error)?;let mut before=BTreeMap::new();let mut items=vec![];
    let profile=targets.contains_key("profile-plugins");
    let _manifest=if profile {Some(transaction::protect_readonly(&super::profile_lock::manifest(&roots.profile_directory)).map_err(|_|"backup-profile-unavailable")?)} else {None};
    let boot=if profile {Some(crate::builtin_plugins::boot_patch(&roots.plugin_intent).map_err(error)?)} else {None};
    for (id,path) in targets {
        let current=transaction::read_optional(path).map_err(error)?;
        let before_file=if let Some(value)=&current {
            let file=staging.path().join(format!("{id}.before"));std::fs::write(&file,value).map_err(error)?;Some(file)
        } else {None};
        items.push(serde_json::json!({"id":id,"imported":verified.file(&format!("components/{id}/data.json")).ok_or("backup-component-unsupported")?,"before":before_file}));
        before.insert(id.clone(),current);
    }
    let request=staging.path().join("request.json");
    crate::maintenance::atomic_json(&request,&serde_json::json!({"mode":"merge","items":items,"staging":staging.path(),
        "roots":{"profileHome":roots.profile_home,"profileDirectory":roots.profile_directory},"overlayPath":overlay,"bootPath":boot.as_ref().map(|f|f.path())})).map_err(error)?;
    let result:super::Capture=serde_json::from_str(&provider(runtime,helper,&request)?).map_err(|_|"backup-provider-invalid")?;
    if result.schema!=1 || result.components.len()!=targets.len() || !result.excluded.is_empty() {return Err("backup-provider-invalid".into())}
    if profile && !result.profile_binding.as_ref().is_some_and(|hash|hash.len()==64&&hash.bytes().all(|b|b.is_ascii_hexdigit())) {return Err("backup-provider-invalid".into())}
    let mut after=BTreeMap::new();
    for component in result.components {
        if !targets.contains_key(&component.id) || component.schema!=1 || after.contains_key(&component.id) {return Err("backup-provider-invalid".into())}
        let value=transaction::read_optional(&staging.path().join(format!("{}.json",component.id))).map_err(error)?.ok_or("backup-provider-invalid")?;
        if value.len() as u64!=component.size || transaction::hash(&value)!=component.sha256 {return Err("backup-provider-invalid".into())}
        after.insert(component.id,value);
    }
    Ok((before,after,result.profile_binding))
}
pub(super) fn preview(app:&AppHandle,window:&WebviewWindow,identity:Option<Identity>,verified:format::Verified)->Result<Preview,String> {
    let mut response=Preview {manifest:verified.manifest.clone(),supported_components:vec![],unsupported_components:vec![],can_restore:false,
        reason_code:"backup-restore-unavailable",restore_handle:None,expires_at:None};
    let manager=app.state::<RestoreManager>();
    // One private staging handle per document, bounded even after many imports.
    let previous=manager.preview.lock().map_err(|_|"backup-state")?.take();drop(previous);
    for component in &verified.manifest.components {
        if supported(component) {response.supported_components.push(component.id.clone())}
        else {response.unsupported_components.push(component.id.clone())}
    }
    let Some(identity)=identity else {return Ok(response)};
    if crate::remote_control::caller(window,identity).is_err() {return Ok(response)}
    let (runtime,observed)={let shared=app.state::<Shared>();let state=shared.lock().map_err(|_|"backup-state")?;
        if state.ui.phase!=UiPhase::Active || state.ui.snapshot.is_some() {return Ok(response)}
        let Some(runtime)=state.runtime.clone() else {return Ok(response)};
        let Some(storage)=state.storage.as_ref().filter(|s|s.backend_instance==identity.backend_instance) else {return Ok(response)};
        (runtime,storage.roots.clone())};
    if runtime.version.as_ref()!=Some(&verified.manifest.dsh_version) {response.reason_code="backup-restore-version";return Ok(response)}
    if response.supported_components.is_empty() {response.reason_code="backup-component-unsupported";return Ok(response)}
    let roots=resolved(app,&runtime)?;
    if !roots.matches(&observed) {response.reason_code="backup-restore-binding";return Ok(response)}
    let targets=roots.targets().into_iter().filter(|(id,_)|response.supported_components.contains(id)).collect();
    let _profile=if response.supported_components.iter().any(|id|id=="profile-plugins") {
        Some(super::profile_lock::ProfileLease::acquire(&runtime,&helper(app)?,&roots.profile_directory)?)
    } else {None};
    let (before,after,profile_binding)=merge(&runtime,&helper(app)?,&crate::patch_file(app)?,&roots,&verified,&targets)?;
    crate::remote_control::caller(window,identity).map_err(|e|e.message)?;
    let id=uuid::Uuid::new_v4();let expires=crate::maintenance::now_ms()+PREVIEW_TTL;
    *manager.preview.lock().map_err(|_|"backup-state")?=Some(Prepared {id,expires,identity,version:verified.manifest.dsh_version.clone(),_verified:verified,targets,before,after,roots,profile_binding});
    response.can_restore=true;response.restore_handle=Some(id);response.expires_at=Some(expires);response.reason_code="backup-restore-preview";
    Ok(response)
}
#[tauri::command]
pub async fn desktop_backup_restore(window:WebviewWindow,identity:Identity,restore_handle:uuid::Uuid,components:Vec<String>,payload:UiPayload)->Result<(),String> {
    crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
    if components.is_empty() || components.len()>3 || components.iter().any(|id|!matches!(id.as_str(),"desktop-preferences"|"plugin-intent"|"profile-plugins"))
        || components.iter().collect::<std::collections::HashSet<_>>().len()!=components.len() {return Err("backup-component-selection".into())}
    let app=window.app_handle().clone();let lease=app.state::<crate::maintenance::MaintenanceCoordinator>().begin(Kind::Restore)?;
    let shared=app.state::<Shared>().inner().clone();
    let guard={let mut state=shared.lock().map_err(|_|"backup-state")?;
        if state.remote.applying || state.boot_in_progress || state.installer.is_some() || state.ui.phase!=UiPhase::Active || state.ui.snapshot.is_some() {return Err("maintenance-busy".into())}
        state.remote.applying=true;crate::remote_control::ApplyingGuard(shared.clone())};
    tauri::async_runtime::spawn_blocking(move || {
        let manager=app.state::<RestoreManager>();
        let mut prepared={let mut slot=manager.preview.lock().map_err(|_|"backup-state")?;
            let value=slot.as_ref().ok_or("backup-preview-expired")?;
            if value.id!=restore_handle || value.identity!=identity || value.expires<crate::maintenance::now_ms() {return Err("backup-preview-expired".into())}
            if components.iter().any(|id|!value.after.contains_key(id)) {return Err("backup-component-selection".into())}
            slot.take().expect("checked preview")};
        prepared.targets.retain(|id,_|components.contains(id));prepared.before.retain(|id,_|components.contains(id));prepared.after.retain(|id,_|components.contains(id));
        let (runtime,config,source)={let state=shared.lock().map_err(|_|"backup-state")?;
            (state.runtime.clone().ok_or("backup-provider-unavailable")?,state.remote.active.clone().ok_or("backup-provider-unavailable")?,state.ui.identity())};
        if runtime.version.as_ref()!=Some(&prepared.version) || payload.frontend_version!=prepared.version || payload.page.kind!="dsh" {return Err("backup-restore-version".into())}
        let current_roots=resolved(&app,&runtime)?;
        if transaction::fingerprint(&current_roots.targets())!=transaction::fingerprint(&prepared.roots.targets()) {return Err("backup-restore-binding".into())}
        let mut profile_lease=if prepared.targets.contains_key("profile-plugins") {
            Some(super::profile_lock::ProfileLease::acquire(&runtime,&helper(&app)?,&prepared.roots.profile_directory)?)
        } else {None};
        if profile_lease.is_some() {
            let (before,after,binding)=merge(&runtime,&helper(&app)?,&crate::patch_file(&app)?,&prepared.roots,&prepared._verified,&prepared.targets)?;
            if before!=prepared.before {return Err("backup-target-changed".into())}
            if after!=prepared.after || binding!=prepared.profile_binding {return Err("backup-profile-changed".into())}
        }
        // Reject an already stale preview before creating recovery material.
        // The durable transaction checks revisions again under write handles.
        for (id,path) in &prepared.targets {
            if transaction::read_optional(path).map_err(error)?!=prepared.before[id] {return Err("backup-target-changed".into())}
        }
        let lease=lease.durable(&app)?;let progress=lease.progress();
        progress.update(Stage::Capturing,"restore-ui-capture")?;
        let mut snapshot=UiSnapshot::capture(payload,source)?;
        if prepared.targets.contains_key("profile-plugins") {
            let file=prepared._verified.file("components/profile-plugins/data.json").ok_or("backup-provider-invalid")?;
            let value:serde_json::Value=serde_json::from_slice(&std::fs::read(file).map_err(error)?).map_err(|_|"backup-provider-invalid")?;
            snapshot.profile_switches=serde_json::from_value(value["entries"].clone()).map_err(|_|"backup-provider-invalid")?;
        }
        let recovery=crate::recovery_store::persist(&app,&snapshot)?;
        progress.checkpoint(recovery.id,&prepared.version)?;
        let base=directory(&app)?;
        let reserve=prepared.before.values().filter_map(Option::as_ref).map(|bytes|bytes.len() as u64).sum::<u64>()
            +prepared.after.values().map(|bytes|bytes.len() as u64).sum::<u64>()+64*1024;
        ensure_capacity(&base,reserve)?;std::fs::create_dir_all(&base).map_err(error)?;
        let operation=app.state::<crate::maintenance::MaintenanceCoordinator>().status().ok_or("maintenance-stale")?.operation_id;
        let profile_targets=prepared.targets.clone();
        let mut transaction=Transaction::prepare(base.join(operation.to_string()),operation,recovery.id,prepared.targets,prepared.before,prepared.after).map_err(error)?;
        progress.update(Stage::Checkpointing,"configuration-before-images-saved")?;
        crate::remote_control::caller(&window,identity).map_err(|e|e.message)?;
        let process={let mut state=shared.lock().map_err(|_|"backup-state")?;
            if crate::remote_control::identity(&state)!=identity || state.ui.phase!=UiPhase::Active {return Err("backup-preview-expired".into())}
            state.ui.recovery=Some(recovery);state.ui.snapshot=Some(Arc::new(snapshot));state.ui.recovery_lease=Some(lease);
            state.ui.backend_instance+=1;state.remote.active=None;state.ui.loaded=false;
            state.ui.transition(UiPhase::Restoring);state.process.take()};
        let outcome=(|| {
            progress.update(Stage::Committing,"configuration-stop-requested")?;
            if let Some(mut process)=process {process.stop_and_wait().map_err(|_|"backup-backend-stop")?;}
            crate::terminal::suspend(&app);
            if let Some(lease)=profile_lease.as_mut() {
                lease.ensure()?;
                let (_,_,binding)=merge(&runtime,&helper(&app)?,&crate::patch_file(&app)?,&prepared.roots,&prepared._verified,&profile_targets)?;
                if binding!=prepared.profile_binding {return Err("backup-profile-changed".into())}
            }
            transaction.commit().map_err(error)?;
            progress.update(Stage::StartingCandidate,"configuration-committed")?;
            smoke_boundary(&app)?;
            Ok::<_,String>(())
        })();
        if let Err(code)=outcome {
            crate::debug_log(&format!("[backup] restore failed: {code}"));
            if code=="backup-backend-stop" {
                let _=progress.failed("backup-backend-stop");
                crate::fail(&app,&shared,"未能确认后台已停止，配置与恢复材料均已保留。","请退出应用并检查后台进程后重新启动。");
                crate::navigate_current(&app);return Err(code);
            }
            let rolled=transaction.rollback().map_err(error);
            if rolled.is_ok() {let _=progress.update(Stage::RolledBack,"configuration-rolled-back");}
            else {let _=progress.failed("backup-rollback-conflict");}
            if rolled.is_err() {crate::fail(&app,&shared,"配置恢复回退遇到冲突，当前文件和检查点均已保留。","请查看诊断并检查配置文件后重新检测。");crate::navigate_current(&app);return Err(code)}
            drop(profile_lease);crate::restart_backend(&app,&shared,runtime,config);drop(guard);return Err(code);
        }
        *manager.active.lock().map_err(|_|"backup-state")?=Some(Active {transaction,runtime:runtime.clone(),config:config.clone(),profile_lease});
        std::thread::spawn(move || {let _guard=guard;crate::restart_backend(&app,&shared,runtime,config);});
        Ok(())
    }).await.map_err(|_|"backup-worker")?
}
fn ensure_capacity(base:&Path,reserve:u64)->Result<(),String> {
    const MAX_BYTES:u64=448*1024*1024;
    if reserve>MAX_BYTES {return Err("backup-checkpoint-capacity".into())}
    let entries=match std::fs::read_dir(base) {Ok(e)=>e,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(error(e))};
    let mut total=0u64;let mut count=0;
    for entry in entries {
        let path=entry.map_err(error)?.path();count+=1;
        if count>=64 {return Err("backup-checkpoint-capacity".into())}
        let info=std::fs::symlink_metadata(&path).map_err(error)?;
        if !info.is_dir() || info.file_type().is_symlink() {return Err("backup-checkpoint-invalid".into())}
        for item in std::fs::read_dir(path).map_err(error)? {
            let info=std::fs::symlink_metadata(item.map_err(error)?.path()).map_err(error)?;
            if !info.is_file() || info.file_type().is_symlink() {return Err("backup-checkpoint-invalid".into())}
            total=total.checked_add(info.len()).ok_or("backup-checkpoint-capacity")?;
            if total>MAX_BYTES-reserve {return Err("backup-checkpoint-capacity".into())}
        }
    }
    Ok(())
}
/// Called after a full, matching UI ACK and before removing its sole package.
pub(crate) fn acknowledge(app:&AppHandle,checkpoint:uuid::Uuid)->Result<(),String> {
    let manager=app.state::<RestoreManager>();let mut slot=manager.active.lock().map_err(|_|"backup-state")?;
    if let Some(active)=slot.as_mut() {
        if active.transaction.checkpoint_id()!=checkpoint {return Err("backup-transaction-binding".into())}
        if let Some(lease)=active.profile_lease.as_mut() {lease.ensure()?;}
        active.transaction.complete().map_err(error)?;
        slot.take();
    }
    Ok(())
}
pub(crate) fn expects_profile(app:&AppHandle)->bool {
    app.state::<RestoreManager>().active.lock().is_ok_and(|slot|slot.as_ref().is_some_and(|active|active.profile_lease.is_some()))
}
pub(crate) fn smoke_ui_failure(_app:&AppHandle)->bool {
    #[cfg(debug_assertions)]
    if let Some(root)=std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {
        if !_app.state::<RestoreManager>().active.lock().is_ok_and(|slot|slot.is_some()) {return false}
        let path=PathBuf::from(root).join("backup-restore-control.json");
        if let Some(mut value)=std::fs::read(&path).ok().and_then(|bytes|serde_json::from_slice::<serde_json::Value>(&bytes).ok()) {
            if value["failUiRestore"]==true {
                value["failUiRestore"]=false.into();
                return crate::maintenance::atomic_json(&path,&value).is_ok();
            }
        }
    }
    false
}
/// Start one rollback worker after backend or UI failure. The worker retains
/// maintenance ownership and the same semantic UI snapshot throughout restart.
pub(crate) fn rollback_pending(app:&AppHandle)->bool {
    let manager=app.state::<RestoreManager>();let Ok(mut slot)=manager.active.lock() else {return false};
    let Some(mut active)=slot.take() else {return false};drop(slot);
    let app=app.clone();
    std::thread::spawn(move || {
        let shared=app.state::<Shared>().inner().clone();
        let (process,progress)={let Ok(mut state)=shared.lock() else {return};
            if state.ui.phase==UiPhase::Exiting {return}
            state.remote.applying=true;state.ui.backend_instance+=1;state.remote.active=None;state.ui.loaded=false;
            (state.process.take(),state.ui.recovery_lease.as_ref().map(|l|l.progress()))};
        let _guard=crate::remote_control::ApplyingGuard(shared.clone());
        if let Some(progress)=&progress {let _=progress.update(Stage::RollingBack,"configuration-rollback-started");}
        if let Some(mut process)=process {if process.stop_and_wait().is_err() {
            if let Some(progress)=&progress {let _=progress.failed("backup-backend-stop");}
            crate::diagnostics::record(&app,"backup","rollback-stop-failed");
            crate::fail(&app,&shared,"回退前未能确认后台已停止，配置与检查点均已保留。","请退出应用并检查后台进程后重新启动。");
            crate::navigate_current(&app);return;
        }}
        let profile_lock=active.profile_lease.as_mut().map(|lease|lease.ensure()).transpose();
        let result=if profile_lock.is_err() {Err(std::io::Error::new(std::io::ErrorKind::Other,"backup-profile-lock-lost"))} else {active.transaction.rollback()};
        if result.is_err() {
            if let Some(progress)=&progress {let _=progress.failed("backup-rollback-conflict");}
            crate::fail(&app,&shared,"配置回退遇到外部编辑冲突，当前文件和检查点均已保留。","请查看诊断并检查配置文件后重新检测。");crate::navigate_current(&app);return;
        }
        if let Some(progress)=&progress {let _=progress.update(Stage::RolledBack,"configuration-rolled-back");}
        crate::diagnostics::record(&app,"backup","configuration-rolled-back");
        drop(active.profile_lease);crate::restart_backend(&app,&shared,active.runtime,active.config);
    });
    true
}
/// Before starting any backend, resolve logical roots using that runtime and
/// roll back only exact known versions. Conflicting external edits block boot.
pub(crate) fn recover_interrupted(app:&AppHandle,runtime:&Runtime)->Result<(),String> {
    let base=directory(app)?;
    let entries=match std::fs::read_dir(&base) {Ok(e)=>e,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(error(e))};
    let mut roots=None;let mut count=0;
    for entry in entries {
        let entry=entry.map_err(error)?;count+=1;if count>64 {return Err("backup-checkpoint-capacity".into())}
        if entry.file_name().to_string_lossy().starts_with(".prepare-") {continue}
        if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {return Err("backup-checkpoint-invalid".into())}
        let ids=Transaction::component_ids(&entry.path()).map_err(error)?;
        if roots.is_none() {roots=Some(resolved(app,runtime)?)}
        let targets=roots.as_ref().unwrap().targets().into_iter().filter(|(id,_)|ids.contains(id)).collect();
        let mut transaction=Transaction::load(entry.path(),targets).map_err(error)?;
        if transaction.operation_id().to_string()!=entry.file_name().to_string_lossy() {return Err("backup-transaction-binding".into())}
        if transaction.stage()=="complete" {continue}
        let journals=crate::maintenance::directory(app)?;
        let path=journals.join(format!("{}.json",transaction.operation_id()));
        let mut journal=crate::maintenance::OperationJournal::load(&path).map_err(|_|"maintenance-journal-save-failed")?;
        if journal.checkpoint_id!=Some(transaction.checkpoint_id()) {return Err("backup-transaction-binding".into())}
        if journal.operation_id!=transaction.operation_id() || journal.kind!=Kind::Restore {return Err("backup-transaction-binding".into())}
        if transaction.stage()=="rolled-back" && journal.stage==Stage::RolledBack {continue}
        let _profile=if ids.iter().any(|id|id=="profile-plugins") {
            Some(super::profile_lock::ProfileLease::acquire(runtime,&helper(app)?,&roots.as_ref().unwrap().profile_directory)?)
        } else {None};
        transaction.rollback().map_err(error)?;
        journal.stage=Stage::RolledBack;journal.updated_at=crate::maintenance::now_ms().max(journal.updated_at);
        journal.completed_steps.push("cold-configuration-rollback".into());journal.save(&journals).map_err(|_|"maintenance-journal-save-failed")?;
        crate::diagnostics::record(app,"backup","cold-configuration-rollback");
    }
    Ok(())
}
fn smoke_boundary(_app:&AppHandle)->Result<(),String> {
    #[cfg(debug_assertions)]
    if let Some(root)=std::env::var_os("DSH_DESKTOP_SMOKE_DIR") {
        let path=PathBuf::from(root).join("backup-restore-control.json");
        let control=std::fs::read(&path).ok().and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok());
        if control.as_ref().is_some_and(|c|c["failAfterCommit"]==true) {return Err("backup-smoke-after-commit".into())}
        if control.as_ref().is_some_and(|c|c["pauseAfterCommit"]==true) {
            let start=std::time::Instant::now();
            while start.elapsed()<std::time::Duration::from_secs(30) && std::fs::read(&path).ok().and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).is_some_and(|c|c["pauseAfterCommit"]==true) {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_budget_reserves_the_new_transaction_without_evicting_history() {
        let root=tempfile::tempdir().unwrap();let history=root.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&history).unwrap();std::fs::write(history.join("checkpoint"),b"old").unwrap();
        assert!(ensure_capacity(root.path(),448*1024*1024-3).is_ok());
        assert_eq!(ensure_capacity(root.path(),448*1024*1024-2).unwrap_err(),"backup-checkpoint-capacity");
        assert_eq!(std::fs::read(history.join("checkpoint")).unwrap(),b"old");
    }
}
