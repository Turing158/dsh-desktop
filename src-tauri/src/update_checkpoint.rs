//! Local upgrade checkpoint. The stopped provider's entire home is retained,
//! including credentials, and is never exported. Rollback preserves the failed
//! home by renaming it; it never merges old and migrated session files.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

fn invalid() -> io::Error {
    io::Error::other("update-checkpoint-invalid")
}
fn linked(m: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 { return true; }
    }
    m.file_type().is_symlink()
}
// Profiles legitimately contain npm junctions, including targets outside DSH_HOME.
// Copy the link itself, never its target. Opening reparse points also works for
// dangling links and avoids requiring symlink privileges for ordinary junctions.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Link {
    directory: bool,
    data: Vec<u8>,
}
impl Link {
    fn directory(m: &fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            return m.file_attributes() & 0x10 != 0;
        }
        #[cfg(not(windows))]
        m.is_dir()
    }
    #[cfg(windows)]
    fn open(path: &Path, write: bool) -> io::Result<fs::File> {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).write(write)
            .custom_flags(0x00200000 | 0x02000000).open(path)
    }
    #[cfg(windows)]
    fn read(path: &Path, directory: bool) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::IO::DeviceIoControl};
        let file = Self::open(path, false)?;
        let mut data = vec![0u8; 16 * 1024];
        let mut returned = 0;
        unsafe { DeviceIoControl(HANDLE(file.as_raw_handle()), 0x000900a8,
            None, 0, Some(data.as_mut_ptr().cast()), data.len() as u32,
            Some(&mut returned), None) }.map_err(io::Error::other)?;
        data.truncate(returned as usize);
        let link = Self { directory, data };
        link.validate()?;
        Ok(link)
    }
    fn validate(&self) -> io::Result<()> {
        if self.data.len() < 8 || self.data.len() > 16 * 1024 { return Err(invalid()); }
        let tag = u32::from_le_bytes(self.data[..4].try_into().unwrap());
        let size = u16::from_le_bytes(self.data[4..6].try_into().unwrap()) as usize;
        if !matches!(tag, 0xa0000003 | 0xa000000c) || size + 8 != self.data.len() {
            return Err(io::Error::other("update-checkpoint-link-unsupported"));
        }
        Ok(())
    }
    #[cfg(windows)]
    fn create(&self, path: &Path) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::IO::DeviceIoControl};
        self.validate()?;
        if self.directory { fs::create_dir(path)?; }
        else { fs::OpenOptions::new().write(true).create_new(true).open(path)?; }
        let file = Self::open(path, true)?;
        let mut returned = 0;
        unsafe { DeviceIoControl(HANDLE(file.as_raw_handle()), 0x000900a4,
            Some(self.data.as_ptr().cast()), self.data.len() as u32, None, 0,
            Some(&mut returned), None) }.map_err(io::Error::other)?;
        file.sync_all()
    }
}
fn plain(path: &Path, dir: bool) -> io::Result<()> {
    let m = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    if m.file_type().is_symlink() || if dir { !m.is_dir() } else { !m.is_file() } {
        return Err(invalid());
    }
    Ok(())
}
pub fn plain_root(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(invalid());
    }
    for p in path.ancestors().filter(|p| p.is_absolute()) {
        plain(p, true)?
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    hash: String,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    link: Option<Link>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub home: PathBuf,
    saved: PathBuf,
    failed: PathBuf,
    files: Vec<Entry>,
}
fn hash(path: &Path) -> io::Result<String> {
    plain(path, false)?;
    let mut file = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        h.update(&bytes[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
impl Checkpoint {
    pub fn capture(home: &Path, id: uuid::Uuid) -> io::Result<Self> {
        let started=std::time::Instant::now();
        plain_root(home)?;
        let parent = home.parent().ok_or_else(invalid)?;
        let saved = parent.join(format!(".dsh-update-{id}-before"));
        let failed = parent.join(format!(".dsh-update-{id}-failed"));
        fs::create_dir(&saved)?;
        let mut value = Self {
            home: home.into(),
            saved,
            failed,
            files: vec![],
        };
        let mut total = 0;
        fn copy(
            value: &mut Checkpoint,
            relative: &Path,
            depth: usize,
            total: &mut u64,
            tasks: &mut Vec<(PathBuf,u64)>,
        ) -> io::Result<()> {
            if depth > 80 {
                return Err(invalid());
            }
            let from = value.home.join(relative);
            plain(&from, true)?;
            for item in fs::read_dir(from)? {
                let item = item?;
                let rel = relative.join(item.file_name());
                let from = value.home.join(&rel);
                let to = value.saved.join(&rel);
                let m = fs::symlink_metadata(&from)?;
                if linked(&m) {
                    let link = Link::read(&from, Link::directory(&m))?;
                    link.create(&to)?;
                    if Link::read(&from, link.directory)?.data != link.data {
                        return Err(io::Error::other("update-checkpoint-source-changed"));
                    }
                    value.files.push(Entry {
                        path: rel,
                        hash: format!("{:x}", Sha256::digest(&link.data)),
                        size: link.data.len() as u64,
                        link: Some(link),
                    });
                } else if m.is_dir() {
                    plain(&from, true)?;
                    fs::create_dir(&to)?;
                    copy(value, &rel, depth + 1, total,tasks)?;
                } else {
                    plain(&from, false)?;
                    *total = total.checked_add(m.len()).ok_or_else(invalid)?;
                    if *total > 8 * 1024 * 1024 * 1024 || value.files.len()+tasks.len() >= 300_000 {
                        return Err(io::Error::other("update-checkpoint-capacity"));
                    }
                    tasks.push((rel,m.len()));
                }
            }
            Ok(())
        }
        let mut tasks=Vec::new();
        let result=(|| {
            copy(&mut value, Path::new(""), 0, &mut total,&mut tasks)?;
            let next=std::sync::atomic::AtomicUsize::new(0);
            let cancelled=std::sync::atomic::AtomicBool::new(false);
            let entries=std::thread::scope(|scope| {
                let mut handles=Vec::new();
                for _ in 0..crate::update_io::workers().min(tasks.len()) {
                    let tasks=&tasks;let next=&next;let cancelled=&cancelled;
                    let home=&value.home;let saved=&value.saved;
                    handles.push(scope.spawn(move || {
                        let mut entries=Vec::new();
                        while !cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                            let index=next.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
                            let Some((path,size))=tasks.get(index) else {break};
                            match crate::update_io::copy_verified(&home.join(path),&saved.join(path),*size) {
                                Ok(hash)=>entries.push(Entry {path:path.clone(),hash,size:*size,link:None}),
                                Err(error)=>{cancelled.store(true,std::sync::atomic::Ordering::Relaxed);return Err(error);}
                            }
                        }
                        Ok::<_,io::Error>(entries)
                    }));
                }
                let mut entries=Vec::new();let mut error=None;
                for handle in handles {match handle.join() {
                    Ok(Ok(values))=>entries.extend(values),
                    Ok(Err(e))=>{if error.is_none(){error=Some(e);}},
                    Err(_)=>{if error.is_none(){error=Some(io::Error::other("update-checkpoint-worker"));}},
                }}
                if let Some(error)=error {Err(error)} else {Ok(entries)}
            })?;
            value.files.extend(entries);
            value.files.sort_by(|a,b|a.path.cmp(&b.path));
            Ok::<_,io::Error>(())
        })();
        if let Err(error) = result {
            // This UUID sibling was created here and has never been published.
            // remove_dir_all removes reparse points without visiting their targets.
            if let Err(cleanup) = value.discard_unpublished() {
                crate::debug_log(&format!("[update] unpublished checkpoint cleanup failed: {cleanup}"));
            }
            return Err(error);
        }
        crate::debug_log(&format!("[update-perf] checkpoint files={} bytes={} elapsed_ms={}",value.files.len(),total,started.elapsed().as_millis()));
        Ok(value)
    }
    fn validate(&self) -> io::Result<()> {
        // Only sibling paths generated for this operation can ever be renamed.
        if self.saved.parent() != self.home.parent()
            || self.failed.parent() != self.home.parent()
            || self.home == self.saved
            || self.home == self.failed
        {
            return Err(invalid());
        }
        let name = self
            .saved
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(invalid)?;
        let id = name
            .strip_prefix(".dsh-update-")
            .and_then(|n| n.strip_suffix("-before"))
            .ok_or_else(invalid)?;
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
        if self.failed.file_name().and_then(|n| n.to_str())
            != Some(format!(".dsh-update-{id}-failed").as_str())
        {
            return Err(invalid());
        }
        if self.files.len() > 300_000 {
            return Err(invalid());
        }
        for e in &self.files {
            if e.path.as_os_str().is_empty()
                || e.path
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(invalid());
            }
            if let Some(link) = &e.link { link.validate()?; }
        }
        Ok(())
    }
    pub fn discard_unpublished(&self) -> io::Result<()> {
        self.validate()?;
        plain_root(&self.home)?;
        match plain(&self.saved, true) {
            Ok(()) => fs::remove_dir_all(&self.saved),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
    /// Call only after a durable upgrade commit. The reserved sibling namespace
    /// includes older checkpoints, incomplete captures, and rolled-back homes.
    pub fn cleanup_obsolete(&self) -> io::Result<usize> {
        self.validate()?;
        plain_root(&self.home)?;
        let parent = self.home.parent().ok_or_else(invalid)?;
        let mut removed = 0;
        let mut failure = None;
        for item in fs::read_dir(parent)? {
            let result = (|| {
                let item = item?;
                let name = item.file_name();
                let Some(id) = name.to_str().and_then(|name| name.strip_prefix(".dsh-update-"))
                    .and_then(|name| name.strip_suffix("-before").or_else(|| name.strip_suffix("-failed")))
                else { return Ok(()); };
                // Match exactly the names emitted by capture, not arbitrary
                // folders that happen to have a similar prefix.
                if !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
                    return Ok(());
                }
                let path = item.path();
                if path == self.home { return Ok(()); }
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                };
                // Never accept a redirected top-level checkpoint. Links inside
                // a real checkpoint are removed without following their targets.
                if linked(&metadata) || !metadata.is_dir() { return Ok(()); }
                plain_root(&path)?;
                match fs::remove_dir_all(&path) {
                    Ok(()) => removed += 1,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                    Err(error) => return Err(error),
                }
                Ok::<_, io::Error>(())
            })();
            if let Err(error) = result {
                crate::debug_log(&format!("[update] obsolete checkpoint cleanup failed: {error}"));
                if failure.is_none() { failure = Some(error); }
            }
        }
        if let Some(error) = failure { Err(error) } else { Ok(removed) }
    }
    pub fn rollback(&self) -> io::Result<()> {
        self.validate()?;
        plain_root(self.home.parent().ok_or_else(invalid)?)?;
        // A crash after the final rename is already rolled back.
        if !self.saved.try_exists()? && self.failed.try_exists()? {
            plain_root(&self.home)?;
            return Ok(());
        }
        plain_root(&self.saved)?;
        let mut expected: std::collections::HashSet<PathBuf> =
            self.files.iter().map(|e| e.path.clone()).collect();
        if expected.len() != self.files.len() {
            return Err(invalid());
        }
        fn check_tree(
            root: &Path,
            relative: &Path,
            expected: &mut std::collections::HashSet<PathBuf>,
            depth: usize,
        ) -> io::Result<()> {
            if depth > 80 {
                return Err(invalid());
            }
            let path = root.join(relative);
            plain(&path, true)?;
            for item in fs::read_dir(path)? {
                let item = item?;
                let rel = relative.join(item.file_name());
                let path = root.join(&rel);
                let metadata = fs::symlink_metadata(&path)?;
                if !linked(&metadata) && metadata.is_dir() {
                    check_tree(root, &rel, expected, depth + 1)?;
                } else {
                    if !linked(&metadata) { plain(&path, false)?; }
                    if !expected.remove(&rel) {
                        return Err(invalid());
                    }
                }
            }
            Ok(())
        }
        check_tree(&self.saved, Path::new(""), &mut expected, 0)?;
        if !expected.is_empty() {
            return Err(invalid());
        }
        for e in &self.files {
            let file = self.saved.join(&e.path);
            plain_root(file.parent().ok_or_else(invalid)?)?;
            let matches = if let Some(link) = &e.link {
                let m = fs::symlink_metadata(&file)?;
                linked(&m) && Link::directory(&m) == link.directory
                    && Link::read(&file, link.directory)?.data == link.data
                    && e.size == link.data.len() as u64
                    && e.hash == format!("{:x}", Sha256::digest(&link.data))
            } else {
                fs::metadata(&file)?.len() == e.size && hash(&file)? == e.hash
            };
            if !matches {
                return Err(io::Error::other("update-checkpoint-integrity"));
            }
        }
        if self.home.try_exists()? {
            plain_root(&self.home)?;
            if self.failed.try_exists()? {
                return Err(io::Error::other("update-rollback-conflict"));
            }
            fs::rename(&self.home, &self.failed)?;
        }
        fs::rename(&self.saved, &self.home)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn junction(target: &Path, link: &Path) {
        let node = crate::dsh::resolve_node().expect("Node.js required for junction regression");
        let status = std::process::Command::new(node)
            .args(["-e", "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')"])
            .arg(target).arg(link).status().unwrap();
        assert!(status.success());
    }
    #[test]
    fn profile_junctions_are_preserved_without_copying_external_dependencies() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let outside = root.path().join("npm-package");
        fs::create_dir_all(home.join("profiles/node_modules")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("external-file"), b"untouched").unwrap();
        fs::write(home.join("session"), b"before").unwrap();
        let path = Path::new("profiles/node_modules/package");
        junction(&outside, &home.join(path));
        junction(&root.path().join("missing-package"), &home.join("profiles/node_modules/dangling"));
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        assert_eq!(c.files.len(), 3, "links count as single entries, targets are not scanned");
        assert!(linked(&fs::symlink_metadata(c.saved.join(path)).unwrap()));
        assert_eq!(fs::read_link(c.saved.join(path)).unwrap(), fs::read_link(home.join(path)).unwrap());
        fs::write(home.join("session"), b"after").unwrap();
        c.rollback().unwrap();
        c.rollback().unwrap();
        assert_eq!(fs::read(home.join("session")).unwrap(), b"before");
        assert_eq!(fs::read(outside.join("external-file")).unwrap(), b"untouched");
        assert!(linked(&fs::symlink_metadata(home.join(path)).unwrap()));
        fs::remove_dir_all(&c.failed).unwrap();
        assert!(outside.join("external-file").exists(), "cleanup never follows junctions");
    }
    #[test]
    fn retargeted_checkpoint_junction_is_rejected_before_rollback() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let outside = root.path().join("outside");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&outside).unwrap();
        junction(&outside, &home.join("link"));
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::remove_dir(c.saved.join("link")).unwrap();
        junction(root.path(), &c.saved.join("link"));
        assert!(c.rollback().is_err());
        assert!(home.exists());
        assert!(!c.failed.exists());
    }
    #[test]
    fn failed_capture_removes_only_its_unpublished_directory() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("locked"), b"data").unwrap();
        for index in 0..128 {fs::write(home.join(format!("file-{index}")),b"parallel checkpoint").unwrap();}
        use std::os::windows::fs::OpenOptionsExt;
        let _lock = fs::OpenOptions::new().read(true).share_mode(0).open(home.join("locked")).unwrap();
        let id = uuid::Uuid::new_v4();
        assert!(Checkpoint::capture(&home, id).is_err());
        assert!(!root.path().join(format!(".dsh-update-{id}-before")).exists());
        assert!(home.join("locked").exists());
    }
    #[test]
    fn successful_cleanup_removes_current_historical_and_partial_checkpoints() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("session"), b"current").unwrap();
        let old = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        old.rollback().unwrap();
        let current = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        let historical = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        let partial = root.path().join(format!(".dsh-update-{}-before", uuid::Uuid::new_v4()));
        fs::create_dir(&partial).unwrap();
        fs::write(partial.join("partial"), b"incomplete").unwrap();
        let other = root.path().join("user-backup");
        fs::create_dir(&other).unwrap();
        let lookalike = root.path().join(".dsh-update-not-a-uuid-before");
        fs::create_dir(&lookalike).unwrap();
        let wrong_suffix = root.path().join(format!(".dsh-update-{}-other", uuid::Uuid::new_v4()));
        fs::create_dir(&wrong_suffix).unwrap();
        let regular_file = root.path().join(format!(".dsh-update-{}-before", uuid::Uuid::new_v4()));
        fs::write(&regular_file, b"ordinary file").unwrap();
        assert_eq!(current.cleanup_obsolete().unwrap(), 4);
        assert_eq!(current.cleanup_obsolete().unwrap(), 0);
        for path in [&old.failed, &current.saved, &historical.saved, &partial] {
            assert!(!path.exists());
        }
        for path in [&other, &lookalike, &wrong_suffix, &regular_file] {
            assert!(path.exists());
        }
        assert_eq!(fs::read(home.join("session")).unwrap(), b"current");
    }
    #[test]
    fn cleanup_preserves_external_junction_targets_and_rejects_redirected_roots() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let outside = root.path().join("outside");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), b"untouched").unwrap();
        junction(&outside, &home.join("package"));
        let checkpoint = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        let redirected = root.path().join(format!(".dsh-update-{}-before", uuid::Uuid::new_v4()));
        junction(&outside, &redirected);
        assert_eq!(checkpoint.cleanup_obsolete().unwrap(), 1);
        assert!(redirected.exists());
        assert!(home.join("package").exists());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"untouched");
        // A redirected home or ancestor must stop the sweep before deletion.
        let checkpoint = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::remove_dir_all(&home).unwrap();
        junction(&outside, &home);
        assert!(checkpoint.cleanup_obsolete().is_err());
        assert!(checkpoint.saved.exists());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"untouched");
    }
    #[test]
    fn locked_obsolete_checkpoint_does_not_block_others_and_can_be_retried() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("session"), b"current").unwrap();
        let locked = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        let current = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new().read(true).share_mode(0)
            .open(locked.saved.join("session")).unwrap();
        assert!(current.cleanup_obsolete().is_err());
        assert!(locked.saved.exists());
        assert!(!current.saved.exists());
        assert_eq!(fs::read(home.join("session")).unwrap(), b"current");
        drop(lock);
        assert_eq!(current.cleanup_obsolete().unwrap(), 1);
        assert!(!locked.saved.exists());
    }
    #[test]
    fn unpublished_cleanup_removes_only_its_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("session"), b"current").unwrap();
        let previous = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        previous.rollback().unwrap();
        let unpublished = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        unpublished.discard_unpublished().unwrap();
        unpublished.discard_unpublished().unwrap();
        assert!(!unpublished.saved.exists());
        assert!(previous.failed.exists());
        assert_eq!(fs::read(home.join("session")).unwrap(), b"current");
    }
    #[test]
    fn forged_checkpoint_paths_cannot_trigger_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let mut checkpoint = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        let saved = checkpoint.saved.clone();
        checkpoint.failed = root.path().join("ordinary-folder");
        assert!(checkpoint.cleanup_obsolete().is_err());
        assert!(checkpoint.discard_unpublished().is_err());
        assert!(saved.exists());
    }
    #[test]
    fn parallel_checkpoint_preserves_every_file_and_large_stream_hash() {
        let root=tempfile::tempdir().unwrap();let home=root.path().join("home");
        fs::create_dir_all(home.join("nested")).unwrap();
        let data=vec![37u8;2*1024*1024+17];fs::write(home.join("large"),&data).unwrap();
        for index in 0..160 {fs::write(home.join("nested").join(format!("{index}")),format!("session-{index}")).unwrap();}
        let checkpoint=Checkpoint::capture(&home,uuid::Uuid::new_v4()).unwrap();
        assert_eq!(checkpoint.files.len(),161);
        assert_eq!(checkpoint.files.iter().find(|entry|entry.path==Path::new("large")).unwrap().hash,format!("{:x}",Sha256::digest(&data)));
        fs::write(home.join("large"),b"after").unwrap();checkpoint.rollback().unwrap();
        assert_eq!(fs::read(home.join("large")).unwrap(),data);
        for index in 0..160 {assert_eq!(fs::read_to_string(home.join("nested").join(format!("{index}"))).unwrap(),format!("session-{index}"));}
    }
    #[test]
    fn rollback_replaces_migrated_tree_and_retains_failed_data() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("session"), b"old").unwrap();
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::write(home.join("session"), b"migrated").unwrap();
        fs::write(home.join("new"), b"new").unwrap();
        c.rollback().unwrap();
        c.rollback().unwrap();
        assert_eq!(fs::read(home.join("session")).unwrap(), b"old");
        assert!(!home.join("new").exists());
        assert_eq!(fs::read(c.failed.join("session")).unwrap(), b"migrated");
    }
    #[test]
    fn corrupt_checkpoint_never_moves_current_data() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("data"), b"old").unwrap();
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::write(c.saved.join("data"), b"bad").unwrap();
        assert!(c.rollback().is_err());
        assert_eq!(fs::read(home.join("data")).unwrap(), b"old");
    }
    #[test]
    fn interrupted_rename_finishes_without_deleting_either_tree() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("data"), b"old").unwrap();
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::write(home.join("data"), b"new").unwrap();
        fs::rename(&home, &c.failed).unwrap();
        c.rollback().unwrap();
        assert_eq!(fs::read(home.join("data")).unwrap(), b"old");
        assert_eq!(fs::read(c.failed.join("data")).unwrap(), b"new");
    }
    #[test]
    fn unexpected_checkpoint_files_are_rejected_before_moving_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let c = Checkpoint::capture(&home, uuid::Uuid::new_v4()).unwrap();
        fs::write(c.saved.join("injected"), b"bad").unwrap();
        assert!(c.rollback().is_err());
        assert!(home.is_dir());
        assert!(!c.failed.exists());
    }
}
