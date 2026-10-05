use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_SESSIONS: usize = 16;
pub const MAX_INPUT: usize = 64 * 1024;
pub const MAX_JOURNAL: usize = 8 * 1024 * 1024;
pub const WINDOW: u64 = 16;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity { pub backend_instance: u64, pub window_generation: u64, pub document_generation: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile { pub profile_id: String, pub name: String, pub path: PathBuf }
pub fn profiles() -> Vec<Profile> {
    let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
    let pwsh = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|p| p.join("pwsh.exe")).find(|p| p.is_absolute() && p.is_file()))
        .or_else(|| std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("PowerShell/7/pwsh.exe")));
    [("pwsh", "PowerShell 7", pwsh), ("powershell", "Windows PowerShell", Some(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))), ("cmd", "CMD", Some(root.join("System32/cmd.exe")))]
        .into_iter().filter_map(|(id, name, path)| path.filter(|p| p.is_file()).map(|path| Profile { profile_id: id.into(), name: name.into(), path })).collect()
}
pub fn directory(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = match cwd { Some(value) => PathBuf::from(value), None => PathBuf::from(std::env::var_os("USERPROFILE").ok_or("terminal-directory")?) };
    if !path.is_absolute() || !path.is_dir() || std::fs::read_dir(&path).is_err() || path.as_os_str().to_string_lossy().contains('\0') { return Err("terminal-directory".into()); }
    Ok(path)
}
pub fn resource(key: &str) -> bool {
    key.strip_prefix("dsh-resource://desktop-terminal/").is_some_and(|id| !id.is_empty() && id.len() <= 200 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.%".contains(&b)))
}
pub fn size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) { Err("terminal-size".into()) } else { Ok(()) }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub terminal_id: String, pub resource_key: String, pub run_id: u64,
    pub profile_id: String, pub cwd: PathBuf, pub state: String, pub exit_code: Option<u32>,
    pub error: Option<String>, pub buffered_bytes: usize, pub paused: bool,
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Record { Data { data: String }, Resize { cols: u16, rows: u16 } }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub terminal_id: String, pub run_id: u64, pub attachment_id: String,
    pub seq: u64, #[serde(flatten)] pub body: Body,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Body { Data { record: Record }, State { info: Info }, Exit { info: Info } }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_stable_resource_addresses_and_sane_dimensions() {
        assert!(resource("dsh-resource://desktop-terminal/session%2Ftab-1"));
        for key in ["sidebar://desktop-terminal", "dsh-resource://desktop-terminal/", "dsh-resource://desktop-terminal/a?b"] { assert!(!resource(key)); }
        assert!(size(80, 24).is_ok()); assert!(size(0, 24).is_err()); assert!(size(80, 0).is_err()); assert!(size(501, 24).is_err());
    }
    #[test] fn bad_directory_never_falls_back_to_home() { assert!(directory(Some("relative".into())).is_err()); }
}
