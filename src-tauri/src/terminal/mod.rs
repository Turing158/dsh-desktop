//! Native terminal service. Exact-origin ACL plus backend/window/document fencing.
mod protocol;
mod pty;
mod session;
use protocol::*;
use session::{Session, Attachment};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Instant};
use tauri::{AppHandle, Manager, WebviewWindow, ipc::Channel};

static NEXT: AtomicU64 = AtomicU64::new(1);
fn id() -> String { format!("term-{}", NEXT.fetch_add(1, Ordering::Relaxed)) }
#[derive(Default)]
struct Registry { sessions: HashMap<String, Arc<Session>>, identity: Option<Identity> }
impl Registry {
    fn bind(&mut self, identity: Option<Identity>) {
        self.identity = identity;
        for s in self.sessions.values() {
            let mut d = s.data.lock().unwrap();
            d.attachments.clear();
            d.controller = None;
        }
    }
}
#[derive(Default)]
pub struct TerminalManager(Mutex<Registry>);

fn current(window: &WebviewWindow) -> Result<Identity, String> {
    let url = window.url().map_err(|_| "terminal-origin")?;
    let shared = window.state::<crate::state::Shared>();
    let s = shared.lock().map_err(|_| "terminal-state")?;
    if window.label() != "main" || !allowed_origin(&url, &s.phase) { return Err("terminal-origin".into()); }
    if !s.ui.loaded || matches!(s.ui.phase, crate::ui_snapshot::UiPhase::Exiting | crate::ui_snapshot::UiPhase::Destroying | crate::ui_snapshot::UiPhase::Minimal) { return Err("terminal-stale".into()); }
    Ok(Identity { backend_instance: s.ui.backend_instance, window_generation: s.ui.window_generation, document_generation: s.ui.document_generation })
}
fn allowed_origin(url: &tauri::Url, phase: &crate::state::Phase) -> bool {
    let crate::state::Phase::Running { url: expected, .. } = phase else { return false; };
    expected.parse::<tauri::Url>().is_ok_and(|expected| url.scheme() == "http" && url.origin() == expected.origin())
}
fn validate(window: &WebviewWindow, identity: Identity) -> Result<(), String> {
    if current(window)? != identity { return Err("terminal-stale".into()); }
    let manager = window.state::<TerminalManager>();
    if manager.0.lock().unwrap().identity != Some(identity) { return Err("terminal-stale".into()); }
    Ok(())
}
pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|_| "terminal-origin")?;
    app.add_capability(serde_json::json!({ "identifier": format!("terminal-backend-{instance}"), "windows": ["main"], "local": false, "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] }, "permissions": ["allow-terminal"] }).to_string()).map_err(|_| "terminal-permission".into())
}
pub fn page_load(window: &WebviewWindow, started: bool) {
    let manager = window.state::<TerminalManager>();
    let identity = if started { None } else { current(window).ok() };
    manager.0.lock().unwrap().bind(identity);
    if let Some(identity) = identity { let _ = window.eval(&format!("window.__DSH_TERMINAL_IDENTITY__={};window.dispatchEvent(new Event('dsh-terminal-ready'));", serde_json::to_string(&identity).unwrap())); }
}
pub fn has_sessions(app: &AppHandle) -> bool { !app.state::<TerminalManager>().0.lock().unwrap().sessions.is_empty() }
/// DSH owns the web service, not the native shells. Retire the old document's
/// control and channels while preserving process trees and their output journals.
pub fn suspend(app: &AppHandle) {
    app.state::<TerminalManager>().0.lock().unwrap().bind(None);
}
pub fn shutdown(app: &AppHandle) {
    let sessions = { let manager = app.state::<TerminalManager>(); let mut m = manager.0.lock().unwrap(); m.identity = None; std::mem::take(&mut m.sessions) };
    for (_, s) in sessions { s.stop(); }
}
fn find(window: &WebviewWindow, identity: Identity, terminal_id: &str, run_id: u64) -> Result<Arc<Session>, String> {
    validate(window, identity)?;
    let manager = window.state::<TerminalManager>();
    let m = manager.0.lock().unwrap();
    if m.identity != Some(identity) { return Err("terminal-stale".into()); }
    let s = m.sessions.values().find(|s| s.info().terminal_id == terminal_id).cloned().ok_or("terminal-missing")?;
    if s.info().run_id != run_id { return Err("terminal-run-stale".into()); }
    Ok(s)
}
fn control(s: &Session, attachment: &str, epoch: u64, identity: Identity) -> Result<(), String> {
    let d = s.data.lock().unwrap();
    if d.controller != Some((attachment.into(), epoch)) || !d.attachments.get(attachment).is_some_and(|a| a.identity == identity) { return Err("terminal-control".into()); } Ok(())
}
#[tauri::command] pub async fn terminal_profiles(window: WebviewWindow, identity: Identity) -> Result<Vec<Profile>, String> { validate(&window, identity)?; Ok(profiles()) }
#[tauri::command] pub async fn terminal_list(window: WebviewWindow, identity: Identity) -> Result<Vec<Info>, String> { validate(&window, identity)?; Ok(window.state::<TerminalManager>().0.lock().unwrap().sessions.values().map(|s| s.info()).collect()) }
#[tauri::command]
pub async fn terminal_open(window: WebviewWindow, identity: Identity, resource_key: String, profile_id: Option<String>, cwd: Option<String>) -> Result<Info, String> {
    validate(&window, identity)?;
    if !resource(&resource_key) { return Err("terminal-resource".into()); }
    // Validate filesystem outside the global registry lock.
    let directory = tauri::async_runtime::spawn_blocking(move || directory(cwd)).await.map_err(|_| "terminal-worker")?;
    validate(&window, identity)?;
    let manager = window.state::<TerminalManager>(); let mut m = manager.0.lock().unwrap();
    if m.identity != Some(identity) { return Err("terminal-stale".into()); }
    if let Some(s) = m.sessions.get(&resource_key) { return Ok(s.info()); }
    if m.sessions.len() >= MAX_SESSIONS { return Err("terminal-session-limit".into()); }
    let directory = directory?;
    let available = profiles();
    let profile = available.iter().find(|p| profile_id.as_ref().map_or(true, |id| p.profile_id == *id)).ok_or("terminal-shell-missing")?.clone();
    let session = Session::new(id(), resource_key.clone(), 1, &profile, directory);
    let info = session.info(); m.sessions.insert(resource_key, session.clone()); drop(m);
    session.start(profile); Ok(info)
}
#[tauri::command]
pub async fn terminal_restart(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, profile_id: String, home: bool) -> Result<Info, String> {
    let old = find(&window, identity, &terminal_id, run_id)?;
    let profile = profiles().into_iter().find(|p| p.profile_id == profile_id).ok_or("terminal-shell-missing")?;
    let cwd = directory(if home { None } else { Some(old.info().cwd.to_string_lossy().into_owned()) })?;
    let stopping = old.clone();
    tauri::async_runtime::spawn_blocking(move || stopping.stop()).await.map_err(|_| "terminal-worker")?;
    validate(&window, identity)?;
    let manager = window.state::<TerminalManager>(); let mut m = manager.0.lock().unwrap();
    let key = old.info().resource_key;
    if m.identity != Some(identity) || !m.sessions.get(&key).is_some_and(|s| Arc::ptr_eq(s, &old)) { return Err("terminal-run-stale".into()); }
    let session = Session::new(terminal_id, key.clone(), run_id + 1, &profile, cwd);
    let info = session.info(); m.sessions.insert(key, session.clone()); drop(m); session.start(profile); Ok(info)
}
#[tauri::command]
pub async fn terminal_attach(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, view_id: String, channel: Channel<Message>) -> Result<String, String> {
    if view_id.is_empty() || view_id.len() > 160 { return Err("terminal-view".into()); }
    let s = find(&window, identity, &terminal_id, run_id)?;
    let attachment = id(); let mut d = s.data.lock().unwrap();
    d.attachments.retain(|_, a| a.view != view_id && a.touched.elapsed().as_secs() < 30);
    if d.attachments.len() >= 8 { return Err("terminal-view-limit".into()); }
    d.attachments.insert(attachment.clone(), Attachment { channel, identity, view: view_id, sent: 0, ack: 0, revision: 0, touched: Instant::now() });
    drop(d); s.pump(); Ok(attachment)
}
#[tauri::command]
pub async fn terminal_control(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, attachment_id: String) -> Result<u64, String> {
    let s = find(&window, identity, &terminal_id, run_id)?; let mut d = s.data.lock().unwrap();
    if !d.attachments.get(&attachment_id).is_some_and(|a| a.identity == identity && a.ack == d.journal.len() as u64) { return Err("terminal-syncing".into()); }
    d.epoch += 1; let epoch = d.epoch; d.controller = Some((attachment_id, epoch)); Ok(epoch)
}
#[tauri::command]
pub async fn terminal_write(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, attachment_id: String, epoch: u64, data: String) -> Result<(), String> {
    let s = find(&window, identity, &terminal_id, run_id)?; control(&s, &attachment_id, epoch, identity)?; s.write(data.into_bytes())
}
#[tauri::command]
pub async fn terminal_resize(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, attachment_id: String, epoch: u64, cols: u16, rows: u16) -> Result<(), String> {
    let s = find(&window, identity, &terminal_id, run_id)?; control(&s, &attachment_id, epoch, identity)?;
    tauri::async_runtime::spawn_blocking(move || s.resize(cols, rows)).await.map_err(|_| "terminal-worker")?
}
#[tauri::command]
pub async fn terminal_ack(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, attachment_id: String, seq: u64) -> Result<(), String> {
    let s = find(&window, identity, &terminal_id, run_id)?; let mut d = s.data.lock().unwrap();
    let a = d.attachments.get_mut(&attachment_id).ok_or("terminal-attachment")?;
    if a.identity != identity || seq < a.ack || seq > a.sent { return Err("terminal-sequence".into()); }
    a.ack = seq; a.touched = Instant::now(); drop(d); s.pump(); Ok(())
}
#[tauri::command]
pub async fn terminal_detach(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64, attachment_id: String) -> Result<(), String> {
    let s = find(&window, identity, &terminal_id, run_id)?; let mut d = s.data.lock().unwrap();
    d.attachments.remove(&attachment_id); if d.controller.as_ref().is_some_and(|a| a.0 == attachment_id) { d.controller = None; } Ok(())
}
#[tauri::command]
pub async fn terminal_close(window: WebviewWindow, identity: Identity, terminal_id: String, run_id: u64) -> Result<(), String> {
    validate(&window, identity)?;
    let session = { let manager = window.state::<TerminalManager>(); let mut m = manager.0.lock().unwrap();
        let key = m.sessions.iter().find(|(_, s)| s.info().terminal_id == terminal_id).map(|(k, _)| k.clone());
        let Some(key) = key else { return Ok(()); };
        if m.sessions[&key].info().run_id != run_id { return Err("terminal-run-stale".into()); }
        m.sessions.remove(&key).unwrap()
    };
    tauri::async_runtime::spawn_blocking(move || session.stop()).await.map_err(|_| "terminal-worker")?; Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn document_rebind_retains_sessions_and_output_but_revokes_old_control() {
        let profile = Profile { profile_id: "cmd".into(), name: "CMD".into(), path: "cmd.exe".into() };
        let session = Session::new("terminal".into(), "resource".into(), 1, &profile, "C:\\".into());
        let old = Identity { backend_instance: 1, window_generation: 1, document_generation: 1 };
        {
            let mut d = session.data.lock().unwrap();
            d.controller = Some(("old".into(), 7));
            d.attachments.insert("old".into(), Attachment { channel: Channel::new(|_| Ok(())), identity: old, view: "view".into(), sent: 1, ack: 1, revision: 1, touched: Instant::now() });
            d.journal.push(Record::Data { data: "b3V0cHV0".into() });
        }
        let mut registry = Registry::default();
        registry.sessions.insert("resource".into(), session.clone());
        registry.bind(None);
        assert_eq!(registry.identity, None);
        registry.bind(Some(Identity { backend_instance: 2, ..old }));
        assert!(Arc::ptr_eq(&registry.sessions["resource"], &session));
        assert!(!session.closed.load(Ordering::Acquire));
        let d = session.data.lock().unwrap();
        assert_eq!(d.journal.len(), 2);
        assert!(d.attachments.is_empty());
        assert!(d.controller.is_none());
        drop(d);
        assert!(control(&session, "old", 7, old).is_err());
    }
    #[test] fn execution_origin_excludes_boot_and_other_ports() {
        let phase = crate::state::Phase::Running { url: "http://127.0.0.1:1234/?token=private".into(), version: None };
        assert!(allowed_origin(&"http://127.0.0.1:1234/".parse().unwrap(), &phase));
        for url in ["http://tauri.localhost/", "tauri://localhost", "http://127.0.0.1:1235/", "http://localhost:1234/", "https://127.0.0.1:1234/"] { assert!(!allowed_origin(&url.parse().unwrap(), &phase)); }
    }
}
