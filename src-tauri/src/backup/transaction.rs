//! Durable configuration before-images. Targets always come from the host;
//! checkpoints contain logical ids and fingerprints, never restore destinations.
use std::{collections::{BTreeMap, HashSet}, fs::{File, OpenOptions}, io::{self, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_FILE: u64 = 10 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileId { volume: u32, index: u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Item {
    id: String,
    before: Option<String>,
    after: String,
    parents: Vec<FileId>,
    before_id: Option<FileId>,
    write_id: Option<FileId>,
    intent: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Record {
    schema: u32,
    operation_id: uuid::Uuid,
    checkpoint_id: uuid::Uuid,
    binding: String,
    stage: String,
    items: Vec<Item>,
}
pub struct Transaction { directory: PathBuf, record: Record, targets: BTreeMap<String, PathBuf> }
fn invalid(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, code) }
pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn fingerprint(targets: &BTreeMap<String, PathBuf>) -> String {
    let value: Vec<_> = targets.iter().map(|(id,path)| (id,path.to_string_lossy().replace('/',"\\").trim_start_matches("\\\\?\\").to_lowercase())).collect();
    hash(&serde_json::to_vec(&value).expect("path serialization"))
}
fn digest(value: &str) -> bool { value.len()==64 && value.bytes().all(|b| b.is_ascii_hexdigit()) }
#[cfg(windows)]
fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION}};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(io::Error::other)?;
    if info.dwFileAttributes & 0x400 != 0 || info.nNumberOfLinks > 1 { return Err(invalid("backup-target-link")); }
    Ok(FileId { volume: info.dwVolumeSerialNumber, index: ((info.nFileIndexHigh as u64)<<32) | info.nFileIndexLow as u64 })
}
#[cfg(not(windows))]
fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    let info = file.metadata()?;
    if info.is_file() && info.nlink()>1 { return Err(invalid("backup-target-link")); }
    Ok(FileId { volume: info.dev() as u32, index: info.ino() })
}
fn options(write: bool, directory: bool) -> OpenOptions {
    let mut options = OpenOptions::new(); options.read(true).write(write);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself, and freeze ancestor renames. Writer
        // handles deny competing writes/replacements and may delete owned creates.
        options.custom_flags(0x00200000 | if directory {0x02000000} else {0});
        options.share_mode(if directory {3} else if write {1} else {3});
        if write { options.access_mode(0x80000000 | 0x40000000 | 0x00010000); }
    }
    options
}
struct Parents { _handles: Vec<File>, ids: Vec<FileId> }
fn parents(path: &Path) -> io::Result<Parents> {
    if !path.is_absolute() || path.components().any(|c| matches!(c,std::path::Component::ParentDir|std::path::Component::CurDir)) {
        return Err(invalid("backup-target-invalid"));
    }
    let parent = path.parent().ok_or_else(||invalid("backup-target-invalid"))?;
    let mut paths: Vec<_> = parent.ancestors().filter(|p| p.is_absolute()).collect(); paths.reverse();
    let mut handles = Vec::new(); let mut ids = Vec::new();
    for path in paths {
        let info = std::fs::symlink_metadata(path)?;
        if !info.is_dir() || info.file_type().is_symlink() {return Err(invalid("backup-target-link"))}
        let handle = options(false,true).open(path)?;
        if !handle.metadata()?.is_dir() {return Err(invalid("backup-target-invalid"))}
        ids.push(file_id(&handle)?); handles.push(handle);
    }
    Ok(Parents {_handles:handles,ids})
}
fn bytes(file: &mut File) -> io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() || file.metadata()?.len()>MAX_FILE {return Err(invalid("backup-target-invalid"))}
    file.seek(SeekFrom::Start(0))?;
    let mut value=Vec::new(); Read::by_ref(file).take(MAX_FILE+1).read_to_end(&mut value)?;
    if value.len() as u64>MAX_FILE {return Err(invalid("backup-target-invalid"))}
    Ok(value)
}
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let _parents = parents(path)?;
    match options(false,false).open(path) {
        Err(e) if e.kind()==io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
        Ok(mut file) => { file_id(&file)?; Ok(Some(bytes(&mut file)?)) }
    }
}
/// A helper may only inspect this manifest. In particular upstream legacy
/// normalization must fail instead of mutating files during restore preview.
pub(super) struct ReadGuard { _parents: Parents, _file: File }
pub(super) fn protect_readonly(path: &Path) -> io::Result<ReadGuard> {
    let guard=parents(path)?;
    let mut options=options(false,false);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file=options.open(path)?;file_id(&file)?;
    Ok(ReadGuard {_parents:guard,_file:file})
}
fn checkpoint(path: &Path, value: &[u8]) -> io::Result<()> {
    let mut file=OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(value)?; file.sync_all()
}
fn replace(file: &mut File, value: &[u8]) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?; file.write_all(value)?; file.set_len(value.len() as u64)?; file.sync_all()
}
fn delete_owned(file: &File, path: &Path) -> io::Result<()> {
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{SetFileInformationByHandle,FileDispositionInfo,FILE_DISPOSITION_INFO}};
        let info=FILE_DISPOSITION_INFO {DeleteFile:true};
        let _=path;
        unsafe {SetFileInformationByHandle(HANDLE(file.as_raw_handle()),FileDispositionInfo,&info as *const _ as *const _,std::mem::size_of_val(&info) as u32)}.map_err(io::Error::other)
    }
    #[cfg(not(windows))] { let _=file; std::fs::remove_file(path) }
}
impl Transaction {
    pub fn component_ids(directory: &Path) -> io::Result<Vec<String>> {
        let data=read_optional(&directory.join("transaction.json"))?.ok_or_else(||invalid("backup-transaction-missing"))?;
        if data.len()>64*1024 {return Err(invalid("backup-transaction-invalid"))}
        let record:Record=serde_json::from_slice(&data).map_err(|_|invalid("backup-transaction-invalid"))?;
        if record.schema!=1 || record.items.is_empty() || record.items.len()>3 || record.items.iter().any(|i|!super::known(&i.id)) {
            return Err(invalid("backup-transaction-invalid"));
        }
        Ok(record.items.into_iter().map(|i|i.id).collect())
    }
    pub fn prepare(directory: PathBuf, operation_id: uuid::Uuid, checkpoint_id: uuid::Uuid, targets: BTreeMap<String,PathBuf>, before: BTreeMap<String,Option<Vec<u8>>>, after: BTreeMap<String,Vec<u8>>) -> io::Result<Self> {
        if targets.is_empty() || targets.len()>3 || targets.len()!=after.len() || targets.len()!=before.len()
            || targets.keys().any(|id| !super::known(id)||!after.contains_key(id)||!before.contains_key(id))
            || targets.values().map(|p|p.to_string_lossy().to_lowercase()).collect::<HashSet<_>>().len()!=targets.len() {
            return Err(invalid("backup-component-selection"));
        }
        // Precheck all components before creating any checkpoint or target.
        let mut guards=Vec::new();
        for (id,path) in &targets {
            guards.push(parents(path)?);
            if read_optional(path)?!=before[id] || after[id].len() as u64>MAX_FILE {return Err(invalid("backup-target-changed"))}
        }
        let destination=directory;
        let staging=tempfile::Builder::new().prefix(".prepare-").tempdir_in(destination.parent().ok_or_else(||invalid("backup-directory"))?)?;
        let directory=staging.path().to_path_buf();
        let mut record=Record {schema:1,operation_id,checkpoint_id,binding:fingerprint(&targets),stage:"prepared".into(),items:vec![]};
        for ((id,path),guard) in targets.iter().zip(&guards) {
            let before_id=if before[id].is_some() {Some(file_id(&options(false,false).open(path)?)?)} else {None};
            if let Some(value)=&before[id] {checkpoint(&directory.join(format!("{id}.before")),value)?;}
            checkpoint(&directory.join(format!("{id}.after")),&after[id])?;
            record.items.push(Item {id:id.clone(),before:before[id].as_ref().map(|v|hash(v)),after:hash(&after[id]),parents:guard.ids.clone(),before_id,write_id:None,intent:false});
        }
        let mut transaction=Self {directory,record,targets}; transaction.save()?;
        std::fs::rename(staging.path(),&destination)?;
        transaction.directory=destination;
        Ok(transaction)
    }
    pub fn load(directory: PathBuf, targets: BTreeMap<String,PathBuf>) -> io::Result<Self> {
        let data=read_optional(&directory.join("transaction.json"))?.ok_or_else(||invalid("backup-transaction-missing"))?;
        if data.len()>64*1024 {return Err(invalid("backup-transaction-invalid"))}
        let record:Record=serde_json::from_slice(&data).map_err(|_|invalid("backup-transaction-invalid"))?;
        if record.schema!=1 || record.binding!=fingerprint(&targets) || record.items.is_empty() || record.items.len()>3 || record.items.len()!=targets.len()
            || !matches!(record.stage.as_str(),"prepared"|"committing"|"restoring"|"complete"|"rolling-back"|"rolled-back") {
            return Err(invalid("backup-transaction-binding"));
        }
        let mut seen=HashSet::new();
        for item in &record.items {
            if !super::known(&item.id) || !targets.contains_key(&item.id) || !seen.insert(&item.id) || !digest(&item.after)
                || item.before.as_ref().is_some_and(|v|!digest(v)) || item.parents.len()>128
                || item.before.is_some()!=item.before_id.is_some() || parents(&targets[&item.id])?.ids!=item.parents {
                return Err(invalid("backup-transaction-binding"));
            }
            for (suffix,expected) in [("before",item.before.as_ref()),("after",Some(&item.after))] {
                if let Some(expected)=expected {
                    if hash(&read_optional(&directory.join(format!("{}.{suffix}",item.id)))?.ok_or_else(||invalid("backup-checkpoint-missing"))?)!=*expected {
                        return Err(invalid("backup-checkpoint-integrity"));
                    }
                }
            }
        }
        Ok(Self {directory,record,targets})
    }
    fn save(&self) -> io::Result<()> {crate::maintenance::atomic_json(&self.directory.join("transaction.json"),&self.record)}
    pub fn commit(&mut self) -> io::Result<()> {
        if self.record.stage!="prepared" {return Err(invalid("backup-transaction-stage"))}
        let mut guards=Vec::new();let mut handles:Vec<Option<File>>=Vec::new();
        // Existing targets are all acquired and verified before absent files
        // are created. A later precheck error cannot leave a new empty file.
        for item in &self.record.items {
            let guard=parents(&self.targets[&item.id])?;
            if guard.ids!=item.parents {return Err(invalid("backup-target-changed"))}
            let handle=if let Some(expected)=&item.before {
                let mut file=options(true,false).open(&self.targets[&item.id])?;
                if Some(file_id(&file)?)!=item.before_id || hash(&bytes(&mut file)?)!=*expected {return Err(invalid("backup-target-changed"))}
                Some(file)
            } else {
                if read_optional(&self.targets[&item.id])?.is_some() {return Err(invalid("backup-target-changed"))}
                None
            };
            guards.push(guard);handles.push(handle);
        }
        self.record.stage="committing".into();self.save()?;
        let result=(|| {
            for (index,handle) in handles.iter_mut().enumerate() {
                if handle.is_none() {
                    self.record.items[index].intent=true; self.save()?;
                    let file=options(true,false).create_new(true).open(&self.targets[&self.record.items[index].id])?;
                    self.record.items[index].write_id=Some(file_id(&file)?);
                    *handle=Some(file); self.save()?;
                }
            }
            for (index,handle) in handles.iter_mut().enumerate() {
                let file=handle.as_mut().expect("acquired target");
                self.record.items[index].write_id=Some(file_id(file)?);
                self.record.items[index].intent=true; self.save()?;
                let item=&self.record.items[index];
                let value=read_optional(&self.directory.join(format!("{}.after",item.id)))?.ok_or_else(||invalid("backup-checkpoint-missing"))?;
                if hash(&value)!=item.after {return Err(invalid("backup-checkpoint-integrity"))}
                replace(file,&value)?;
            }
            self.record.stage="restoring".into(); self.save()
        })();
        if result.is_err() {
            if let Err(error)=&result {crate::debug_log(&format!("[backup] commit failed: {error}"));}
            // These handles still exclude writers, so an incomplete write can
            // be rolled back without mistaking external bytes for our own.
            self.record.stage="rolling-back".into();let _=self.save();
            let restored=self.restore_locked(&mut handles);
            if restored.is_ok() {self.record.stage="rolled-back".into();self.save()?;}
        }
        result
    }
    fn restore_locked(&self, handles: &mut [Option<File>]) -> io::Result<()> {
        for (item,handle) in self.record.items.iter().zip(handles) {
            if !item.intent {continue}
            let Some(file)=handle else {continue};
            match &item.before {
                Some(expected) => {
                    let value=read_optional(&self.directory.join(format!("{}.before",item.id)))?.ok_or_else(||invalid("backup-checkpoint-missing"))?;
                    if hash(&value)!=*expected {return Err(invalid("backup-checkpoint-integrity"))}
                    replace(file,&value)?;
                },
                None => delete_owned(file,&self.targets[&item.id])?,
            }
        }
        Ok(())
    }
    pub fn rollback(&mut self) -> io::Result<()> {
        if matches!(self.record.stage.as_str(),"complete"|"rolled-back") {return Ok(())}
        let mut guards=Vec::new();let mut handles=Vec::new();
        // Only touched files participate. Unknown external versions are kept,
        // with a private quarantine copy, and block all rollback writes.
        for item in &self.record.items {
            let path=&self.targets[&item.id];let guard=parents(path)?;
            if guard.ids!=item.parents {return Err(invalid("backup-target-changed"))}
            guards.push(guard);
            if !item.intent {handles.push(None);continue}
            let mut file=match options(true,false).open(path) {
                Err(e) if e.kind()==io::ErrorKind::NotFound && item.before.is_none()=>{handles.push(None);continue},
                other=>other?,
            };
            let current=bytes(&mut file)?;let current_hash=hash(&current);
            if item.before.as_ref()==Some(&current_hash) {handles.push(None);continue}
            if Some(file_id(&file)?)!=item.write_id || current_hash!=item.after && !(item.before.is_none()&&current.is_empty()&&item.write_id.is_some()) {
                checkpoint(&self.directory.join(format!("{}-{}.quarantine",item.id,uuid::Uuid::new_v4())),&current)?;
                return Err(invalid("backup-rollback-conflict"));
            }
            handles.push(Some(file));
        }
        self.record.stage="rolling-back".into();self.save()?;
        self.restore_locked(&mut handles)?;
        self.record.stage="rolled-back".into();self.save()
    }
    pub fn complete(&mut self) -> io::Result<()> {
        if self.record.stage!="restoring" {return Err(invalid("backup-transaction-stage"))}
        self.record.stage="complete".into();
        if let Err(e)=self.save() {self.record.stage="restoring".into();return Err(e)}
        Ok(())
    }
    pub fn stage(&self) -> &str {&self.record.stage}
    pub fn checkpoint_id(&self) -> uuid::Uuid {self.record.checkpoint_id}
    pub fn operation_id(&self) -> uuid::Uuid {self.record.operation_id}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepare(root:&Path,targets:BTreeMap<String,PathBuf>) -> Transaction {
        let before=targets.iter().map(|(id,path)|(id.clone(),read_optional(path).unwrap())).collect();
        let after=targets.keys().map(|id|(id.clone(),b"new".to_vec())).collect();
        Transaction::prepare(root.join("checkpoint"),uuid::Uuid::new_v4(),uuid::Uuid::new_v4(),targets,before,after).unwrap()
    }
    #[test]
    fn profile_three_component_cold_rollback_keeps_all_before_images() {
        let root=tempfile::tempdir().unwrap();
        let mut targets=BTreeMap::new();
        for id in ["desktop-preferences","plugin-intent","profile-plugins"] {
            let path=root.path().join(format!("{id}.json"));std::fs::write(&path,id).unwrap();targets.insert(id.into(),path);
        }
        let mut transaction=prepare(root.path(),targets.clone());transaction.commit().unwrap();drop(transaction);
        let mut transaction=Transaction::load(root.path().join("checkpoint"),targets.clone()).unwrap();transaction.rollback().unwrap();
        for (id,path) in targets {assert_eq!(std::fs::read_to_string(path).unwrap(),id);}
    }
    #[cfg(windows)]
    #[test]
    fn profile_readonly_manifest_denies_preview_normalization_and_external_replacement() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("package.json");std::fs::write(&path,b"original").unwrap();
        let guard=protect_readonly(&path).unwrap();
        assert!(std::fs::write(&path,b"normalized").is_err());
        assert!(std::fs::rename(&path,root.path().join("moved.json")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(),b"original");
        drop(guard);std::fs::write(&path,b"explicit edit").unwrap();
    }
    #[test]
    fn cold_rollback_restores_known_versions_and_removes_owned_creates() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("settings.json");std::fs::write(&path,"old").unwrap();
        let missing=root.path().join("plugins.json");
        let targets=BTreeMap::from([("desktop-preferences".into(),path.clone()),("plugin-intent".into(),missing.clone())]);
        let mut transaction=prepare(root.path(),targets.clone());transaction.commit().unwrap();drop(transaction);
        let mut transaction=Transaction::load(root.path().join("checkpoint"),targets).unwrap();transaction.rollback().unwrap();
        assert_eq!(std::fs::read(path).unwrap(),b"old");assert!(!missing.exists());assert_eq!(transaction.stage(),"rolled-back");
    }
    #[test]
    fn external_edits_are_preserved_and_block_all_rollback_writes() {
        let root=tempfile::tempdir().unwrap();let a=root.path().join("a");let b=root.path().join("b");
        std::fs::write(&a,"old").unwrap();std::fs::write(&b,"old").unwrap();
        let targets=BTreeMap::from([("desktop-preferences".into(),a.clone()),("plugin-intent".into(),b.clone())]);
        let mut transaction=prepare(root.path(),targets.clone());transaction.commit().unwrap();std::fs::write(&b,"external").unwrap();
        assert_eq!(transaction.rollback().unwrap_err().to_string(),"backup-rollback-conflict");
        assert_eq!(std::fs::read(&a).unwrap(),b"new");assert_eq!(std::fs::read(&b).unwrap(),b"external");
        assert!(std::fs::read_dir(root.path().join("checkpoint")).unwrap().any(|e|e.unwrap().path().extension().is_some_and(|e|e=="quarantine")));
    }
    #[test]
    fn precheck_leaves_missing_files_absent_and_cannot_restore_into_other_roots() {
        let root=tempfile::tempdir().unwrap();let missing=root.path().join("missing");let path=root.path().join("settings");std::fs::write(&path,"old").unwrap();
        let targets=BTreeMap::from([("desktop-preferences".into(),missing.clone()),("plugin-intent".into(),path.clone())]);
        let mut transaction=prepare(root.path(),targets);std::fs::write(&path,"changed").unwrap();
        assert!(transaction.commit().is_err());assert!(!missing.exists());transaction.rollback().unwrap();assert_eq!(std::fs::read(&path).unwrap(),b"changed");
        assert!(Transaction::load(root.path().join("checkpoint"),BTreeMap::from([("desktop-preferences".into(),root.path().join("other"))])).is_err());
    }
    #[test]
    fn changed_checkpoint_bytes_fail_integrity_before_active_file_writes() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("settings");std::fs::write(&path,"old").unwrap();
        let targets=BTreeMap::from([("desktop-preferences".into(),path.clone())]);let transaction=prepare(root.path(),targets.clone());drop(transaction);
        std::fs::write(root.path().join("checkpoint/desktop-preferences.before"),"bad").unwrap();
        assert!(Transaction::load(root.path().join("checkpoint"),targets).is_err());assert_eq!(std::fs::read(path).unwrap(),b"old");
    }
    #[test]
    fn failure_between_component_writes_restores_all_before_images_under_the_same_handles() {
        let root=tempfile::tempdir().unwrap();let a=root.path().join("preferences");let b=root.path().join("plugins");
        std::fs::write(&a,b"old preferences").unwrap();std::fs::write(&b,b"old plugins").unwrap();
        let mut transaction=prepare(root.path(),BTreeMap::from([("desktop-preferences".into(),a.clone()),("plugin-intent".into(),b.clone())]));
        // The first component is written before the second source fails. An
        // IO failure at this boundary must undo the already successful write.
        std::fs::remove_file(root.path().join("checkpoint/plugin-intent.after")).unwrap();
        assert_eq!(transaction.commit().unwrap_err().to_string(),"backup-checkpoint-missing");
        assert_eq!(std::fs::read(a).unwrap(),b"old preferences");assert_eq!(std::fs::read(b).unwrap(),b"old plugins");
        assert_eq!(transaction.stage(),"rolled-back");
    }
}
