//! Real Windows smoke test; no DSH profile or network/model calls.
#[path = "../src/winjob.rs"] mod winjob;
#[path = "../src/terminal/pty.rs"] mod pty;
use std::{io::{Read, Write}, path::PathBuf, sync::{Arc, mpsc}, time::{Duration, Instant}};
fn main() {
    let program = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe"));
    let cwd = std::env::temp_dir().join("dsh terminal 中文 smoke");
    std::fs::create_dir_all(&cwd).unwrap();
    let (pty, mut reader, mut writer) = pty::Pty::spawn(&program, "", &cwd, 100, 30).unwrap();
    let pty = Arc::new(pty);
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || { let mut bytes = [0u8; 8192]; while let Ok(n) = reader.read(&mut bytes) { if n == 0 { break; } let _ = tx.send(bytes[..n].to_vec()); } });
    let powershell = program.file_name().unwrap().to_string_lossy().to_ascii_lowercase() != "cmd.exe";
    let command = if powershell { "[Console]::WriteLine('PTY_' + '成功😀'); (Get-Location).Path; exit 7\r" } else { "echo PTY_OK & cd & exit /b 7\r" };
    std::thread::sleep(Duration::from_secs(2));
    writer.write_all(command.as_bytes()).unwrap();
    pty.resize(110, 32).unwrap();
    let start = Instant::now();
    let mut output = Vec::new();
    while start.elapsed() < Duration::from_secs(15) {
        if let Ok(data) = rx.recv_timeout(Duration::from_millis(50)) { output.extend(data); }
        if pty.exit_code().is_some() { break; }
    }
    let code = pty.exit_code();
    pty.finish(); drop(writer); worker.join().unwrap();
    for data in rx.try_iter() { output.extend(data); }
    let text = String::from_utf8_lossy(&output);
    assert_eq!(code, Some(7), "shell failed: {text}");
    assert!(text.contains(if powershell { "PTY_成功" } else { "PTY_OK" }), "missing output: {text}");
    assert!(text.contains("dsh terminal"), "cwd missing: {text}");
    println!("ConPTY OK: profile={}, bytes={}, exit=7, unicode cwd, resize, job before resume", program.file_name().unwrap().to_string_lossy(), output.len());
}
