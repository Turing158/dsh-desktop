use super::{protocol::*, pty::Pty};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, Ordering}, mpsc::{sync_channel, SyncSender}}, time::{Duration, Instant}};
use tauri::ipc::Channel;

pub struct Attachment {
    pub channel: Channel<Message>, pub identity: Identity, pub view: String,
    pub sent: u64, pub ack: u64, pub revision: u64, pub touched: Instant,
}
pub struct Data {
    pub info: Info, pub journal: Vec<Record>, pub bytes: usize, pub revision: u64,
    pub attachments: HashMap<String, Attachment>, pub controller: Option<(String, u64)>, pub epoch: u64,
}
pub struct Session {
    pub data: Mutex<Data>, pub wake: Condvar, pub closed: AtomicBool,
    pub native: Mutex<Option<Arc<Pty>>>, input: Mutex<Option<SyncSender<Vec<u8>>>>,
    finished: (Mutex<bool>, Condvar),
}
impl Session {
    pub fn new(id: String, key: String, run: u64, profile: &Profile, cwd: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self { data: Mutex::new(Data { info: Info { terminal_id: id, resource_key: key, run_id: run, profile_id: profile.profile_id.clone(), cwd, state: "starting".into(), exit_code: None, error: None, buffered_bytes: 0, paused: false }, journal: vec![Record::Resize { cols: 80, rows: 24 }], bytes: 32, revision: 1, attachments: HashMap::new(), controller: None, epoch: 0 }), wake: Condvar::new(), closed: AtomicBool::new(false), native: Mutex::new(None), input: Mutex::new(None), finished: (Mutex::new(false), Condvar::new()) })
    }
    pub fn info(&self) -> Info { let d = self.data.lock().unwrap(); let mut info = d.info.clone(); info.buffered_bytes = d.bytes; info }
    pub fn start(self: &Arc<Self>, profile: Profile) {
        let me = self.clone();
        std::thread::spawn(move || {
            let cwd = me.info().cwd;
            // Start and close serialize on native, never on the manager's map.
            let mut native = me.native.lock().unwrap();
            if me.closed.load(Ordering::Acquire) { me.finish_flag(); return; }
            let result = Pty::spawn(&profile.path, if profile.profile_id == "cmd" { "" } else { "-NoLogo" }, &cwd, 80, 24);
            let (pty, mut reader, mut writer) = match result {
                Ok(value) => value,
                Err(_) => { let mut d = me.data.lock().unwrap(); d.info.state = "failed".into(); d.info.error = Some("terminal-start".into()); d.revision += 1; drop(d); me.finish_flag(); return; }
            };
            let pty = Arc::new(pty); *native = Some(pty.clone());
            let (tx, rx) = sync_channel::<Vec<u8>>(8); *me.input.lock().unwrap() = Some(tx);
            drop(native);
            { let mut d = me.data.lock().unwrap(); d.info.state = "running".into(); d.revision += 1; }
            let write_me = me.clone();
            let writer_thread = std::thread::spawn(move || {
                while let Ok(data) = rx.recv() { if write_me.closed.load(Ordering::Acquire) { break; } if writer.write_all(&data).is_err() { break; } }
            });
            let read_me = me.clone();
            let reader_thread = std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    // Keep the exact stream from its beginning. Never replay an arbitrary tail.
                    // At the memory ceiling, block the PTY rather than dropping ANSI/UTF-8 bytes.
                    let mut d = read_me.data.lock().unwrap();
                    while d.bytes + 12000 > MAX_JOURNAL && !read_me.closed.load(Ordering::Acquire) {
                        if !d.info.paused { d.info.paused = true; d.revision += 1; }
                        d = read_me.wake.wait(d).unwrap();
                    }
                    drop(d);
                    let n = match reader.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(n) => n };
                    if read_me.closed.load(Ordering::Acquire) { continue; } // drain during ClosePseudoConsole
                    let mut d = read_me.data.lock().unwrap();
                    let data = STANDARD.encode(&buffer[..n]); d.bytes += data.len() + 32;
                    d.journal.push(Record::Data { data });
                }
            });
            loop {
                if let Some(code) = pty.exit_code() {
                    // End descendants even when the root shell exited normally.
                    me.input.lock().unwrap().take(); pty.finish();
                    let _ = reader_thread.join(); let _ = writer_thread.join();
                    me.closed.store(true, Ordering::Release);
                    let mut d = me.data.lock().unwrap(); d.info.state = "exited".into(); d.info.exit_code = Some(code); d.info.paused = false; d.revision += 1;
                    break;
                }
                if me.closed.load(Ordering::Acquire) { pty.terminate(); }
                std::thread::sleep(Duration::from_millis(25));
            }
            me.native.lock().unwrap().take(); me.finish_flag();
        });
        let me = self.clone();
        std::thread::spawn(move || loop {
            me.pump();
            if me.closed.load(Ordering::Acquire) && *me.finished.0.lock().unwrap() { me.pump(); break; }
            std::thread::sleep(Duration::from_millis(16));
        });
    }
    fn finish_flag(&self) { *self.finished.0.lock().unwrap() = true; self.finished.1.notify_all(); }
    pub fn stop(&self) {
        self.closed.store(true, Ordering::Release); self.wake.notify_all(); self.input.lock().unwrap().take();
        if let Some(pty) = self.native.lock().unwrap().as_ref() { pty.terminate(); }
        let _ = self.finished.1.wait_timeout_while(self.finished.0.lock().unwrap(), Duration::from_secs(3), |done| !*done);
    }
    pub fn write(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_INPUT { return Err("terminal-input-limit".into()); }
        self.input.lock().unwrap().as_ref().ok_or("terminal-exited")?.try_send(bytes).map_err(|_| "terminal-input-busy".into())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        size(cols, rows)?;
        let native = self.native.lock().unwrap().clone().ok_or("terminal-exited")?;
        let mut d = self.data.lock().unwrap();
        if d.bytes + 12000 > MAX_JOURNAL { return Err("terminal-buffer-full".into()); }
        native.resize(cols, rows).map_err(|_| "terminal-resize".to_string())?;
        d.bytes += 32; d.journal.push(Record::Resize { cols, rows }); Ok(())
    }
    pub fn pump(&self) {
        let mut d = self.data.lock().unwrap();
        let mut info = d.info.clone(); info.buffered_bytes = d.bytes;
        let revision = d.revision;
        let Data { journal, attachments, controller, .. } = &mut *d;
        attachments.retain(|id, a| {
            let message = |seq, body| Message { terminal_id: info.terminal_id.clone(), run_id: info.run_id, attachment_id: id.clone(), seq, body };
            let mut ok = a.touched.elapsed() < Duration::from_secs(30);
            while ok && a.sent < journal.len() as u64 && a.sent - a.ack < WINDOW {
                ok = a.channel.send(message(a.sent + 1, Body::Data { record: journal[a.sent as usize].clone() })).is_ok();
                if ok { a.sent += 1; }
            }
            if ok && a.revision != revision {
                let body = if info.state == "exited" { Body::Exit { info: info.clone() } } else { Body::State { info: info.clone() } };
                ok = a.channel.send(message(a.sent, body)).is_ok(); a.revision = revision;
            }
            if !ok && controller.as_ref().is_some_and(|c| c.0 == *id) { *controller = None; }
            ok
        });
    }
}
