//! Bounded disk work and handle-based change detection for local updates.
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::{fs::{File, OpenOptions}, io::{self, Read, Seek, SeekFrom, Write}, path::Path};

pub fn workers() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4))
}

pub fn open_read(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // Read the link itself and deny concurrent writes/replacement while
        // inspecting it. Existing writers cause an ordinary sharing error.
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("update-linked-file"));
        }
    }
    if !metadata.is_file() { return Err(io::Error::other("update-special-file")); }
    Ok(file)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stamp {
    size: u64,
    volume: u64,
    id: [u8; 16],
    created: i64,
    modified: i64,
    changed: i64,
    attributes: u32,
}
impl Stamp {
    pub fn read(file: &File) -> Option<Self> {
        #[cfg(windows)] {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{
                GetFileInformationByHandle, GetFileInformationByHandleEx, FileBasicInfo, FileIdInfo,
                FILE_BASIC_INFO, FILE_ID_INFO, BY_HANDLE_FILE_INFORMATION,
            }};
            let mut basic = FILE_BASIC_INFO::default();
            let mut identity = FILE_ID_INFO::default();
            let mut standard = BY_HANDLE_FILE_INFORMATION::default();
            let handle = HANDLE(file.as_raw_handle());
            unsafe {
                GetFileInformationByHandleEx(handle, FileBasicInfo, (&mut basic as *mut FILE_BASIC_INFO).cast(), std::mem::size_of_val(&basic) as u32).ok()?;
                GetFileInformationByHandleEx(handle, FileIdInfo, (&mut identity as *mut FILE_ID_INFO).cast(), std::mem::size_of_val(&identity) as u32).ok()?;
                GetFileInformationByHandle(handle, &mut standard).ok()?;
            }
            // Filesystems without a usable identity/change time fall back to
            // content hashing. Last-write time alone can be restored by tools.
            if basic.ChangeTime == 0 || identity.FileId.Identifier == [0; 16] { return None; }
            Some(Self {size: ((standard.nFileSizeHigh as u64)<<32)|standard.nFileSizeLow as u64, volume: identity.VolumeSerialNumber,
                id: identity.FileId.Identifier, created: basic.CreationTime,
                modified: basic.LastWriteTime, changed: basic.ChangeTime,attributes:basic.FileAttributes})
        }
        #[cfg(not(windows))] { let _ = file; None }
    }
    pub fn size(&self) -> u64 {self.size}
    pub fn is_plain(&self, directory:bool) -> bool {
        self.attributes & 0x400 == 0 && (self.attributes & 0x10 != 0)==directory
    }
    pub fn inspect(path:&Path,directory:bool)->io::Result<(File,Option<Self>)> {
        let mut options=OpenOptions::new();options.read(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000 | if directory {0x02000000} else {0});
        }
        let file=options.open(path)?;
        let stamp=Self::read(&file);
        if let Some(value)=&stamp {
            if !value.is_plain(directory) {return Err(io::Error::other("update-linked-file"));}
        } else {
            let metadata=file.metadata()?;
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {return Err(io::Error::other("update-linked-file"));}
            }
            if metadata.is_dir()!=directory || (!directory && !metadata.is_file()) {return Err(io::Error::other("update-special-file"));}
        }
        Ok((file,stamp))
    }
}

pub fn hash_reader(reader: &mut impl Read) -> io::Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    let mut size = 0;
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 { break; }
        size += n as u64;
        hash.update(&bytes[..n]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

pub fn copy_verified(from: &Path, to: &Path, expected_size: u64) -> io::Result<String> {
    let mut input = open_read(from)?;
    if input.metadata()?.len() != expected_size { return Err(io::Error::other("update-checkpoint-source-changed")); }
    let before = Stamp::read(&input);
    let mut options=OpenOptions::new();options.read(true).write(true).create_new(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    let mut output = options.open(to)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    let mut copied = 0;
    loop {
        let n = input.read(&mut bytes)?;
        if n == 0 { break; }
        copied += n as u64;
        if copied > expected_size { return Err(io::Error::other("update-checkpoint-source-changed")); }
        output.write_all(&bytes[..n])?;
        hash.update(&bytes[..n]);
    }
    let digest = format!("{:x}", hash.finalize());
    output.flush()?;
    output.sync_all()?;
    output.seek(SeekFrom::Start(0))?;
    let verified = hash_reader(&mut output)?;
    if copied != expected_size || verified != (copied, digest.clone()) || Stamp::read(&input) != before {
        return Err(io::Error::other("update-checkpoint-source-changed"));
    }
    if before.is_none() {
        input.seek(SeekFrom::Start(0))?;
        if hash_reader(&mut input)? != verified { return Err(io::Error::other("update-checkpoint-source-changed")); }
    }
    Ok(digest)
}
