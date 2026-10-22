use std::{collections::HashSet, fs::File, io::{self, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::{Aead, Payload, OsRng, rand_core::RngCore}};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"DSHBKP01";
const CHUNK: usize = 1024 * 1024;
const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_FILE: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub backup_id: uuid::Uuid,
    pub created_at: u64,
    pub desktop_version: String,
    pub dsh_version: String,
    pub architecture: String,
    pub source_data_schema: Option<u32>,
    pub profile: String,
    pub scope: String,
    pub credential_policy: String,
    pub encrypted: bool,
    pub components: Vec<Component>,
    pub excluded: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Component {
    pub id: String,
    pub provider: String,
    pub schema: u32,
    /// Symbolic target understood by an adapter, never an absolute path.
    pub logical_target: String,
    pub files: Vec<Entry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry { pub path: String, pub size: u64, pub sha256: String }
pub struct Source { pub path: String, pub file: PathBuf }
pub struct Verified {
    pub manifest: Manifest,
    // Staging is scoped to this handle and is never a destination from a backup.
    staging: tempfile::TempDir,
}
impl Verified {
    pub fn file(&self, path: &str) -> Option<PathBuf> {
        self.manifest.entries().any(|entry| entry.path == path).then(|| self.staging.path().join(path))
    }
}
fn fail(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, code) }
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
pub fn safe_path(value: &str) -> bool {
    if value.len() > 240 || value.is_empty() || value.contains('\\') || !value.is_ascii() { return false; }
    value.split('/').all(|part| {
        if part.is_empty() || part == "." || part == ".." || part.ends_with('.') || part.ends_with(' ')
            || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) { return false; }
        let stem = part.split('.').next().unwrap().to_ascii_uppercase();
        !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            && !((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    })
}
impl Manifest {
    fn validate(&self) -> io::Result<()> {
        if self.format_version != 1 || self.profile != "web" || !matches!(self.scope.as_str(), "partial" | "complete")
            || !matches!(self.credential_policy.as_str(), "exclude-credentials" | "encrypted-credentials")
            || self.credential_policy == "encrypted-credentials" && !self.encrypted
            || !matches!(self.architecture.as_str(), "x86_64" | "x86" | "aarch64")
            || semver::Version::parse(&self.desktop_version).is_err() || semver::Version::parse(&self.dsh_version).is_err()
            || self.source_data_schema.is_some_and(|schema| schema > 100) || self.components.len() > 32
            || self.excluded.len() > 128 || self.warnings.len() > 128
            || self.excluded.iter().chain(&self.warnings).any(|s| !identifier(s)) { return Err(fail("backup-manifest-schema")); }
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        let mut total = 0u64;
        for component in &self.components {
            if !identifier(&component.id) || !identifier(&component.provider) || !identifier(&component.logical_target)
                || component.schema == 0 || component.schema > 100 || !ids.insert(component.id.clone()) { return Err(fail("backup-component-schema")); }
            for entry in &component.files {
                if !safe_path(&entry.path) || !entry.path.starts_with(&format!("components/{}/", component.id))
                    || !paths.insert(entry.path.to_ascii_lowercase()) || paths.len() > MAX_ENTRIES
                    || entry.size > MAX_FILE || entry.sha256.len() != 64 || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(fail("backup-entry-schema")); }
                total = total.checked_add(entry.size).ok_or_else(|| fail("backup-size"))?;
                if total > MAX_EXPANDED { return Err(fail("backup-size")); }
            }
        }
        // Reject a file that would also be an ancestor directory on Windows.
        for path in &paths {
            for (index, _) in path.match_indices('/') { if paths.contains(&path[..index]) { return Err(fail("backup-path-collision")); } }
        }
        Ok(())
    }
    pub fn entries(&self) -> impl Iterator<Item = &Entry> { self.components.iter().flat_map(|c| &c.files) }
}
/// Sources must be provider snapshots. Never archives a live business root.
pub fn write(destination: &Path, manifest: &Manifest, sources: &[Source], password: Option<&str>) -> io::Result<PathBuf> {
    manifest.validate()?;
    if manifest.encrypted != password.is_some() { return Err(fail("backup-encryption-policy")); }
    let sources: std::collections::HashMap<_, _> = sources.iter().map(|s| (s.path.as_str(), &s.file)).collect();
    if sources.len() != manifest.entries().count() { return Err(fail("backup-source-mismatch")); }
    let mut archive = zip::ZipWriter::new(tempfile::tempfile()?);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o600);
    archive.start_file("manifest.json", options)?;
    let json = serde_json::to_vec(manifest)?;
    if json.len() > MAX_MANIFEST { return Err(fail("backup-manifest-size")); }
    archive.write_all(&json)?;
    for entry in manifest.entries() {
        let source = sources.get(entry.path.as_str()).ok_or_else(|| fail("backup-source-mismatch"))?;
        let metadata = std::fs::symlink_metadata(source)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != entry.size { return Err(fail("backup-source-invalid")); }
        archive.start_file(&entry.path, options)?;
        copy_hash(File::open(source)?, &mut archive, entry)?;
    }
    let mut archive = archive.finish()?;
    let size = archive.seek(SeekFrom::End(0))?;
    if size > MAX_ARCHIVE { return Err(fail("backup-archive-size")); }
    archive.seek(SeekFrom::Start(0))?;
    let mut output = tempfile::NamedTempFile::new_in(destination)?;
    encode(&mut archive, &mut output, size, password)?;
    output.as_file().sync_all()?;
    // Publish only a file this exact reader can authenticate and expand within
    // its budgets. This also catches overly compressible provider snapshots.
    drop(verify(output.path(), password)?);
    let path = destination.join(format!("dsh-{}.dshbackup", manifest.backup_id));
    output.persist_noclobber(&path).map_err(|e| e.error)?;
    Ok(path)
}
pub fn verify(path: &Path, password: Option<&str>) -> io::Result<Verified> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_ARCHIVE + 1024 * 1024 { return Err(fail("backup-archive-size")); }
    let mut input = File::open(path)?;
    let mut decoded = tempfile::tempfile()?;
    let encrypted = decode(&mut input, &mut decoded, password)?;
    decoded.seek(SeekFrom::Start(0))?;
    let mut archive = zip::ZipArchive::new(decoded)?;
    if archive.len() > MAX_ENTRIES + 1 { return Err(fail("backup-entry-limit")); }
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if !safe_path(entry.name()) || !seen.insert(entry.name().to_ascii_lowercase()) || entry.is_dir()
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            || !matches!(entry.compression(), zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated)
            || entry.size() > MAX_FILE || entry.size() > entry.compressed_size().saturating_mul(200).max(1024 * 1024) { return Err(fail("backup-archive-entry")); }
    }
    let mut bytes = Vec::new();
    archive.by_name("manifest.json")?.take(MAX_MANIFEST as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_MANIFEST { return Err(fail("backup-manifest-size")); }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| fail("backup-manifest-schema"))?;
    manifest.validate()?;
    if manifest.encrypted != encrypted || manifest.entries().count() + 1 != archive.len() { return Err(fail("backup-source-mismatch")); }
    let staging = tempfile::tempdir()?;
    for entry in manifest.entries() {
        let mut source = archive.by_name(&entry.path)?;
        if source.size() != entry.size { return Err(fail("backup-entry-size")); }
        let path = staging.path().join(&entry.path);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let mut destination = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
        copy_hash(&mut source, &mut destination, entry)?;
        destination.sync_all()?;
    }
    Ok(Verified { manifest, staging })
}
fn copy_hash(mut source: impl Read, destination: &mut impl Write, entry: &Entry) -> io::Result<()> {
    let mut digest = Sha256::new();
    let mut remaining = entry.size;
    let mut buffer = vec![0u8; 65536];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let length = source.read(&mut buffer[..wanted])?;
        if length == 0 { return Err(fail("backup-entry-size")); }
        destination.write_all(&buffer[..length])?; digest.update(&buffer[..length]); remaining -= length as u64;
    }
    if source.read(&mut buffer[..1])? != 0 || format!("{:x}", digest.finalize()) != entry.sha256 { return Err(fail("backup-entry-integrity")); }
    Ok(())
}
fn key(password: &str, salt: &[u8], memory: u32, time: u32, lanes: u32) -> io::Result<Zeroizing<[u8; 32]>> {
    if password.is_empty() || password.len() > 1024 || !(8192..=65536).contains(&memory) || !(1..=5).contains(&time) || !(1..=4).contains(&lanes) { return Err(fail("backup-kdf-parameters")); }
    let mut key = Zeroizing::new([0u8; 32]);
    let params = argon2::Params::new(memory, time, lanes, Some(32)).map_err(|_| fail("backup-kdf-parameters"))?;
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut()).map_err(|_| fail("backup-kdf-failed"))?;
    Ok(key)
}
fn encode(input: &mut impl Read, output: &mut impl Write, size: u64, password: Option<&str>) -> io::Result<()> {
    if size > MAX_ARCHIVE { return Err(fail("backup-archive-size")); }
    output.write_all(MAGIC)?;
    output.write_all(&[u8::from(password.is_some())])?;
    let Some(password) = password else { io::copy(input, output)?; return Ok(()); };
    let mut salt = [0u8; 16]; let mut prefix = [0u8; 8]; OsRng.fill_bytes(&mut salt); OsRng.fill_bytes(&mut prefix);
    let mut header = Vec::from(&MAGIC[..]); header.push(1); header.extend(salt); header.extend(prefix);
    for param in [65536u32, 3, 1] { header.extend(param.to_le_bytes()); } header.extend(size.to_le_bytes());
    output.write_all(&header[9..])?;
    let key = key(password, &salt, 65536, 3, 1)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| fail("backup-encryption"))?;
    let mut remaining = size; let mut index = 0u32;
    // Authenticate even an empty archive. Length and chunk ordinal are AAD.
    loop {
        let length = remaining.min(CHUNK as u64) as usize;
        let mut plain = Zeroizing::new(vec![0u8; length]); input.read_exact(&mut plain)?;
        let mut nonce = [0u8; 12]; nonce[..8].copy_from_slice(&prefix); nonce[8..].copy_from_slice(&index.to_le_bytes());
        let mut aad = header.clone(); aad.extend(index.to_le_bytes());
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &aad }).map_err(|_| fail("backup-encryption"))?;
        output.write_all(&encrypted)?;
        remaining -= length as u64; if remaining == 0 { break; } index += 1;
    }
    Ok(())
}
fn decode(input: &mut impl Read, output: &mut impl Write, password: Option<&str>) -> io::Result<bool> {
    let mut start = [0u8; 9]; input.read_exact(&mut start)?;
    if &start[..8] != MAGIC || start[8] > 1 { return Err(fail("backup-format")); }
    if start[8] == 0 {
        if io::copy(&mut input.take(MAX_ARCHIVE + 1), output)? > MAX_ARCHIVE { return Err(fail("backup-archive-size")); }
        return Ok(false);
    }
    let password = password.ok_or_else(|| fail("backup-password-required"))?;
    let mut rest = [0u8; 44]; input.read_exact(&mut rest)?;
    let number = |at| u32::from_le_bytes(rest[at..at+4].try_into().unwrap());
    let size = u64::from_le_bytes(rest[36..44].try_into().unwrap());
    if size > MAX_ARCHIVE { return Err(fail("backup-archive-size")); }
    let key = key(password, &rest[..16], number(24), number(28), number(32))?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| fail("backup-encryption"))?;
    let mut header = start.to_vec(); header.extend(rest);
    let mut remaining = size; let mut index = 0u32;
    loop {
        let length = remaining.min(CHUNK as u64) as usize;
        let mut encrypted = vec![0u8; length + 16]; input.read_exact(&mut encrypted).map_err(|_| fail("backup-authentication"))?;
        let mut nonce = [0u8; 12]; nonce[..8].copy_from_slice(&rest[16..24]); nonce[8..].copy_from_slice(&index.to_le_bytes());
        let mut aad = header.clone(); aad.extend(index.to_le_bytes());
        let plain = Zeroizing::new(cipher.decrypt(Nonce::from_slice(&nonce), Payload {msg: &encrypted,aad: &aad}).map_err(|_| fail("backup-authentication"))?);
        output.write_all(&plain)?;
        remaining -= length as u64; if remaining == 0 { break; } index += 1;
    }
    let mut extra = [0u8; 1]; if input.read(&mut extra)? != 0 { return Err(fail("backup-authentication")); }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn manifest(bytes: &[u8], encrypted: bool) -> Manifest {
        Manifest {format_version:1,backup_id:uuid::Uuid::new_v4(),created_at:1,desktop_version:"0.1.4".into(),dsh_version:"0.2.1-rc.2".into(),
            architecture:"x86_64".into(),source_data_schema:None,profile:"web".into(),scope:"partial".into(),credential_policy:"exclude-credentials".into(),encrypted,
            components:vec![Component {id:"desktop-preferences".into(),provider:"desktop-settings".into(),schema:1,logical_target:"desktop-preferences".into(),
                files:vec![Entry {path:"components/desktop-preferences/data.json".into(),size:bytes.len() as u64,sha256:format!("{:x}",Sha256::digest(bytes))}]}],
            excluded:vec!["sessions-unverified".into()],warnings:vec![]}
    }
    fn forged(directory: &Path, manifest: &Manifest, names: &[(&str, &[u8])]) -> PathBuf {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        archive.start_file("manifest.json",options).unwrap(); archive.write_all(&serde_json::to_vec(manifest).unwrap()).unwrap();
        for (name,bytes) in names {archive.start_file(*name,options).unwrap(); archive.write_all(bytes).unwrap();}
        let zip = archive.finish().unwrap().into_inner();
        let mut encoded = Vec::new(); encode(&mut Cursor::new(&zip), &mut encoded, zip.len() as u64, None).unwrap();
        let path = directory.join(format!("{}.dshbackup",uuid::Uuid::new_v4())); std::fs::write(&path,encoded).unwrap(); path
    }
    #[test]
    fn ordinary_archive_round_trip_never_overwrites_a_previous_backup_or_source() {
        let directory = tempfile::tempdir().unwrap(); let data = b"{\"animation\":\"off\"}";
        let source = directory.path().join("source.json"); std::fs::write(&source,data).unwrap();
        let manifest = manifest(data,false);
        let sources = [Source {path:manifest.entries().next().unwrap().path.clone(),file:source.clone()}];
        let path = write(directory.path(),&manifest,&sources,None).unwrap();
        let verified = verify(&path,None).unwrap();
        assert_eq!(std::fs::read(verified.file(&sources[0].path).unwrap()).unwrap(),data);
        assert!(verified.file("../source.json").is_none());
        assert!(write(directory.path(),&manifest,&sources,None).is_err());
        assert_eq!(std::fs::read(source).unwrap(),data);
        assert!(verify(&path,None).is_ok());
    }
    #[test]
    fn malicious_paths_case_collisions_and_unknown_formats_fail_preflight() {
        for path in ["/absolute","C:/file","../escape","a/../escape","a\\escape","a/secret:ads","a/CON.txt","a/lpt1","a/aux","a/file.","a//file","a/中文"] {assert!(!safe_path(path),"{path}");}
        let mut manifest = manifest(b"data",false);
        let mut duplicate = manifest.components[0].files[0].clone(); duplicate.path = duplicate.path.to_uppercase();
        manifest.components[0].files.push(duplicate); assert!(manifest.validate().is_err());
        manifest.components[0].files.pop(); manifest.format_version = 2; assert!(manifest.validate().is_err());
        manifest.format_version = 1; manifest.credential_policy = "encrypted-credentials".into(); assert!(manifest.validate().is_err());
    }
    #[test]
    fn unlisted_entries_integrity_mismatch_and_excessive_expansion_are_rejected() {
        let directory = tempfile::tempdir().unwrap(); let manifest = manifest(b"data",false);
        let path = &manifest.components[0].files[0].path;
        for names in [vec![(path.as_str(),b"oops".as_slice())],vec![(path.as_str(),b"data".as_slice()),("extra.json",b"extra".as_slice())],vec![("../escape",b"data".as_slice())]] {
            assert!(verify(&forged(directory.path(),&manifest,&names),None).is_err());
        }
        let bomb = vec![0u8;2 * 1024 * 1024]; let manifest = super::tests::manifest(&bomb,false);
        assert!(verify(&forged(directory.path(),&manifest,&[("components/desktop-preferences/data.json",&bomb)]),None).is_err());
    }
    #[test]
    fn encrypted_chunks_authenticate_password_length_order_and_truncation() {
        let data = vec![42u8; CHUNK + 7]; let mut encoded = Vec::new();
        encode(&mut Cursor::new(&data),&mut encoded,data.len() as u64,Some("测试密码")).unwrap();
        let mut recovered = Vec::new(); assert!(decode(&mut Cursor::new(&encoded),&mut recovered,Some("测试密码")).unwrap()); assert_eq!(recovered,data);
        assert!(decode(&mut Cursor::new(&encoded),&mut Vec::new(),Some("wrong")).is_err());
        let mut corrupt = encoded.clone(); corrupt[60] ^= 1;
        assert!(decode(&mut Cursor::new(&corrupt),&mut Vec::new(),Some("测试密码")).is_err());
        assert!(decode(&mut Cursor::new(&encoded[..encoded.len()-1]),&mut Vec::new(),Some("测试密码")).is_err());
        let mut altered = encoded.clone(); altered[45] ^= 1;
        assert!(decode(&mut Cursor::new(&altered),&mut Vec::new(),Some("测试密码")).is_err());
        assert!(decode(&mut Cursor::new(&encoded),&mut Vec::new(),None).is_err());
        let mut expensive = encoded; expensive[33..37].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&mut Cursor::new(&expensive),&mut Vec::new(),Some("测试密码")).is_err());
    }
    #[test]
    fn failed_source_validation_never_publishes_a_final_file() {
        let directory = tempfile::tempdir().unwrap(); let manifest = manifest(b"data",false);
        let source = directory.path().join("changed.json"); std::fs::write(&source,b"oops").unwrap();
        assert!(write(directory.path(),&manifest,&[Source {path:manifest.components[0].files[0].path.clone(),file:source}],None).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(),1);
    }
}
