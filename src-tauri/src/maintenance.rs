//! Versioned maintenance records. Acquire coordinator before AppState; never
//! hold AppState across disk IO or a child-process wait.
use std::{io::{self, Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde::{Deserialize, Serialize};

pub const SCHEMA: u32 = 1;
pub const MAX_JOURNAL_BYTES: u64 = 256 * 1024;
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind { Update, Restore, Rollback, Backup, Diagnostics, Restart, Install, UiLifecycle }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Stage { Preparing, WaitingIdle, Capturing, Checkpointing, StartingCandidate, Restoring, Committing, RollingBack, RolledBack, Complete, Resolved, RecoveryRequired }
impl Stage {
    pub fn terminal(&self) -> bool { matches!(self, Self::Complete | Self::RolledBack | Self::Resolved) }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationJournal {
    pub schema: u32,
    pub operation_id: uuid::Uuid,
    pub kind: Kind,
    pub stage: Stage,
    pub created_at: u64,
    pub updated_at: u64,
    pub source_runtime: Option<String>,
    pub target_runtime: Option<String>,
    pub checkpoint_id: Option<uuid::Uuid>,
    pub completed_steps: Vec<String>,
    pub error_code: Option<String>,
    pub recovery_actions: Vec<String>,
}
impl OperationJournal {
    pub fn new(kind: Kind) -> Self {
        let now = now_ms();
        Self { schema: SCHEMA, operation_id: uuid::Uuid::new_v4(), kind, stage: Stage::Preparing, created_at: now, updated_at: now, source_runtime: None, target_runtime: None, checkpoint_id: None, completed_steps: vec![], error_code: None, recovery_actions: vec![] }
    }
    pub fn save(&self, directory: &Path) -> io::Result<()> {
        self.validate()?;
        atomic_json(&directory.join(format!("{}.json", self.operation_id)), self)
    }
    fn validate(&self) -> io::Result<()> {
        // Journal strings are identifiers, never raw stderr, tokens, or paths.
        let ids = self.source_runtime.iter().chain(self.target_runtime.iter()).chain(self.completed_steps.iter()).chain(self.error_code.iter()).chain(self.recovery_actions.iter());
        if self.schema != SCHEMA || self.completed_steps.len() > 128 || self.recovery_actions.len() > 16 || self.updated_at < self.created_at || ids.into_iter().any(|id| id.is_empty() || id.len() > 160 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "maintenance-journal-schema"));
        }
        Ok(())
    }
    pub fn load(path: &Path) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_JOURNAL_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "maintenance-journal-size")); }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "maintenance-journal-size")); }
        let journal: Self = serde_json::from_slice(&bytes)?;
        journal.validate()?;
        Ok(journal)
    }
}
pub fn atomic_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing-parent"))?;
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    // A diagnostic reader or antivirus may briefly deny delete sharing on
    // Windows. Retry the same flushed temp file; never rewrite the destination.
    for attempt in 0..10 {
        match file.persist(path) {
            Ok(_)=>return Ok(()),
            Err(error) if attempt<9 && matches!(error.error.raw_os_error(),Some(5|32|33))=> {
                file=error.file;std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error)=>return Err(error.error),
        }
    }
    unreachable!()
}

#[derive(Default, Clone)]
pub struct MaintenanceCoordinator(Arc<Mutex<Option<OperationJournal>>>);
pub struct Lease { progress: Progress }
/// A progress reference does not own the lease. Call only outside AppState.
#[derive(Clone)]
pub struct Progress { coordinator: MaintenanceCoordinator, id: uuid::Uuid, directory: Option<PathBuf> }
impl MaintenanceCoordinator {
    pub fn begin(&self, kind: Kind) -> Result<Lease, String> {
        let mut active = self.0.lock().map_err(|_| "maintenance-state")?;
        if active.is_some() { return Err("maintenance-busy".into()); }
        let journal = OperationJournal::new(kind);
        let id = journal.operation_id;
        *active = Some(journal);
        Ok(Lease { progress: Progress { coordinator: self.clone(), id, directory: None } })
    }
    pub fn status(&self) -> Option<OperationJournal> { self.0.lock().ok()?.clone() }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Leave the last durable record intact on failure/exit. Never do disk
        // IO in Drop, which can run while AppState is being torn down.
        if let Ok(mut active) = self.progress.coordinator.0.lock() {
            if active.as_ref().is_some_and(|journal| journal.operation_id == self.progress.id) { *active = None; }
        }
    }
}
impl Lease {
    pub fn durable(mut self, app: &tauri::AppHandle) -> Result<Self, String> {
        self.progress.directory = Some(directory(app)?);
        self.progress.update(Stage::Preparing, "operation-started")?;
        Ok(self)
    }
    pub fn progress(&self) -> Progress { self.progress.clone() }
}
impl Progress {
    fn edit(&self, edit: impl FnOnce(&mut OperationJournal)) -> Result<(), String> {
        let mut active = self.coordinator.0.lock().map_err(|_| "maintenance-state")?;
        let mut journal = active.as_ref().filter(|j| j.operation_id == self.id).ok_or("maintenance-stale")?.clone();
        edit(&mut journal);
        journal.updated_at = now_ms().max(journal.updated_at);
        journal.validate().map_err(|_| "maintenance-journal-schema")?;
        if let Some(directory) = &self.directory { journal.save(directory).map_err(|_| "maintenance-journal-save-failed")?; }
        *active = Some(journal);
        Ok(())
    }
    pub fn update(&self, stage: Stage, step: &str) -> Result<(), String> {
        self.edit(|j| { j.stage = stage; if !j.completed_steps.iter().any(|s| s == step) { j.completed_steps.push(step.into()); } })
    }
    pub fn checkpoint(&self, id: uuid::Uuid, source: &str) -> Result<(), String> {
        self.edit(|j| { j.checkpoint_id = Some(id); j.source_runtime = Some(source.into()); j.recovery_actions = vec!["restore-unsaved-content".into(), "open-diagnostics".into()]; })
    }
    pub fn target(&self, version: &str) -> Result<(), String> { self.edit(|j| j.target_runtime = Some(version.into())) }
    pub fn failed(&self, code: &str) -> Result<(), String> {
        self.edit(|j| { j.stage = Stage::RecoveryRequired; j.error_code = Some(code.into()); if j.recovery_actions.is_empty() { j.recovery_actions.push("open-diagnostics".into()); } })
    }
    pub fn complete(&self) -> Result<(), String> {
        self.edit(|j| { if j.stage != Stage::RolledBack {j.stage = Stage::Complete;} j.completed_steps.push("ui-restored".into()); j.error_code = None; j.recovery_actions.clear(); })
    }
    pub fn prepared(&self) -> Result<(),String> {
        self.edit(|j| {j.stage=Stage::Complete;j.completed_steps.push("candidate-prepared-only".into());j.error_code=None;j.recovery_actions.clear();})
    }
    pub fn backend_ready(&self) -> Result<(), String> {
        self.edit(|j| {if j.stage!=Stage::RolledBack {j.stage=Stage::Restoring;} if !j.completed_steps.iter().any(|s|s=="backend-ready") {j.completed_steps.push("backend-ready".into());}})
    }
}
pub fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("DSH_DESKTOP_SMOKE_DIR") { return Ok(PathBuf::from(root).join("maintenance/operations")); }
    Ok(app.path().app_data_dir().map_err(|_| "maintenance-directory")?.join("maintenance/operations"))
}
/// Resolving recovered UI does not imply that an interrupted update succeeded.
/// Only records referring to the acknowledged package can be resolved.
pub fn resolve_checkpoint(directory: &Path, checkpoint: uuid::Uuid) -> io::Result<()> {
    let entries = match std::fs::read_dir(directory) { Ok(entries) => entries, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()), Err(e) => return Err(e) };
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Ok(mut journal) = OperationJournal::load(&entry.path()) else { continue };
        if journal.stage.terminal() || journal.checkpoint_id != Some(checkpoint) { continue; }
        // Reject renamed records instead of creating a second authoritative file.
        if entry.file_name().to_str() != Some(format!("{}.json", journal.operation_id).as_str()) { continue; }
        journal.stage = Stage::Resolved;
        journal.updated_at = now_ms().max(journal.updated_at);
        journal.completed_steps.push("ui-recovery-acknowledged".into());
        journal.recovery_actions.clear();
        journal.save(directory)?;
    }
    Ok(())
}
pub fn audit_interrupted(directory: &Path) -> io::Result<()> {
    let entries = match std::fs::read_dir(directory) { Ok(entries) => entries, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()), Err(e) => return Err(e) };
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Ok(mut journal) = OperationJournal::load(&entry.path()) else { continue };
        if journal.stage.terminal() || journal.error_code.is_some() { continue; }
        if entry.file_name().to_str() != Some(format!("{}.json", journal.operation_id).as_str()) { continue; }
        journal.error_code = Some("maintenance-interrupted".into());
        journal.updated_at = now_ms().max(journal.updated_at);
        journal.recovery_actions = if journal.checkpoint_id.is_some() { vec!["restore-unsaved-content".into(), "open-diagnostics".into()] } else { vec!["open-diagnostics".into()] };
        journal.save(directory)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn durable_test_lease(coordinator: &MaintenanceCoordinator, directory: &Path) -> Lease {
        let mut lease = coordinator.begin(Kind::Restart).unwrap();
        lease.progress.directory = Some(directory.into());
        lease.progress.update(Stage::Preparing, "operation-started").unwrap();
        lease
    }
    #[test]
    fn durable_owner_survives_progress_handoff_and_interruption_is_not_success() {
        let directory = tempfile::tempdir().unwrap();
        let coordinator = MaintenanceCoordinator::default();
        let lease = durable_test_lease(&coordinator, directory.path());
        let progress = lease.progress();
        let checkpoint = uuid::Uuid::new_v4();
        progress.checkpoint(checkpoint, "0.2.1-rc.2").unwrap();
        progress.update(Stage::Restoring, "backend-ready").unwrap();
        assert!(coordinator.begin(Kind::Update).is_err());
        let id = coordinator.status().unwrap().operation_id;
        drop(lease);
        assert!(progress.complete().is_err());
        audit_interrupted(directory.path()).unwrap();
        let record = OperationJournal::load(&directory.path().join(format!("{id}.json"))).unwrap();
        assert_eq!(record.stage, Stage::Restoring);
        assert_eq!(record.error_code.as_deref(), Some("maintenance-interrupted"));
        resolve_checkpoint(directory.path(), uuid::Uuid::new_v4()).unwrap();
        assert!(!OperationJournal::load(&directory.path().join(format!("{id}.json"))).unwrap().stage.terminal());
        resolve_checkpoint(directory.path(), checkpoint).unwrap();
        let resolved = OperationJournal::load(&directory.path().join(format!("{id}.json"))).unwrap();
        assert_eq!(resolved.stage, Stage::Resolved);
        assert_eq!(resolved.error_code.as_deref(), Some("maintenance-interrupted"));
    }
    #[test]
    fn failed_save_does_not_advance_status_or_destroy_last_record() {
        let directory = tempfile::tempdir().unwrap();
        let coordinator = MaintenanceCoordinator::default();
        let mut lease = durable_test_lease(&coordinator, directory.path());
        let id = coordinator.status().unwrap().operation_id;
        let blocked = directory.path().join("file");
        std::fs::write(&blocked, "not a directory").unwrap();
        lease.progress.directory = Some(blocked);
        assert!(lease.progress.update(Stage::StartingCandidate, "ready").is_err());
        assert_eq!(coordinator.status().unwrap().stage, Stage::Preparing);
        assert_eq!(OperationJournal::load(&directory.path().join(format!("{id}.json"))).unwrap().stage, Stage::Preparing);
        assert!(lease.progress.failed("stderr with token=secret").is_err());
    }
    #[test]
    fn replacement_and_crash_records_preserve_the_last_durable_stage() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = OperationJournal::new(Kind::Update);
        journal.save(directory.path()).unwrap();
        journal.stage = Stage::StartingCandidate;
        journal.checkpoint_id = Some(uuid::Uuid::new_v4());
        journal.save(directory.path()).unwrap();
        let loaded = OperationJournal::load(&directory.path().join(format!("{}.json", journal.operation_id))).unwrap();
        assert_eq!(loaded.stage, Stage::StartingCandidate);
        assert_eq!(loaded.checkpoint_id, journal.checkpoint_id);
        assert!(!loaded.stage.terminal());
        journal.error_code = Some("http://local/?token=private".into());
        assert!(journal.save(directory.path()).is_err());
        assert_eq!(OperationJournal::load(&directory.path().join(format!("{}.json", journal.operation_id))).unwrap().stage, Stage::StartingCandidate);
    }
    #[test]
    fn competing_operations_fail_without_waiting_and_release_after_error() {
        let coordinator = MaintenanceCoordinator::default();
        let lease = coordinator.begin(Kind::Restore).unwrap();
        assert!(coordinator.begin(Kind::Update).is_err());
        drop(lease);
        assert!(coordinator.begin(Kind::Update).is_ok());
    }
    #[test]
    fn candidate_preparation_records_completion_without_claiming_ui_restore() {
        let tmp=tempfile::tempdir().unwrap();let coordinator=MaintenanceCoordinator::default();
        let lease=durable_test_lease(&coordinator,tmp.path());let progress=lease.progress();
        progress.target("1.2.3+build.1").unwrap();progress.prepared().unwrap();
        let journal=coordinator.status().unwrap();assert_eq!(journal.stage,Stage::Complete);
        assert!(journal.completed_steps.iter().any(|s|s=="candidate-prepared-only"));
        assert!(!journal.completed_steps.iter().any(|s|s=="ui-restored"));assert!(journal.checkpoint_id.is_none());
    }
    #[test]
    #[cfg(windows)]
    fn atomic_record_retries_a_short_windows_reader_and_preserves_original_on_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp=tempfile::tempdir().unwrap();let path=tmp.path().join("record.json");
        atomic_json(&path,&serde_json::json!({"value":"before"})).unwrap();
        let reader=std::fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        let release=std::thread::spawn(move || {std::thread::sleep(std::time::Duration::from_millis(100));drop(reader);});
        atomic_json(&path,&serde_json::json!({"value":"after"})).unwrap();release.join().unwrap();
        let reader=std::fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        assert!(atomic_json(&path,&serde_json::json!({"value":"rejected"})).is_err());
        drop(reader);assert_eq!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap()["value"],"after");
    }
}
